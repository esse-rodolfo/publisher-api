# Banco de Imagens com Busca Semântica — plano de implementação

Status: **implementado (backend completo + frontend), 2026-08-06.** Pendências
para ativação total:

1. **`OPENAI_API_KEY` no backend/.env** — sem ela, upload e categorização
   funcionam, mas o embedding falha com erro explícito (`FAILED` +
   `indexError`) e a busca devolve 422. Com a chave: `POST /media/:id/reindex`
   em cada asset FAILED re-embedda SEM repetir o Claude (categorização é
   preservada e pulada no retry).
2. **Prod**: a infra local é Postgres Homebrew 14 + pgvector via brew (SEM
   Docker nesta máquina — o plano original assumia compose). Em prod, o
   Postgres precisa da extensão pgvector disponível; a migration
   `20260806200214_media_assets` faz `CREATE EXTENSION IF NOT EXISTS vector`.

Validação runtime executada (2026-08-06, local): upload em lote ✓ · dedupe por
checksum ✓ · fila BullMQ com retry ✓ · categorização real pelo Claude ✓
(descrições específicas: "Close-up macro do headstock de uma guitarra...") ·
degrade explícito sem OPENAI_API_KEY ✓ · 422 na busca ✓ · isolamento de
tenant ✓ (tenant B vê lista vazia).

## O que é

Acervo de imagens **por tenant**, alimentado por upload em lote. Cada imagem é
descrita e categorizada por IA na entrada; na hora de criar conteúdo, outra IA
recupera a imagem certa para o assunto do slide.

Duas metades **independentes**, que entregam valor separadamente:

| Metade | Entrega | Depende da outra? |
|---|---|---|
| **A — Acervo** | subir fotos, indexar por IA, buscar e escolher à mão | não |
| **B — Auto-pick** | a geração escolhe sozinha a foto de cada slide | sim, precisa da A |

A metade A já é útil sozinha (substitui "procurar no Drive"). Recomendo fechar A
antes de abrir B — B sem acervo populado não tem o que recuperar.

## Decisões de arquitetura

### 1. Indexação: descrever com IA, buscar pela descrição

Não se busca "a imagem"; busca-se o **texto que a IA escreveu sobre ela**. Na
ingestão, Claude recebe a imagem e devolve um registro estruturado; esse texto
é embeddado e é ele que responde à busca.

Por que não embeddar a imagem direto (CLIP): exigiria um segundo modelo e uma
segunda infra vetorial, e a consulta aqui é **texto de slide** (assunto,
persona, padrão) — não uma imagem de referência. Descrição + embedding de texto
casa consulta e índice no mesmo espaço, e ainda deixa a descrição legível para
o JP auditar por que uma foto foi escolhida.

**Modelo:** `claude-opus-5` com structured output (`output_config.format`), que
garante o schema sem parsing frágil. O SDK `@anthropic-ai/sdk` já está no
backend. Imagem enviada como base64 a partir do buffer que já temos no upload —
assim o MinIO não precisa ser alcançável de fora.

> **Alavanca de custo, decisão do JP:** a ingestão é em lote e é o único ponto
> caro do plano. `claude-haiku-4-5` custa ~5× menos por imagem e provavelmente
> basta para descrever foto de banco. Deixo `claude-opus-5` como default e a
> troca como escolha explícita — ver Custos abaixo.

Schema de saída por imagem:

```jsonc
{
  "description": "string — 1-2 frases do que a foto mostra, concreta",
  "subjects":    ["string"],   // objetos/pessoas/cenário
  "themes":      ["string"],   // assuntos que a foto ilustra bem (fiscal, equipe, rotina...)
  "setting":     "escritorio | casa | rua | estudio | abstrato | outro",
  "people":      "nenhuma | uma | grupo",
  "mood":        "string",
  "colors":      ["string"],
  "usable_as":   ["figure", "background"],
  "has_text":    true,         // foto com texto legível some do pool (conflita com a copy)
  "quality_flag": "ok | ruido | baixa_resolucao | marca_dagua"
}
```

`description + subjects + themes` concatenados são o texto embeddado.
`has_text` e `quality_flag` viram filtro duro na recuperação — o template Twitter
já sofre com imagem que compete com o texto.

### 2. Busca: vetor recupera, LLM decide

Recuperação em duas etapas, e a ordem importa:

1. **pgvector** traz os top-k (k≈8) por similaridade de cosseno, com filtro de
   tenant e dos flags de qualidade. Determinístico e barato.
2. **Claude escolhe** entre os k candidatos, recebendo a copy do slide e as
   descrições — devolve `asset_id` + justificativa curta, ou `null` se nenhuma
   serve.

