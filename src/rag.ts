import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { embedText, EMBEDDING_DIM } from "./embeddings.js";

export function chunkText(text: string, maxChars = 500): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n" + para).length > maxChars && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n${para}` : para;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

// Numbers-only literal — never interpolate raw user/LLM text into SQL this way.
function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIM || embedding.some((n) => !Number.isFinite(n))) {
    throw new Error("Invalid embedding vector");
  }
  return `[${embedding.join(",")}]`;
}

export async function ingestDocument(source: string, content: string) {
  const chunks = chunkText(content);
  for (const chunk of chunks) {
    const embedding = await embedText(chunk);
    const literal = toVectorLiteral(embedding);
    await prisma.$executeRaw`
      INSERT INTO knowledge_chunks (id, source, content, embedding, "createdAt")
      VALUES (gen_random_uuid(), ${source}, ${chunk}, ${Prisma.raw(`'${literal}'::vector`)}, now())
    `;
  }
  return chunks.length;
}

export interface RetrievedChunk {
  content: string;
  source: string;
  similarity: number;
}

const MIN_SIMILARITY = 0.35; // below this, treat as "nothing relevant found" rather than guessing

export async function retrieveContext(query: string, topK = 4): Promise<RetrievedChunk[]> {
  const embedding = await embedText(query);
  const literal = toVectorLiteral(embedding);

  const rows = await prisma.$queryRaw<RetrievedChunk[]>`
    SELECT content, source, 1 - (embedding <=> ${Prisma.raw(`'${literal}'::vector`)}) AS similarity
    FROM knowledge_chunks
    ORDER BY embedding <=> ${Prisma.raw(`'${literal}'::vector`)}
    LIMIT ${topK}
  `;

  return rows.filter((r: RetrievedChunk) => r.similarity >= MIN_SIMILARITY);
}
