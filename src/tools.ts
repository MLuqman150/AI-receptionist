import { z } from "zod";
import { prisma } from "./db.js";
import { retrieveContext } from "./rag.js";
import type { ToolDef } from "./llm.js";

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "Look up company policies, services, pricing, or hours from the knowledge base",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Check open appointment slots for a given service and date",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["service", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book an appointment. Only call this after check_availability confirmed the exact slot with the customer.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          phone: { type: "string" },
          service: { type: "string" },
          startTime: { type: "string", description: "ISO 8601 datetime" },
        },
        required: ["customerName", "phone", "service", "startTime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description: "Hand off to a human when the request is out of scope, the customer is upset, or asks for a person",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_appointments",
      description: "Look up a customer's existing appointments by phone number. Always call this before rescheduling or cancelling, to get the appointmentId.",
      parameters: {
        type: "object",
        properties: { phone: { type: "string" } },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_appointment",
      description: "Reschedule or cancel an existing appointment. Requires the appointmentId from lookup_appointments. When rescheduling, call check_availability first to confirm the new slot is open.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "string" },
          action: { type: "string", enum: ["reschedule", "cancel"] },
          newStartTime: { type: "string", description: "ISO 8601 datetime — required when action is reschedule" },
        },
        required: ["appointmentId", "action"],
      },
    },
  },
];

// --- Argument validation ---------------------------------------------------
// Never trust arguments the model produced. Validate shape AND business rules
// (e.g. date parses, is in the future) before touching the database.

