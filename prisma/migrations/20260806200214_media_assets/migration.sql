-- pgvector: extensão para a coluna embedding + busca por similaridade (<=>).
-- Infra COMPARTILHADA com a feature de RAG (knowledge base) — se o RAG migrar
-- primeiro, este CREATE é um no-op inofensivo.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "size_bytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "description" TEXT,
    "subjects" TEXT[],
    "themes" TEXT[],
    "setting" TEXT,
    "people" TEXT,
    "mood" TEXT,
    "colors" TEXT[],
    "usable_as" TEXT[],
    "has_text" BOOLEAN NOT NULL DEFAULT false,
    "quality_flag" TEXT,
    "embedding" vector(1536),
    "index_status" TEXT NOT NULL DEFAULT 'PENDING',
    "index_error" TEXT,
    "indexed_at" TIMESTAMP(3),
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_assets_tenant_id_index_status_idx" ON "media_assets"("tenant_id", "index_status");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_tenant_id_checksum_key" ON "media_assets"("tenant_id", "checksum");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Índice HNSW para busca por cosseno. Escrito à mão: o Prisma não gerencia
-- índices em colunas Unsupported. m/ef_construction nos defaults do pgvector.
CREATE INDEX "media_assets_embedding_hnsw" ON "media_assets"
  USING hnsw ("embedding" vector_cosine_ops);
