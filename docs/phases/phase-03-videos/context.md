---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-20T17:14:42-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-25T23:59:59-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-20T17:14:42-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-20T17:14:42-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-20T17:14:42-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-20T17:14:42-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-20T17:14:42-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

_Scope framing (verbatim, `docs/project-plan.md`):_ "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição das informações do vídeo (título, descrição, categoria, thumbnail customizada), categorias, visibilidade público/unlisted, fluxo de rascunho → publicação e painel de gerenciamento do canal — todos capabilities da Fase 04. Player e página de visualização — Fase 05. Transcodificação para múltiplas resoluções/bitrates (ABR ladder) não é capability desta fase: o escopo pede apenas extração de metadados e geração de thumbnail.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a Fase 03 não tem nenhum bullet de tela; a interface de upload e o player ficam para as Fases 04/05. Os dois TDs `Cross-layer` (TD-04 upload handshake, TD-09 delivery) fixam o contrato de wire que a futura UI consome, mas nenhuma tela é construída aqui.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Client Library | decided | A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, custom provider) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| phase-03-videos/TD-02 | phase | Backend | Bucket Topology and Object Key Layout | decided | A (single bucket, `videos/{videoId}/…`, keyed by UUID) | — |
| phase-03-videos/TD-03 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | `bullmq`, `@nestjs/bullmq`, `ioredis` |
| phase-03-videos/TD-04 | phase | Cross-layer | Large-File Upload Protocol (up to 10GB) | decided | A (S3 multipart upload with presigned part URLs) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Worker Topology and Runtime | decided | A (same codebase, separate worker container) | — |
| phase-03-videos/TD-06 | phase | Backend | FFmpeg / FFprobe Invocation Approach | decided | A (direct `child_process.spawn` behind typed `FfmpegService`) | — |
| phase-03-videos/TD-07 | phase | Backend | Worker Access to the Source Object | decided | A (presigned GET URL, read directly by FFmpeg over HTTP Range) | — |
| phase-03-videos/TD-08 | phase | Backend | Unique Public Video URL Strategy | decided | C (`node:crypto` base64url slug in unique `slug` column) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Video Delivery — Streaming and Download | decided | A (presigned GET URLs in metadata response) | — |
| phase-03-videos/TD-10 | phase | Backend | Video Status Lifecycle and Processing Failure Handling | decided | B (dedicated `processing_status` column, orthogonal to publication) | — |
| phase-03-videos/TD-11 | phase | Backend | Thumbnail Frame-Selection Strategy | decided | A (fixed proportional offset, e.g. 10% of duration) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-04 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-11 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-09 |

_TD-06, TD-09 and TD-10 carry a `Capability: Transversal — covers: ...` field and are therefore listed under every capability they cover._

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader)_

### phase-03-videos/TD-01

**Recommendation:** TD-04 requires presigning individual `UploadPart` commands, which the AWS SDK's generic `getSignedUrl(client, command)` supports directly and the alternatives cover less completely. Keeping the client vendor-neutral matters because MinIO is only the local dev backend while production targets S3, and the 2025 MinIO CE changes make vendor coupling the riskier bet. Registered as a custom provider in a `StorageModule` following the repo's existing `registerAs`-based config pattern (`docs/decisions/technical-decisions-phase-01-configuracao-base.md` TD-03/TD-04) — no wrapper package.
**Note:** Decision initially explored Option C (a community NestJS wrapper module), but no candidate wrapper package has any Context7-indexed documentation, confirming Option C's own stated low-adoption risk. Reverted to the original Recommendation (Option A) for verifiable, actively-documented dependencies.
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-02

