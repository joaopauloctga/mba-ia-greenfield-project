# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais e tokens de autenticação.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (FFmpeg) — processo headless que consome a fila, extrai duração e gera o thumbnail. Roda como container próprio a partir do mesmo código (`src/main.worker.ts`).
- **Object Storage** (MinIO, API compatível com S3) — arquivos de vídeo e thumbnails. Recebe os bytes do upload **direto do cliente**, via URLs pré-assinadas.
- **Message Queue** (BullMQ sobre Redis) — fila `video-processing` que dispara o processamento após o upload.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit + MinIO + Redis + Worker)

```bash
cd nestjs-project

# Sobe API, banco, Mailpit, MinIO (+ criação do bucket), Redis e o video-worker
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Mailpit (UI de e-mails) | http://localhost:8125 |
| MinIO (object storage) | `localhost:9000` (user/senha: `streamtube`/`streamtube123`, bucket `streamtube`) |
| Redis (fila BullMQ) | `localhost:6379` |
| Video Worker | container `video-worker` (sem porta — consome a fila) |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

> O `video-worker` roda `node dist/main.worker.js` sem watch mode. Depois de alterar código do worker, rode `npm run build` e `docker compose restart video-worker`.

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base**, **Fase 02 — Autenticação** (backend + frontend) e **Fase 03 — Upload e Processamento de Vídeos** (backend) estão concluídas.

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Vídeos (Fase 03)

Upload de arquivos de **até 10GB**, processamento automático em segundo plano e entrega por streaming. Escopo de backend — o player e a página de visualização são da Fase 05.

**Os bytes nunca passam pela API.** O upload usa **multipart do S3 com URLs pré-assinadas**: a API apenas assina as URLs e registra o estado; o cliente faz `PUT` de cada parte (64 MiB) direto no object storage. É isso que torna um upload de 10GB viável sem ocupar a API.

| Método & Rota | Auth | Descrição |
|---------------|------|-----------|
| `POST /videos/uploads` | ✅ | Pré-cadastra o vídeo como rascunho (`awaiting_upload`) e abre a sessão multipart |
| `GET /videos/uploads/:videoId/parts?from&to` | ✅ | Emite URLs pré-assinadas para um intervalo de partes |
| `POST /videos/uploads/:videoId/complete` | ✅ | Valida as partes contra o storage, finaliza o upload e enfileira o processamento |
| `DELETE /videos/uploads/:videoId` | ✅ | Aborta a sessão e remove o rascunho |
| `GET /videos/:slug` | 🌐 público | Metadados + URLs de streaming e download (`409` enquanto não estiver pronto) |

Fluxo de processamento: ao completar o upload, um job `video.process` vai para a fila `video-processing` (BullMQ/Redis, 3 tentativas com backoff exponencial). O **`video-worker`** consome o job, roda **ffprobe** para extrair a duração, **ffmpeg** para capturar um frame a 10% do vídeo como thumbnail, e marca o vídeo como `ready`. Um job repetível reenfileira vídeos travados em `processing` há mais de 15 minutos.

Ciclo de status, persistido em `videos.processing_status`:

```
awaiting_upload → processing → ready | failed
```

Entrega: cada vídeo recebe um **slug único** (base64url sobre 8 bytes aleatórios, com retry em colisão) usado como identificador público. Streaming e download são URLs pré-assinadas servidas direto pelo storage, que honra HTTP Range (`206 Partial Content`) — a reprodução nunca exige o download completo. A URL de download difere apenas por carregar `Content-Disposition: attachment`.

> **Limitação conhecida:** as URLs pré-assinadas são assinadas contra `S3_ENDPOINT` (`http://minio:9000`), que só resolve **dentro** da rede do Compose. Um navegador no host não consegue usá-las: o hostname não resolve, e reescrevê-lo para `localhost:9000` invalida a assinatura SigV4 (`host` é um header assinado). Servir essas URLs a um cliente real exige assinar contra um endpoint alcançável pelo cliente.

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento de vídeos
│   ├── decisions/                       # Decisões técnicas por fase (research)
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── videos/                      # Upload multipart, entrega e worker de processamento
│   │   ├── storage/                     # Cliente S3/MinIO (presign, multipart)
│   │   ├── queue/                       # Fila BullMQ e agendador de reconciliação
│   │   ├── ffmpeg/                      # Wrapper de ffprobe/ffmpeg
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   ├── database/                    # data-source, migrations e seeds
│   │   ├── main.ts                      # Entrypoint da API (AppModule)
│   │   └── main.worker.ts               # Entrypoint do worker (WorkerModule)
│   ├── test/                            # Testes e2e
│   ├── compose.yaml                     # Compose (API + Postgres + Mailpit + MinIO + Redis + worker)
│   ├── Dockerfile.dev
│   └── Dockerfile.worker                # Imagem do worker (única com FFmpeg instalado)
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars) |
| Banco de Dados | PostgreSQL 17 |
| Object Storage | MinIO (compatível com S3), AWS SDK v3 (`@aws-sdk/client-s3` + `s3-request-presigner`) |
| Fila | BullMQ sobre Redis 7 (`@nestjs/bullmq`) |
| Processamento de vídeo | FFmpeg / ffprobe (no container `video-worker`) |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
