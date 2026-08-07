import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaIndexService } from './media-index.service';
import { MediaPickService } from './media-pick.service';
import { MediaProcessor } from './media.processor';
import { EMBEDDING_PROVIDER } from './embeddings/embedding-provider.interface';
import { OpenAIEmbeddingProvider } from './embeddings/openai.provider';

/**
 * Acervo de imagens com busca semântica (docs/plano-banco-de-imagens.md).
 * O provider de embeddings fica atrás do token EMBEDDING_PROVIDER — mesma
 * interface que o plano de RAG especifica; trocar de provedor é trocar o
 * useClass aqui, sem tocar em service/processor.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'media-index' })],
  controllers: [MediaController],
  providers: [
    MediaService,
    MediaIndexService,
    MediaPickService,
    MediaProcessor,
    { provide: EMBEDDING_PROVIDER, useClass: OpenAIEmbeddingProvider },
  ],
  exports: [MediaService, MediaPickService],
})
export class MediaModule {}
