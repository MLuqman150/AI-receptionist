import { PrismaClient } from "@prisma/client";

// Single shared instance — avoids exhausting Postgres connections in dev with hot-reload
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
