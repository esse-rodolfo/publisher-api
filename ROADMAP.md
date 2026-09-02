# Roadmap — go-live esse.rodolfo

Estado em 2026-09-01: roda inteiro em local (Postgres com pgvector, Redis,
MinIO, API :3001, web :3000, login validado end-to-end). Nada em produção.

## Bloqueio: app Meta próprio

**Sem isso não existe "conectar o Instagram", e nenhum outro item adianta.**
A API se recusa a subir em produção sem `META_APP_ID` e `META_APP_SECRET`
(`src/main.ts:27`).

### Um app atende todos os tenants

É o modelo de qualquer SaaS que publica em rede social — Buffer, Hootsuite,
Later e Metricool usam **um** app Meta para milhares de clientes. O modelo
mental que evita erro:

- **App Meta** = identidade pública do *produto* perante a Meta. `App ID` e
  `App Secret` são credenciais nossas, não do usuário.
- **Token OAuth** = credencial de *um usuário específico* autorizando o app a
  publicar na conta Instagram dele.
- **Multi-tenancy acontece no nosso banco**, não na Meta. `SocialAccount.tenantId`
  separa qual token é de qual cliente
  (`src/modules/publishing/publishing.service.ts:38-61`).

`META_APP_ID` e `META_APP_SECRET` ficam fixos no ambiente do servidor, nunca
por tenant.

Um app deixa de bastar em dois casos, nenhum deles nosso hoje: white-label
profundo, quando o cliente quer que o popup diga o nome *dele* e não o nosso; e
limite de rate por app, que só aperta com dezenas de milhares de tenants
publicando junto.

### Development mode resolve o seu teste

O app nasce em **Development mode**, e nesse modo só quem tem papel em
**Roles → Roles** (Admin, Developer ou Tester) consegue autorizar. Para testar
o *seu* Instagram isso basta, e é liberado em segundos.

**Live mode** — qualquer cliente externo conseguindo conectar — exige **App
Review** da Meta: formulário, screencast do fluxo e justificativa de cada
permissão. Costuma levar de 5 a 15 dias, e vale para sempre depois de
aprovado. Só abrir quando existir cliente externo de verdade.

### Setup, lado Meta

Em [developers.facebook.com/apps](https://developers.facebook.com/apps):

1. Criar app do tipo **Business**.
2. Adicionar os produtos **Facebook Login for Business** e **Instagram Graph
   API**.
3. Em **Facebook Login for Business → Settings → Valid OAuth Redirect URIs**,
   cadastrar a lista de ambientes (ver abaixo).
4. **Settings → Basic** → copiar **App ID** e **App Secret**.
5. **App Review → Permissions and Features** → pedir `instagram_basic`,
   `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` e
   `business_management`.
6. **Roles → Roles** → adicionar você como Tester, senão o Development mode
   não deixa autorizar.
7. Garantir que a conta Instagram é **Business ou Creator** (conta pessoal não
   publica por API — limite da Meta, não do código) e está **vinculada a uma
   Página do Facebook** no mesmo Business Manager.

Depois, `META_APP_ID`, `META_APP_SECRET` e `META_OAUTH_REDIRECT_URI` entram por
variável de ambiente. Nunca por chat, nunca em commit.

### Redirect URI: onde isso costuma falhar

A Meta compara a URI **textualmente**. As armadilhas, em ordem de frequência:

- Tem de ser `localhost`, não `127.0.0.1` nem `0.0.0.0`.
- Porta e path exatos, iguais ao `META_OAUTH_REDIRECT_URI`. Um caractere de
  diferença — barra a mais no fim inclusive — dá "URL blocked".
- HTTP só é aceito em `localhost`. Qualquer outro host exige HTTPS, mesmo
  domínio interno.

Um app só atende todos os ambientes: basta cadastrar a lista inteira em
**Valid OAuth Redirect URIs**, e cada ambiente usar um valor diferente na
própria variável. A Meta só valida que o valor enviado em runtime está na
lista.

```
http://localhost:3001/api/v1/oauth/instagram/callback
https://publisher-api.esserodolfo.com.br/api/v1/oauth/instagram/callback
```

### Quando localhost não basta

Túnel HTTPS público (ngrok, cloudflared) só é necessário em dois casos:
webhooks da Meta, porque o POST parte dos servidores deles e não alcança
`localhost`; e teste a partir de outra máquina. Webhooks não estão no escopo
agora. A URL do ngrok grátis muda a cada execução, então cada troca exige
recadastrar a redirect URI — Cloudflare Tunnel ancorado em domínio próprio
evita isso.

### Erros comuns no callback

| Mensagem | Causa real |
|---|---|
| `Page has no instagram_business_account linked` | conta IG não é Business, ou não está vinculada a uma Página |
| `App not in Development for user` | falta seu papel de Tester em Roles |
| falha na troca do token | `META_APP_SECRET` errado no ambiente |

Existe `GET /api/v1/oauth/instagram/diagnose` para depurar o fluxo.

## Bloqueios técnicos do deploy

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
  fica em rede interna. Só o *fallback*, com a variável vazia, aponta direto
  para o MinIO — e é esse caso que quebraria.
  Ou seja: `PUBLIC_BASE_URL` = a raiz pública da API, nada mais.

## Dívidas técnicas herdadas

Vieram com o código, não foram introduzidas aqui:

- **Refresh do Page Access Token é stub**
  (`src/modules/social-accounts/oauth/token-refresh.service.ts`). Para
  funcionar de verdade, o long-lived user token precisa ser guardado também —
  nova coluna criptografada em `SocialAccount`, ou tabela própria. Enquanto
  isso, a conexão do Instagram expira e exige reconectar na mão.
- **LinkedIn tem adapter, mas não tem fluxo OAuth.** A plataforma aparece na
  interface e não conecta.

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

   `PUBLIC_BASE_URL` recebe `https://publisher-api.esserodolfo.com.br`, sem
   barra no fim e sem `/api/v1`, que o código acrescenta.

3. Postgres com pgvector, Redis e storage no Coolify.
4. `Dockerfile` do web, ou decisão de mandar o front para a Vercel.
5. Deploy da API e do worker — as migrations aplicam no boot, o `CMD` já faz
   `prisma migrate deploy`.
6. Conectar o Instagram e publicar um carrossel de teste.

## Fora de escopo por enquanto

Chaves de IA (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) ficam
vazias até a geração de conteúdo entrar em uso. A API sobe sem elas; só as
rotas de geração e de embedding falham.
