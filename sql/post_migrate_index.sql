-- Run this once after `npm run prisma:migrate` has created the knowledge_chunks table.
-- ivfflat needs rows to exist to build good clusters, so run this AFTER seeding too,
-- or rebuild it later with: REINDEX INDEX knowledge_chunks_embedding_idx;

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