**Recommendation:** Option C's staging separation is unnecessary because S3 multipart uploads are invisible until `CompleteMultipartUpload` succeeds, and the 5 GB `CopyObject` cap makes its commit step expensive at this file size. Option B's per-bucket policy split buys nothing in Phase 03 and can be adopted later without a code change (only the key-builder's bucket argument moves). Keying by the immutable UUID rather than the public slug decouples storage from TD-08. Bucket creation and the `AbortIncompleteMultipartUpload` lifecycle rule are provisioned by a one-shot `mc` init service in Compose — note that MinIO CE no longer ships an admin web console, so provisioning must be CLI/API-driven regardless of this decision.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** decisive factor is that the worker is a separate container running the *same* NestJS codebase (TD-05), and `@nestjs/bullmq`'s `@Processor`/`WorkerHost` model is the only one that makes that worker plain Nest code with normal DI instead of hand-wired lifecycle glue. Its stalled-job detection and lock renewal are built for exactly the multi-minute FFmpeg jobs this phase runs, and `jobId = videoId` gives TD-10 its idempotency key for free. Adding a Redis container is not an architectural deviation — the C4 diagram already models a dedicated `Message Queue` container.
**Libraries:** `bullmq`, `@nestjs/bullmq`, `ioredis`

### phase-03-videos/TD-04

**Recommendation:** it is the only option that satisfies both halves of the capability simultaneously: the byte path bypasses the API entirely, and resumability falls out of the protocol rather than being added on top. Option B has better client ergonomics but puts 10GB back through the Node process, defeating the requirement; Option C fails both the performance and the resumability requirement. Concrete shape of the contract: part size **64 MiB** (160 parts for a 10 GiB file, well under the 10 000-part ceiling and comfortably over the 5 MiB floor), presigned part URLs issued in **batches on demand** (`GET /videos/uploads/{id}/parts?from=&to=`) rather than 160 URLs in one response, presign TTL sized to the batch, resume driven by `ListParts`, and `AbortMultipartUpload` on explicit cancel with the lifecycle rule from TD-02 as the backstop for abandoned uploads.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** it delivers the C4 diagram's process isolation (the real requirement) without paying Option C's structural cost of a second manifest and a shared-code extraction the repo is not set up for. Reusing the existing entities and `registerAs` config providers directly is a meaningful correctness win: the worker writes to the same tables the API reads, and a duplicated entity definition is a class of bug worth designing out. Option B is rejected on the phase's own performance requirement.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** with fluent-ffmpeg dead, the choice is between owning ~100 lines of well-understood process invocation and adopting an unproven fork of a library that failed for structural reasons. This phase needs exactly two commands, both fully specified by stable, documented FFmpeg flags, and `ffprobe -print_format json` is itself the machine-readable contract a wrapper would otherwise provide. Arguments are always passed as an array (never a shell string) so that filenames and presigned URLs cannot inject. *Which* frame the thumbnail command targets is a separate strategic choice, independent of this invocation mechanism — see TD-11 (Thumbnail Frame-Selection Strategy).
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** it is the only option that keeps the worker stateless with respect to disk. Sizing a scratch volume at `concurrency × 10GB` (Option B) is a real and permanent operational constraint accepted in exchange for I/O predictability the workload does not need: both commands read a small fraction of the file, and FFmpeg's HTTP protocol seeks via Range requests, so the "streaming is slow" intuition does not apply here. Option C is eliminated by seekability. The presign TTL for the worker's URL is set independently of (and longer than) the upload URLs in TD-04, sized to the job timeout; URLs are redacted from logs and from any error text persisted by TD-10. The generated thumbnail is written back with a plain `PutObject` — it is a small file and needs no multipart path.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** it produces the same 11-character URL-safe identifier as nanoid with the same entropy, avoids both the ESM/CJS friction and a dependency, and matches how the repo already resolved an equivalent generation question in Phase 02. Option A fails the plan's explicit "curta" requirement; Option D leaks ordering and enumerability, which is the wrong trade for public content URLs. Collision handling is the same for B and C and must be explicit regardless of generator: unique index on `videos.slug` plus a bounded retry (3 attempts) on unique-violation, which at 64 bits of entropy will effectively never trigger but must exist so a collision degrades to a retry rather than a 500.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** it matches the C4 byte path, and it inherits correct Range/206 semantics from the storage layer rather than reimplementing them, which is the substantive engineering argument: Range, `Content-Range`, 416 and conditional-request handling are easy to get subtly wrong and are already solved on the other side of the presign. Option B is rejected on the same performance grounds as TD-04 Option C, amplified by read traffic. Option C's revocability buys nothing in Phase 03 — every video in this phase is anonymously watchable per `docs/project-plan.md`, and `unlisted`/private visibility is a Fase 04 capability; when that lands, moving to C is a change to one endpoint, not a redesign. Suggested shape: playback TTL sized to a long watch session (a few hours), `expiresAt` returned so the client can refetch, and `downloadUrl` presigned separately with `ResponseContentDisposition` set from the video title.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** the deciding argument is representability, not style: with Option A a processed-but-unpublished video has no valid single state, and Fase 04's own bullets require both concepts to coexist. Option B lets Phase 03 own exactly one axis and hand Fase 04 a clean seam. Option C makes the listing query in Fase 04's panel unnecessarily expensive. Accompanying failure model, all of which the chosen queue (TD-03) supplies directly: `jobId = videoId` so a duplicated enqueue is deduplicated rather than processed twice; `attempts: 3` with exponential backoff for transient failures (storage or network); on final failure the worker sets `processing_status = 'failed'` and persists a redacted `processing_error` (never the presigned URL from TD-07); the worker is idempotent so a retry after a partial run simply overwrites the thumbnail and metadata; `failed` is terminal-but-re-drivable through an explicit re-enqueue; and a periodic reconciliation sweep re-enqueues rows stuck in `processing` past a threshold, covering the lost-enqueue window that TD-03's recommendation identifies.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** it is the cheapest operation (one seek, one frame decode) while still solving Option B's short-video failure mode, matching the phase's performance constraint (`phase-03-videos/TD-04`, AMB-1). Option C's per-upload cost (decoding up to 100 frames, or more for full-file coverage) is disproportionate for a background job that already competes for worker capacity under TD-05, for a quality gain that is marginal versus a well-chosen proportional offset. Nothing prevents revisiting Option C later as a quality improvement once the pipeline is live and thumbnail quality is measured against real uploads.
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases via phases-reader, plus decisions docs confirmed via decisions-correlator; dedupe applied — no collisions, `## Decisions Detail` is empty)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).

**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.

**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.

**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

_(from phases-reader — flattened across prior phases)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from the `testing-guide-nestjs-project` Skill — Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller (`*.controller.ts`) | E2E only — do NOT write unit tests |
| DTO (`*.dto.ts`) | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter (`*.filter.ts`) | Unit + E2E |
| Middleware (`*.middleware.ts`) | E2E |

_Phase 03 introduces artifact types not yet exercised in this project — a queue processor (`WorkerHost`/`@Processor`), a storage adapter service, and a child-process wrapper. The guide's `artifacts/future-types.md` is the entry point for those; the closest existing rows are "Service with side-effect dep (email, storage)" (Integration against a local adapter) and "Service with configured lib" (Unit with real lib + test config)._

### next-frontend

_Deferred subproject — no artifact is built in `next-frontend/` this phase (no UI capability in scope). The `testing-guide-next-frontend` Skill applies when the upload/player screens land in Fases 04/05._
