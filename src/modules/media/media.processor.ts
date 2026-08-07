import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Readable } from 'stream';
import { PrismaService } from '../../database/prisma.service';
import { MinioClient } from '../../database/minio.client';
import { MediaIndexService } from './media-index.service';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from './embeddings/embedding-provider.interface';

/**
 * Worker de indexação do acervo: PENDING → INDEXING → READY | FAILED.
 *
 * Duas etapas independentes, e a primeira é pulável: se o asset JÁ tem
 * description (categorizado antes, ou corrigido à mão no PATCH), o Claude não
 * roda de novo — só o embedding. Retry de embedding fica ~100x mais barato.
 *
 * Concorrência 2: um lote de 200 fotos atravessa a fila sem estourar rate
 * limit do Claude nem monopolizar o worker do Redis.
 */
@Processor('media-index', { concurrency: 2 })
export class MediaProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioClient,
    private readonly indexer: MediaIndexService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {
    super();
  }

  async process(job: Job<{ assetId: string }>) {
    const { assetId } = job.data;
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.deletedAt) {
      this.logger.warn(`Asset ${assetId} inexistente/deletado — job ignorado`);
      return;
    }

    await this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: { indexStatus: 'INDEXING', indexError: null },
    });

    try {
      let description = asset.description;
      let subjects = asset.subjects;
      let themes = asset.themes;

      if (!description) {
        const buffer = await this.download(asset.key);
        const c = await this.indexer.categorize(
          buffer,
          asset.mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
        );
        description = c.description;
        subjects = c.subjects;
        themes = c.themes;
        await this.prisma.mediaAsset.update({
          where: { id: assetId },
          data: {
            description: c.description,
            subjects: c.subjects,
            themes: c.themes,
            setting: c.setting,
            people: c.people,
            mood: c.mood,
            colors: c.colors,
            usableAs: c.usable_as,
            hasText: c.has_text,
            qualityFlag: c.quality_flag,
          },
        });
      }

      const text = MediaIndexService.embeddingText({ description, subjects, themes });
      const [vector] = await this.embeddings.embedBatch([text], 'document');
      const literal = `[${vector.join(',')}]`;
      await this.prisma.$executeRaw`
        UPDATE media_assets SET embedding = ${literal}::vector WHERE id = ${assetId}
      `;

      await this.prisma.mediaAsset.update({
        where: { id: assetId },
        data: { indexStatus: 'READY', indexedAt: new Date() },
      });
      this.logger.log(`Asset ${assetId} indexado (${this.embeddings.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // status explícito SEMPRE — asset FAILED aparece na UI com o motivo;
      // falha silenciosa deixaria a foto "sumida" da busca sem explicação
      await this.prisma.mediaAsset.update({
        where: { id: assetId },
        data: { indexStatus: 'FAILED', indexError: message.slice(0, 500) },
      });
      this.logger.error(`Indexação do asset ${assetId} falhou: ${message}`);
      throw error; // re-throw: Bull aplica attempts/backoff configurados no enqueue
    }
  }

  private async download(key: string): Promise<Buffer> {
    const { body } = await this.minio.getObject(key);
    return streamToBuffer(body);
  }
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
