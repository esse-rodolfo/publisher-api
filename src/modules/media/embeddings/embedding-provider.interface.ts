/**
 * Provider de embeddings atrás de interface plugável.
 *
 * Assinatura COMPARTILHADA com o plano de RAG (docs/plano-3-features-rag-
 * brandbook-analytics.md) — quando a knowledge base for implementada, ela
 * importa daqui em vez de duplicar. `kind` diferencia documento de consulta
 * para provedores que otimizam cada lado (text-embedding-3-small ignora).
 */
export interface EmbeddingProvider {
  /** identificador do provedor+modelo, gravável em logs/telemetria. */
  readonly id: string;
  /** dimensão dos vetores — precisa casar com a coluna vector(N) do banco. */
  readonly dimensions: number;
  embedBatch(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
