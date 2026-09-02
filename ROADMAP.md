# Roadmap — go-live esse.rodolfo

Este arquivo é nosso. O que está em `docs/` é o registro histórico do projeto
original da Bravy e fica intocado: descreve publicações reais na conta
`@bravyschool` e credenciais do app Meta deles. Vale ler
`docs/status-e-plano-de-conclusao.md` §OAuth antes de mexer em Instagram — a
mecânica descrita lá continua correta, só os nomes não são nossos.

Estado em 2026-09-01: roda inteiro em local (Postgres+pgvector, Redis, MinIO,
API :3001, web :3000, login validado end-to-end). Nada em produção ainda.

## Bloqueio: app Meta próprio

**Sem isso não existe "conectar o Instagram", e nenhum outro item adianta.**
A API se recusa a subir em produção sem `META_APP_ID` e `META_APP_SECRET`
(`src/main.ts:27`).

O app Meta é a identidade do produto perante a Meta, não do usuário — um app
serve todos os tenants, e a separação de quem é o quê acontece no nosso banco,
via `SocialAccount.tenantId`. O app da Bravy (App ID `1197613524832305`) é
deles; não dá para reusar.

Só o dono da conta consegue fazer, no developers.facebook.com:

1. Criar app do tipo Business.
2. Adicionar os produtos **Facebook Login for Business** e **Instagram Graph
   API**.
3. Ter uma conta Instagram **Business ou Creator** vinculada a uma Página do
   Facebook. Conta pessoal não publica por API — é limite da Meta, não do
   código.
4. Cadastrar o redirect URI exato, em HTTPS. A Meta só aceita HTTP em
   `localhost`; qualquer outro host exige TLS.
5. Passar `META_APP_ID` e `META_APP_SECRET` por variável de ambiente, nunca
   por chat ou commit.

Permissões que o fluxo pede: `instagram_basic`, `instagram_content_publish`,
`pages_show_list`, `pages_read_engagement`. Em modo de desenvolvimento o app
já funciona para contas com papel no próprio app — dá para testar sem App
Review. App Review só é necessário para atender conta de terceiro.

## Bloqueios técnicos encontrados no recon de deploy

Verificados lendo o código, não presumidos:

- **Web não tem `Dockerfile`.** Só api e worker têm. Para Coolify, ou se
  escreve um (com `output: 'standalone'` no `next.config.ts`, que hoje não
  está lá), ou o front vai para a Vercel e só a API fica na VPS.
- **`HEALTHCHECK` do `Dockerfile.api` chama `curl`, que não existe na imagem.**
  O runtime instala só `openssl` e `ca-certificates`. O container sobe
  funcionando e é marcado `unhealthy` para sempre, o que trava dependência de
  ordem no Compose e confunde diagnóstico. Trocar por um `node -e` com `fetch`,
  ou instalar `curl`.
- **Postgres precisa de `pgvector`.** A migration `20260806200214_media_assets`
  faz `CREATE EXTENSION vector`. O Postgres padrão do Coolify não traz. Já
  corrigido no `docker-compose.yml` local (`pgvector/pgvector:pg16`); na VPS
  exige escolher a imagem certa ao criar o banco.
- **`PUBLIC_BASE_URL` tem de ser HTTPS público de verdade** — quem baixa o
  render é o servidor da Meta, não o navegador do usuário. Mas **o MinIO não
  precisa ser público**: com `PUBLIC_BASE_URL` preenchido, a URL entregue à
  Meta vira `<base>/api/v1/files/...` e quem serve o arquivo é a própria API
  (`src/database/minio.client.ts:30-33`, rota `GET /api/v1/files/*`). O bucket
  fica em rede interna. Só o *fallback*, quando a variável está vazia, aponta
  direto para o MinIO — e é esse caso que quebraria.
  Ou seja: `PUBLIC_BASE_URL` = a raiz pública da API, nada mais.

## Ordem sugerida

1. App Meta criado, com o redirect URI já apontando para o domínio definitivo.
2. DNS, dois registros, com TLS pelo Coolify:

   | host | serve |
   |---|---|
   | `publisher.esserodolfo.com.br` | front Next.js |
   | `publisher-api.esserodolfo.com.br` | API, OAuth e `/api/v1/files/*` |

   `api.esserodolfo.com.br` já é do omnihub-api, por isso o sufixo. Segue o
   mesmo padrão de `leads-lorena.esserodolfo.com.br`, que também é o segundo
   serviço de um projeto.

   Com isso, o redirect URI a cadastrar no app Meta é exatamente:

   ```
   https://publisher-api.esserodolfo.com.br/api/v1/oauth/instagram/callback
   ```

   A Meta compara string por string — barra a mais no fim já reprova. E
   `PUBLIC_BASE_URL` recebe `https://publisher-api.esserodolfo.com.br`, sem
   barra no fim e sem `/api/v1`, que o código acrescenta.
3. Postgres com pgvector + Redis + storage no Coolify.
4. `Dockerfile` do web, ou decisão de mandar o front para a Vercel.
5. Deploy da API e do worker, migrations aplicando no boot (o `CMD` já faz
   `prisma migrate deploy`).
6. Conectar o Instagram e publicar um carrossel de teste.

## Fora de escopo por enquanto

Chaves de IA (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) ficam
vazias até a geração de conteúdo entrar em uso. A API sobe sem elas; só as
rotas de geração e de embedding é que falham.
