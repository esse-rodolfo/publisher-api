import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { Prisma, MediaAsset } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MinioClient } from '../../database/minio.client';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from './embeddings/embedding-provider.interface';
import { Inject } from '@nestjs/common';

/** mimes aceitos = os que o Claude vision aceita como base64 (menos gif animado). */
const ACCEPTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB — acima disso a request da API de vision incha

/**
 * Piso de similaridade de cosseno na busca. text-embedding-3-small costuma dar
 * 0.3–0.6 entre textos relacionados; abaixo de 0.25 é ruído — melhor devolver
 * menos resultados do que resultados aleatórios (acervo pequeno pareia o
 * top-1 com QUALQUER consulta se não houver piso).
 */
const SIMILARITY_FLOOR = 0.25;

export interface MediaSearchHit {
  id: string;
  key: string;
  url: string;
  description: string | null;
  subjects: string[];
  themes: string[];
  usableAs: string[];
  hasText: boolean;
  similarity: number;
}

export interface UploadResult {
  id: string;
  filename: string;
  outcome: 'created' | 'duplicate' | 'revived';
}

/**
 * Acervo de imagens do tenant (banco de imagens com busca semântica).
 * Upload → fila `media-index` (Claude categoriza + embedding) → busca via
 * pgvector. `embedding` é coluna Unsupported: só $queryRaw/$executeRaw tocam
 * nela. Ver docs/plano-banco-de-imagens.md.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioClient,
    @InjectQueue('media-index') private readonly indexQueue: Queue,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  // ---------------- upload em lote ----------------

  async upload(files: Express.Multer.File[], tenantId: string): Promise<UploadResult[]> {
    if (!files?.length) throw new BadRequestException('Nenhum arquivo enviado (campo "files")');

    const results: UploadResult[] = [];
    for (const file of files) {
      if (!ACCEPTED_MIMES.has(file.mimetype)) {
        throw new BadRequestException(
          `${file.originalname}: tipo ${file.mimetype} não aceito (jpeg, png ou webp)`,
        );
      }
      if (file.size > MAX_FILE_BYTES) {
        throw new BadRequestException(
          `${file.originalname}: ${(file.size / 1024 / 1024).toFixed(1)}MB excede o limite de 15MB`,
        );
      }
      results.push(await this.uploadOne(file, tenantId));
    }
    return results;
  }

  private async uploadOne(file: Express.Multer.File, tenantId: string): Promise<UploadResult> {
    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    // dedupe pelo binário: mesmo arquivo → mesmo asset (ressuscita se deletado)
    const existing = await this.prisma.mediaAsset.findUnique({
      where: { tenantId_checksum: { tenantId, checksum } },
    });
    if (existing) {
      if (existing.deletedAt) {
        // objeto foi removido do MinIO no delete — regravar antes de reativar
        await this.minio.putBuffer(existing.key, file.buffer, file.mimetype);
        await this.prisma.mediaAsset.update({
          where: { id: existing.id },
          data: { deletedAt: null },
        });
        // índice antigo pode ter sido gerado — se não foi, reprocessa
        if (existing.indexStatus !== 'READY') await this.enqueue(existing.id);
        return { id: existing.id, filename: file.originalname, outcome: 'revived' };
      }
      return { id: existing.id, filename: file.originalname, outcome: 'duplicate' };
    }

    const safeName = file.originalname
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const key = `media/${tenantId}/${checksum.slice(0, 12)}-${safeName}`;
    await this.minio.putBuffer(key, file.buffer, file.mimetype);

    const dims = imageSize(file.buffer, file.mimetype);
    const asset = await this.prisma.mediaAsset.create({
      data: {
        tenantId,
        key,
        url: this.minio.publicUrl(key),
        mimeType: file.mimetype,
        width: dims?.width,
        height: dims?.height,
        sizeBytes: file.size,
        checksum,
        indexStatus: 'PENDING',
      },
    });
    await this.enqueue(asset.id);
    this.logger.log(`Asset ${asset.id} criado (${key}), indexação enfileirada`);
    return { id: asset.id, filename: file.originalname, outcome: 'created' };
  }

  private async enqueue(assetId: string): Promise<void> {
    await this.indexQueue.add(
      'index',
      { assetId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 500 },
    );
  }

  // ---------------- CRUD ----------------

  async list(tenantId: string, opts: { status?: string; q?: string } = {}): Promise<MediaAsset[]> {
    return this.prisma.mediaAsset.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(opts.status ? { indexStatus: opts.status } : {}),
        ...(opts.q
          ? {
              OR: [
                { description: { contains: opts.q, mode: 'insensitive' } },
                { subjects: { has: opts.q.toLowerCase() } },
                { themes: { has: opts.q.toLowerCase() } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async get(id: string, tenantId: string): Promise<MediaAsset> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!asset) throw new NotFoundException(`Asset ${id} não encontrado`);
    return asset;
  }

  /**
   * Edição manual do índice (corrigir descrição ruim da IA). Zera o embedding
   * e reenfileira — o processor vê description preenchida e SÓ re-embedda,
   * sem repetir o Claude.
   */
  async updateMeta(
    id: string,
    tenantId: string,
    data: { description?: string; subjects?: string[]; themes?: string[] },
  ): Promise<MediaAsset> {
    const asset = await this.get(id, tenantId);
    const updated = await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { ...data, indexStatus: 'PENDING', indexError: null },
    });
    await this.prisma.$executeRaw`UPDATE media_assets SET embedding = NULL WHERE id = ${asset.id}`;
    await this.enqueue(asset.id);
    return updated;
  }

  /** Reprocessa. `full` limpa a categorização para forçar o Claude de novo. */
  async reindex(id: string, tenantId: string, full: boolean): Promise<void> {
    const asset = await this.get(id, tenantId);
    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        indexStatus: 'PENDING',
        indexError: null,
        ...(full ? { description: null, subjects: [], themes: [] } : {}),
      },
    });
    await this.prisma.$executeRaw`UPDATE media_assets SET embedding = NULL WHERE id = ${asset.id}`;
    await this.enqueue(asset.id);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const asset = await this.get(id, tenantId);
    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { deletedAt: new Date() },
    });
    // best-effort: o soft delete é a verdade; objeto órfão não quebra nada
    await this.minio.removeObjects([asset.key]).catch((e) =>
      this.logger.warn(`Falha ao remover objeto ${asset.key}: ${e}`),
    );
  }

  // ---------------- busca semântica ----------------

  /**
   * Top-k por similaridade de cosseno. `forCopyOverlay` exclui fotos com texto
   * legível (competem com a copy do template) e com quality_flag ruim.
   */
  async search(
    tenantId: string,
    query: string,
    opts: { limit?: number; forCopyOverlay?: boolean } = {},
  ): Promise<MediaSearchHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 30);
    const [vector] = await this.embeddings.embedBatch([query], 'query');
    const literal = `[${vector.join(',')}]`;

    const overlayFilter = opts.forCopyOverlay
      ? Prisma.sql`AND has_text = false AND (quality_flag IS NULL OR quality_flag = 'ok')`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        key: string;
        url: string;
        description: string | null;
        subjects: string[];
        themes: string[];
        usable_as: string[];
        has_text: boolean;
        similarity: number;
      }>
    >`
      SELECT id, key, url, description, subjects, themes, usable_as, has_text,
             1 - (embedding <=> ${literal}::vector) AS similarity
      FROM media_assets
      WHERE tenant_id = ${tenantId}
        AND deleted_at IS NULL
        AND index_status = 'READY'
        AND embedding IS NOT NULL
        ${overlayFilter}
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${limit}
    `;

    return rows
      .filter((r) => r.similarity >= SIMILARITY_FLOOR)
      .map((r) => ({
        id: r.id,
        key: r.key,
        url: r.url,
        description: r.description,
        subjects: r.subjects,
        themes: r.themes,
        usableAs: r.usable_as,
        hasText: r.has_text,
        similarity: r.similarity,
      }));
  }

  /** Marca uso (escolha aplicada num post) — alimenta desempate e análise. */
  async markUsed(id: string): Promise<void> {
    await this.prisma.mediaAsset.update({
      where: { id },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
    });
  }
}

/** Dimensões de PNG (IHDR) e JPEG (scan de SOF). WebP fica sem — é só metadado de UI. */
export function imageSize(
  buf: Buffer,
  mime: string,
): { width: number; height: number } | undefined {
  if (mime === 'image/png') {
    if (buf.length < 24 || buf[0] !== 0x89 || buf.readUInt32BE(12) !== 0x49484452) return undefined;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg') {
    // varre marcadores até um SOFn (C0-CF, exceto C4/C8/CC que não carregam dimensão)
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) return undefined;
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return undefined;
}