O passo 2 existe por um motivo específico: similaridade de cosseno alta não
significa que a foto *ilustra* o slide. O LLM só pode escolher **dentro** dos
candidatos, então não tem como alucinar um asset que não existe. E o `null`
importa tanto quanto a escolha — slide sem imagem boa é melhor que slide com
imagem errada, e o template Twitter já lida bem com ausência de imagem.

### 3. Stack vetorial: a que o RAG já decidiu

`docs/plano-3-features-rag-brandbook-analytics.md` já definiu, e **não vou abrir
uma segunda**: OpenAI `text-embedding-3-small` (1536 dims), coluna
`vector(1536)` via SQL cru (o Prisma não gerencia o tipo), índice HNSW
`vector_cosine_ops`, imagem do Postgres trocada para `pgvector/pgvector:pg16`,
provider atrás da interface `EmbeddingProvider` com token `EMBEDDING_PROVIDER`.

**Consequência de sequenciamento:** a infra pgvector é compartilhada com o RAG.
Quem chegar primeiro paga a migração da imagem do Postgres. Se o RAG for ficar
parado, este plano assume esse custo — está contabilizado na Fase 1.

## Schema

Novo model. Nenhum dos 13 models atuais serve — não existe nada de mídia hoje.

```prisma
model MediaAsset {
  id          String    @id @default(uuid())
  tenantId    String    @map("tenant_id")

  // objeto no MinIO
  key         String
  url         String
  mimeType    String    @map("mime_type")
  width       Int?
  height      Int?
  sizeBytes   Int       @map("size_bytes")
  // sha256 do binário — dedupe de re-upload do mesmo arquivo
  checksum    String

  // índice gerado por IA
  description String?   @db.Text
  subjects    String[]
  themes      String[]
  setting     String?
  people      String?
  mood        String?
  colors      String[]
  usableAs    String[]  @map("usable_as")
  hasText     Boolean   @default(false) @map("has_text")
  qualityFlag String?   @map("quality_flag")

  indexStatus String    @default("PENDING") @map("index_status") // PENDING|INDEXING|READY|FAILED
  indexError  String?   @map("index_error")
  indexedAt   DateTime? @map("indexed_at")

  // uso — alimenta desempate e futura análise
  timesUsed   Int       @default(0) @map("times_used")
  lastUsedAt  DateTime? @map("last_used_at")

  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  tenant      Tenant    @relation(fields: [tenantId], references: [id])

  @@unique([tenantId, checksum])
  @@index([tenantId, indexStatus])
  @@map("media_assets")
}
```

Migration em SQL cru, além do que o Prisma gera:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "media_assets" ADD COLUMN "embedding" vector(1536);
CREATE INDEX "media_assets_embedding_hnsw" ON "media_assets"
  USING hnsw ("embedding" vector_cosine_ops);