const availabilitySchema = z.object({
  service: z.string().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

const bookingSchema = z.object({
  customerName: z.string().min(1).max(120),
  phone: z.string().min(6).max(20),
  service: z.string().min(1).max(100),
  startTime: z.string().datetime({ message: "startTime must be ISO 8601" }),
});

const kbSchema = z.object({ query: z.string().min(1).max(500) });
const escalateSchema = z.object({ reason: z.string().min(1).max(300) });

const lookupSchema = z.object({ phone: z.string().min(6).max(20) });

const updateSchema = z
  .object({
    appointmentId: z.string().uuid("appointmentId must come from lookup_appointments"),
    action: z.enum(["reschedule", "cancel"]),
    newStartTime: z.string().datetime({ message: "newStartTime must be ISO 8601" }).optional(),
  })
  .refine((v) => v.action !== "reschedule" || !!v.newStartTime, {
    message: "newStartTime is required when action is reschedule",
  });

const SLOT_MINUTES = 30;

async function findOpenSlots(args: unknown) {
  const { service, date } = availabilitySchema.parse(args);

  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return { error: "Invalid date" };
  if (day.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
    return { error: "That date is in the past" };
  }

  const dayOfWeek = day.getUTCDay();
  const hours = await prisma.businessHours.findFirst({ where: { dayOfWeek } });
  if (!hours) return { available: [], note: "Closed that day" };

  const [openH, openM] = hours.openTime.split(":").map(Number);
  const [closeH, closeM] = hours.closeTime.split(":").map(Number);

  const dayStart = new Date(day);
  dayStart.setUTCHours(openH, openM, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setUTCHours(closeH, closeM, 0, 0);

  const booked = await prisma.appointment.findMany({
    where: { service, status: "confirmed", startTime: { gte: dayStart, lt: dayEnd } },
    select: { startTime: true },
  });
  const bookedTimes = new Set(booked.map((b: { startTime: Date }) => b.startTime.toISOString()));

  const slots: string[] = [];
  for (let t = new Date(dayStart); t < dayEnd; t = new Date(t.getTime() + SLOT_MINUTES * 60_000)) {
    if (!bookedTimes.has(t.toISOString())) slots.push(t.toISOString());
  }

  return { service, date, available: slots.slice(0, 12) }; // cap payload size
}

async function createAppointment(args: unknown) {
  const { customerName, phone, service, startTime } = bookingSchema.parse(args);

  const start = new Date(startTime);
  if (start.getTime() < Date.now()) return { error: "Cannot book a slot in the past" };

  // Re-check availability at write time to close the race window between
  // check_availability and book_appointment (two people booking the same slot).
  const conflict = await prisma.appointment.findFirst({
    where: { service, status: "confirmed", startTime: start },
  });
  if (conflict) return { error: "That slot was just taken — please pick another." };

  const customer = await prisma.customer.upsert({
    where: { phone },
    update: { name: customerName },
    create: { name: customerName, phone },
  });

  const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
  const appointment = await prisma.appointment.create({
    data: { customerId: customer.id, service, startTime: start, endTime: end },
  });

  return { confirmed: true, appointmentId: appointment.id, service, startTime: start.toISOString() };
}

async function lookupAppointments(args: unknown) {
  const { phone } = lookupSchema.parse(args);

  const customer = await prisma.customer.findUnique({ where: { phone } });
  if (!customer) return { found: false, note: "No customer found with that phone number." };

  const appointments = await prisma.appointment.findMany({
    where: { customerId: customer.id, status: "confirmed" },
    orderBy: { startTime: "asc" },
  });

  return {
    found: appointments.length > 0,
    appointments: appointments.map((a: { id: string; service: string; startTime: Date }) => ({
      appointmentId: a.id,
      service: a.service,
      startTime: a.startTime.toISOString(),
    })),
  };
}

async function updateAppointmentTool(args: unknown) {
  const parsed = updateSchema.parse(args);

  const appointment = await prisma.appointment.findUnique({ where: { id: parsed.appointmentId } });
  if (!appointment || appointment.status !== "confirmed") {
    return { error: "That appointment wasn't found (or is already cancelled). Run lookup_appointments again." };
  }

  if (parsed.action === "cancel") {
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: "cancelled" } });
    return { cancelled: true, appointmentId: appointment.id };
  }

  // Reschedule — re-validate the new slot server-side rather than trusting
  // that the model actually called check_availability first.
  const newStart = new Date(parsed.newStartTime!);
  if (newStart.getTime() < Date.now()) return { error: "Cannot reschedule to a time in the past" };

  const conflict = await prisma.appointment.findFirst({
    where: { service: appointment.service, status: "confirmed", startTime: newStart, NOT: { id: appointment.id } },
  });
  if (conflict) return { error: "That new slot is already taken — please pick another." };

  const newEnd = new Date(newStart.getTime() + SLOT_MINUTES * 60_000);
  const updated = await prisma.appointment.update({
    where: { id: appointment.id },
    data: { startTime: newStart, endTime: newEnd },
  });

  return { rescheduled: true, appointmentId: updated.id, newStartTime: updated.startTime.toISOString() };
}

async function escalate(args: unknown, conversationId: string) {
  const { reason } = escalateSchema.parse(args);
  await prisma.conversation.update({ where: { id: conversationId }, data: { status: "escalated" } });
  return { status: "escalated", reason };
}

async function searchKnowledgeBase(args: unknown) {
  const { query } = kbSchema.parse(args);
  const results = await retrieveContext(query);
  if (results.length === 0) {
    return { found: false, note: "No relevant information in the knowledge base for this query." };
  }
  return { found: true, results: results.map((r) => ({ content: r.content, similarity: r.similarity.toFixed(2) })) };
}

export async function executeTool(name: string, rawArgs: unknown, conversationId: string) {
  try {
    switch (name) {
      case "search_knowledge_base":
        return await searchKnowledgeBase(rawArgs);
      case "check_availability":
        return await findOpenSlots(rawArgs);
      case "book_appointment":
        return await createAppointment(rawArgs);
      case "lookup_appointments":
        return await lookupAppointments(rawArgs);
      case "update_appointment":
        return await updateAppointmentTool(rawArgs);
      case "escalate_to_human":
        return await escalate(rawArgs, conversationId);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    // Validation or DB errors never bubble up as stack traces — the model
    // just sees a short, safe error string and can react (retry, ask, escalate).
    const message = err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Internal error";
    console.error(`[tool:${name}] failed:`, err);
    return { error: message };
  }
}
