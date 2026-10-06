const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

let conversationId = localStorage.getItem("receptionist_conversation_id");
let shownEscalationNotice = false;
let renderedMessageCount = 0; // how many messages from /messages we've already drawn
let pollTimer = null;

function addMessage(text, role) {
  const el = document.createElement("div");
  el.className = "msg " + (role === "agent" ? "assistant" : role);
  if (role === "agent") text = "🧑‍💼 " + text; // visually distinguish a human reply from the bot
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function addSystemNotice(text) {
  const el = document.createElement("div");
  el.className = "escalated";
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

async function ensureConversation() {
  if (conversationId) return;
  const res = await fetch("/api/conversation", { method: "POST" });
  const data = await res.json();
  conversationId = data.conversationId;
  localStorage.setItem("receptionist_conversation_id", conversationId);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/chat/${conversationId}/messages`);
      if (!res.ok) return;
      const data = await res.json();
      const newOnes = data.messages.slice(renderedMessageCount);
      for (const m of newOnes) {
        if (m.role === "agent") addMessage(m.content, "agent");
      }
      renderedMessageCount = data.messages.length;
    } catch {
      // transient network hiccup — just try again on the next tick
    }
  }, 3000);
}

function handleEscalationState(humanHandling) {
  if (shownEscalationNotice) return;
  shownEscalationNotice = true;
  addSystemNotice(
    humanHandling
      ? "You're now connected with a team member."
      : "This has been passed to a team member — they'll be with you shortly."
  );
  startPolling();
}

// form.addEventListener("submit", async (e) => {
//   e.preventDefault();
//   const text = input.value.trim();
//   if (!text) return;

//   addMessage(text, "user");
//   renderedMessageCount++; // account for the message we just optimistically rendered
//   input.value = "";
//   sendBtn.disabled = true;

//   try {
//     await ensureConversation();
//     const res = await fetch("/api/chat", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ conversationId, message: text }),
//     });
//     const data = await res.json();

//     if (data.reply) {
//       addMessage(data.reply, "assistant");
//       renderedMessageCount++;
//     }
//     if (data.escalated) handleEscalationState(data.humanHandling);
//   } catch (err) {
//     addMessage("Network error — please try again.", "assistant");
//   } finally {
//     sendBtn.disabled = false;
//     input.focus();
//   }
// });

async function sendMessage(text) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message: text }),
  });

  if (res.status === 404) {
    // Our conversationId is stale — usually because the DB was reset (new
    // project checkout, `docker compose down -v`, etc.) while the browser
    // still remembers an old id in localStorage. Self-heal: start a fresh
    // conversation and retry once, transparently.
    localStorage.removeItem("receptionist_conversation_id");
    conversationId = null;
    renderedMessageCount = 0;
    await ensureConversation();
    return fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, message: text }),
    });
  }

  return res;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  renderedMessageCount++; // account for the message we just optimistically rendered
  input.value = "";
  sendBtn.disabled = true;

  try {
    await ensureConversation();
    const res = await sendMessage(text);
    const data = await res.json();

    if (data.reply) {
      addMessage(data.reply, "assistant");
      renderedMessageCount++;
    }
    if (data.escalated) handleEscalationState(data.humanHandling);
  } catch (err) {
    addMessage("Network error — please try again.", "assistant");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

addMessage(
  "Hi! I'm the Acme Dental front desk assistant. How can I help — hours, pricing, or booking an appointment?",
  "assistant"
);