```

⚠️ **Armadilha de nome já existente no repo:** `Slide.imageUrl`/`imageKey` é o
**PNG exportado do slide inteiro**. A imagem-fonte vive em `bodyData.image`
(tipo `SlideImage`). `MediaAsset` é uma terceira coisa: o acervo. Três conceitos,
nomes parecidos — quem implementar precisa ler isto antes de escrever a primeira
linha.

Em `SlideImage` (scene-engine `doc.ts`): acrescentar
`source: 'ai' | 'bank' | 'upload'` e `assetId?: string`. **`doc.ts` é um dos
arquivos das 3 cópias do scene-engine** — exige sync triplo + rebuild.

## Fases

### Fase 1 — infra e schema (~1 dia)

- imagem `pgvector/pgvector:pg16` no compose (dev e prod)
- migration do `MediaAsset` + SQL cru do vetor/índice
- `EmbeddingProvider` + `openai.provider.ts` (compartilhado com o RAG; se o RAG
  já tiver criado, reusar sem duplicar)
- envs: `OPENAI_API_KEY`, `EMBEDDING_MODEL`
- módulo `media` no Nest (service, controller, processor)

### Fase 2 — ingestão (~2-3 dias)

- `POST /media/upload` — **multi-arquivo**, valida mime e tamanho, calcula
  checksum, grava objeto no MinIO com prefixo `media/{tenantId}/`, cria
  `MediaAsset` com `indexStatus=PENDING`. Re-upload do mesmo binário devolve o
  asset existente (`@@unique([tenantId, checksum])`) em vez de duplicar.
- **fila** (BullMQ, já usado no projeto) para indexar: o lote de 200 fotos não
  pode indexar no request. Concorrência baixa (2-3) para não estourar rate limit.
- worker: baixa o objeto → Claude vision com structured output → grava campos →
  embedda `description + subjects + themes` → `UPDATE ... SET embedding = $1::vector`
  → `indexStatus=READY`.
- falha marca `FAILED` + `indexError`, com reprocesso manual. **Não** deixar
  falha silenciosa: asset que não indexou é invisível para a busca, e sem
  status explícito o JP não descobre por que a foto "sumiu".
- `GET /media` (lista, filtro por status/tema), `DELETE /media/:id` (soft delete
  + remove objeto), `PATCH /media/:id` (corrigir descrição à mão → **re-embedda**).

### Fase 3 — recuperação (~2 dias)

- `POST /media/search { query, limit, filters }` → embedda a query, `$queryRaw`
  com `ORDER BY embedding <=> $1::vector LIMIT k`, piso de similaridade, filtro
  de tenant + `indexStatus='READY'` + `has_text=false` quando o uso for para
  template com copy por cima.
- `POST /media/pick { slideText, theme, persona }` → busca top-8 e passa a
  Claude para escolher. Devolve `{ assetId, reason } | null`.
- integração na geração: quando a política do post for `bank`, o
  `slide-image.service` chama `pick` por slide em vez de gerar imagem, e grava
  o mesmo `SlideImage` (com `source:'bank'`, `assetId`, `assetUrl`).
  **O template não muda** — ele já reserva a faixa quando `image.assetUrl` existe.

### Fase 4 — UI (~2-3 dias)

- rota `/media`: grid do acervo, upload em lote com progresso, badge de status
  de indexação, busca por texto, editar descrição, excluir.
- no wizard: a política de imagem entra no **step `template`** (ver o escopo das
  3 opções já levantado) — `Gerar com IA` / `Buscar no acervo` / `Eu envio`.
- no studio: `SlideImageButton` ganha "Buscar no acervo", com preview dos
  candidatos e a justificativa da escolha.

### Fase 5 — validação

- lote real de 30-50 fotos do JP, indexado ponta a ponta
- conferir as descrições geradas (é aqui que se descobre se o prompt de
  categorização está bom — e é barato corrigir antes de indexar 500)
- 10 buscas com assunto real de post; medir quantas trazem foto utilizável no top-3
- tenant B não enxerga asset do tenant A (teste explícito, não presumir)

## Plano de execução — ciclos

Cada ciclo é fechado: implementa, valida, commita, avança. Ordem obrigatória —
backend antes de frontend, schema → service → controller. Nenhum ciclo depende
de código de um ciclo posterior.

### Ciclo 0 — infra pgvector · ~2h

Sem isto nada mais roda. É o único ciclo que mexe em infra compartilhada.

- `docker-compose.yml` (dev e prod): `postgres:16-alpine` → `pgvector/pgvector:pg16`
- `.env.example`: `OPENAI_API_KEY`, `EMBEDDING_MODEL=text-embedding-3-small`
- **Validar:** `docker compose up` sobe; `\dx` no psql lista a extensão `vector`

> Coordenar com o RAG antes: os dois planos usam a mesma extensão. Quem migrar
> primeiro paga; o segundo não repete.

### Ciclo 1 — schema · ~2h

- `prisma/schema.prisma`: model `MediaAsset` (ver Schema acima) + relação em `Tenant`
- `npx prisma migrate dev --name media_assets`
- editar a migration gerada e acrescentar à mão:
  `CREATE EXTENSION IF NOT EXISTS vector;`, `ALTER TABLE ... ADD COLUMN embedding vector(1536);`,
  o índice HNSW
- **Validar:** migration aplica limpa; `\d media_assets` mostra a coluna `embedding`

### Ciclo 2 — upload em lote · ~4h

Primeiro entregável visível: dá pra subir foto e ver na base.

- `src/modules/media/media.module.ts`
- `src/modules/media/media.service.ts` — `upload()` (checksum sha256, dedupe por
  `@@unique([tenantId, checksum])`, `minio.putBuffer` com prefixo
  `media/{tenantId}/`), `list()`, `remove()` (soft delete + `minio.removeObjects`)
- `src/modules/media/media.controller.ts` — `POST /media/upload` (`FilesInterceptor`,
  multi-arquivo), `GET /media`, `DELETE /media/:id`
- `src/modules/media/dto/upload-media.dto.ts`
- registrar em `app.module.ts`
- **Validar:** subir 5 fotos via curl → 5 linhas com `indexStatus=PENDING`;
  subir a mesma foto 2× → continua 5 linhas

### Ciclo 3 — indexação por IA · ~6h

O coração da feature. Segue o padrão de fila do `publishing.processor.ts`.

- `src/modules/media/media-index.service.ts` — chama `claude-opus-5` com a imagem
  em base64 (`minio.getObject` → buffer) e `output_config.format` com o schema
  de categorização; grava os campos
- `src/modules/media/media.processor.ts` — worker BullMQ, concorrência 2-3;
  `PENDING → INDEXING → READY|FAILED`, grava `indexError` na falha
- `media.service.upload()` enfileira após criar o asset
- `PATCH /media/:id` — corrigir descrição à mão (marca para reindexar)
- **Validar:** subir 10 fotos variadas → todas `READY`; **ler as 10 descrições**.
  É aqui que se descobre se o prompt está bom — corrigir agora, não depois de 500.

### Ciclo 4 — embedding e busca · ~5h

- `src/modules/media/embeddings/embedding-provider.interface.ts` + `openai.provider.ts`
  (se o RAG já criou, **importar, não duplicar**)
- no processor: após categorizar, embeddar `description + subjects + themes` e
  gravar via `$executeRaw` (`'[v1,...]'::vector`)
- `media.service.search()` — `$queryRaw` com `ORDER BY embedding <=> $1::vector`,
  filtro de `tenant_id`, `index_status='READY'`, piso de similaridade
- `POST /media/search`
- **Validar:** buscar "contador analisando planilha" traz foto coerente no top-3;
  tenant B não vê asset do tenant A (teste explícito)

### Ciclo 5 — escolha por IA · ~3h

- `media.service.pick({ slideText, theme, persona })` — top-8 da busca → Claude
  escolhe → `{ assetId, reason } | null`
- `POST /media/pick`
- **Validar:** com acervo de 10 fotos, pedir imagem para assunto que **não tem**
  foto boa → precisa devolver `null`, não o menos ruim

### Ciclo 6 — integração na geração · ~4h

- `SlideImage` em `doc.ts`: `source: 'ai'|'bank'|'upload'`, `assetId?`
  → **sync nas 3 cópias do scene-engine + rebuild nas 3**
- `slide-image.service.ts`: quando a política for `bank`, chamar `pick` em vez
  de gerar; gravar o mesmo `SlideImage` com `assetUrl`
- `GenerateDto`: campo `imagePolicy`
- **Validar:** gerar carrossel Twitter com política `bank` → slides com imagem do
  acervo, faixa reservada pelo template. O template **não muda** nesta feature.

### Ciclo 7 — frontend · ~2-3 dias

- rota `/media`: grid, upload em lote com progresso, badge de status, busca,
  editar descrição, excluir
- wizard step `template`: escolha da política (`IA` / `Acervo` / `Upload`)
- studio: `SlideImageButton` ganha "Buscar no acervo" com preview dos candidatos
- **Validar:** fluxo ponta a ponta sem tocar em curl

## Custos

| Item | Ordem de grandeza |
|---|---|
| Indexação, `claude-opus-5` | ~US$ 0,03 por imagem → **~US$ 30 por 1.000 fotos** |
| Indexação, `claude-haiku-4-5` | ~5× menos → **~US$ 6 por 1.000 fotos** |
| Embeddings (`text-embedding-3-small`) | desprezível (centavos por milhar) |
| Busca (embedding da query + escolha) | ~US$ 0,002 por slide |
| Storage MinIO | o que já se paga |

Custo é **de ingestão, uma vez por foto** — não recorre por post. O acervo é
ativo: quanto mais posts, mais diluído.

## Riscos

1. **Descrição genérica = busca ruim.** É o risco central: se a IA descrever
   toda foto como "pessoa trabalhando em escritório", tudo casa com tudo e a
   busca vira sorteio. Mitigação: prompt exige especificidade concreta, e a
   Fase 5 revisa as descrições antes do lote grande.
2. **Acervo pequeno.** Com 20 fotos, quase todo slide recebe a mesma. O passo de
   escolha precisa poder devolver `null`, e o limiar de similaridade precisa ser
   respeitado em vez de sempre pegar o top-1.
3. **pgvector é infra compartilhada** com o RAG — coordenar para não migrar o
   Postgres duas vezes.
4. **Direitos de imagem.** O acervo é do tenant e o sistema não valida licença.
   Fora de escopo técnico, mas precisa estar dito.

## Fora de escopo

Acervo externo (Unsplash/Pexels), edição/crop de imagem no sistema, detecção de
rosto, vídeo, acervo compartilhado entre tenants.
