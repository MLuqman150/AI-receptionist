import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { prisma } from "./db.js";
import { handleTurn } from "./orchestrator.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(",");

app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "10kb" })); // small cap — this is a chat endpoint, not a file upload
app.use(express.static("public"));

// Basic abuse protection for a public-facing demo. Tune per-IP limits down
// further (or add per-conversation limits) before any real client exposure.
// Two tiers: polling (conversation list, message list, thread refresh) is
// cheap and frequent by design, so it gets a generous shared budget. The
// actual LLM call is what costs money/quota and is worth protecting more
// tightly — that one gets its own, stricter limiter below.
app.use(
  "/api/",
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests — please slow down." },
  })
);

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages — please wait a moment before sending another." },
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// --- Customer-facing chat ---------------------------------------------------

app.post("/api/conversation", async (_req, res) => {
  const conversation = await prisma.conversation.create({ data: { channel: "web" } });
  res.json({ conversationId: conversation.id });
});

app.post("/api/chat", chatLimiter, async (req, res) => {
  const { conversationId, message } = req.body ?? {};

  if (typeof conversationId !== "string" || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "conversationId and message are required" });
  }

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) {
    return res.status(404).json({ error: "Unknown conversation. Start a new one via /api/conversation." });
  }

  try {
    const reply = await handleTurn(conversationId, message);
    // Re-fetch: handleTurn (via the escalate_to_human tool) may have just changed the status.
    const updated = await prisma.conversation.findUnique({ where: { id: conversationId } });
    const humanHandling = updated?.status === "human";
    res.json({ reply, escalated: updated?.status === "escalated" || humanHandling, humanHandling });
  } catch (err) {
    // handleTurn already catches provider failures internally; this is a last
    // resort for anything unexpected (e.g. DB down) so the client never sees a bare 500.
    console.error("[server] unexpected error:", err);
    res.status(200).json({
      reply: "Sorry, something went wrong on my end. A team member will follow up with you shortly.",
      escalated: true,
    });
  }
});

// Polled by the widget once a conversation is escalated/human-handled, so it
// can pick up replies a staff member sends from the dashboard. Deliberately
// excludes "tool" messages — those are internal, not customer-facing.
app.get("/api/chat/:conversationId/messages", async (req, res) => {
  const { conversationId } = req.params;
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return res.status(404).json({ error: "Unknown conversation" });

  const messages = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "assistant", "agent"] } },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  });

  res.json({ status: conversation.status, messages });
});

// --- Human-agent dashboard ---------------------------------------------------
// Minimal shared-secret protection: the dashboard page prompts the staff
// member for this key once and sends it back on every request. This is
// intentionally lightweight for a demo — swap for real auth (SSO, per-agent
// login) before any real staff or customer data goes through this.

function requireDashboardKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const configured = process.env.DASHBOARD_KEY;
  if (!configured) {
    return res.status(503).json({ error: "Dashboard is not configured — set DASHBOARD_KEY in .env" });
  }
  if (req.header("x-dashboard-key") !== configured) {
    return res.status(401).json({ error: "Invalid dashboard key" });
  }
  next();
}

app.use("/api/dashboard", requireDashboardKey);

// List conversations waiting for or currently held by a human, newest first.
app.get("/api/dashboard/conversations", async (_req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: { status: { in: ["escalated", "human"] } },
    orderBy: { createdAt: "desc" },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  res.json(
    conversations.map((c: (typeof conversations)[number]) => ({
      id: c.id,
      status: c.status,
      createdAt: c.createdAt,
      lastMessage: c.messages[0]?.content ?? "",
    }))
  );
});

// Full transcript for one conversation, including tool calls — useful for
// staff to see *why* the bot escalated, not just the customer-visible text.
app.get("/api/dashboard/conversations/:id", async (req, res) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) return res.status(404).json({ error: "Unknown conversation" });
  res.json(conversation);
});

app.post("/api/dashboard/conversations/:id/pickup", async (req, res) => {
  const conversation = await prisma.conversation
    .update({ where: { id: req.params.id }, data: { status: "human" } })
    .catch(() => null);
  if (!conversation) return res.status(404).json({ error: "Unknown conversation" });
  res.json({ status: conversation.status });
});

app.post("/api/dashboard/conversations/:id/reply", async (req, res) => {
  const { message } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: "Unknown conversation" });

  // Auto-pickup if a staff member replies without explicitly hitting "Pick up" first.
  if (conversation.status !== "human") {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "human" } });
  }

  await prisma.message.create({
    data: { conversationId: conversation.id, role: "agent", content: message.trim() },
  });

  res.json({ ok: true });
});

app.post("/api/dashboard/conversations/:id/resolve", async (req, res) => {
  const conversation = await prisma.conversation
    .update({ where: { id: req.params.id }, data: { status: "closed" } })
    .catch(() => null);
  if (!conversation) return res.status(404).json({ error: "Unknown conversation" });
  res.json({ status: conversation.status });
});

app.get("/api/dashboard/appointments", async (_req, res) => {
  const appointments = await prisma.appointment.findMany({
    orderBy: { startTime: "asc" },
    include: { customer: true },
  });

  res.json(
    appointments.map((a: (typeof appointments)[number]) => ({
      id: a.id,
      service: a.service,
      startTime: a.startTime,
      endTime: a.endTime,
      status: a.status,
      customerName: a.customer?.name ?? "—",
      customerPhone: a.customer?.phone ?? "—",
    }))
  );
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`AI receptionist listening on http://localhost:${PORT}`);
});
