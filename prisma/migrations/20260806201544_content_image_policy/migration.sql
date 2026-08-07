-- DropIndex
DROP INDEX "media_assets_embedding_hnsw";

-- AlterTable
ALTER TABLE "contents" ADD COLUMN     "image_policy" TEXT;
