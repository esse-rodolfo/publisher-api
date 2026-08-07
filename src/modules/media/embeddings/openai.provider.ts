import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingProvider } from './embedding-provider.interface';

/**
 * Embeddings via OpenAI REST (fetch nativo, sem SDK — mesma decisão do plano
 * de RAG). Modelo default `text-embedding-3-small` (1536 dims), sobrescrevível
 * por EMBEDDING_MODEL. Sem OPENAI_API_KEY degrada com 422 explícito — nunca
 * silenciosamente (asset sem embedding é invisível para a busca).
 */
@Injectable()
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(OpenAIEmbeddingProvider.name);
  readonly dimensions = 1536;

  constructor(private readonly config: ConfigService) {}

  get id(): string {
    return `openai/${this.model}`;
  }

  private get model(): string {
    return this.config.get<string>('EMBEDDING_MODEL') ?? 'text-embedding-3-small';
  }

  hasProvider(): boolean {
    return Boolean(this.config.get<string>('OPENAI_API_KEY'));
  }

  async embedBatch(texts: string[], _kind: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new UnprocessableEntityException(
        'Embeddings não configurados (defina OPENAI_API_KEY no backend)',
      );
    }

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    if (!json.data?.length || json.data.length !== texts.length) {
      throw new Error(`OpenAI embeddings: esperava ${texts.length} vetores, veio ${json.data?.length ?? 0}`);
    }

    // a API documenta ordem por index — ordenar explicitamente é barato e à prova de regressão
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (const d of sorted) {
      if (d.embedding.length !== this.dimensions) {
        throw new Error(
          `Embedding com ${d.embedding.length} dims (coluna é vector(${this.dimensions})) — modelo errado em EMBEDDING_MODEL?`,
        );
      }
    }
    return sorted.map((d) => d.embedding);
  }
}
