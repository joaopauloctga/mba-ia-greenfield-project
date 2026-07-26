---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-25
scope_description: "Upload and processing pipeline for videos: object-storage client and key layout, background job queue technology, 10GB resumable upload protocol, video worker topology and FFmpeg toolchain, worker source-object access, thumbnail frame-selection strategy, short unique video URLs, streaming/download delivery, and the video processing status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns every capability of this phase: storage service, queue producer, upload handshake endpoints, draft pre-registration, the FFmpeg worker container, unique-slug generation, and the streaming/download delivery endpoints. All eleven TDs below apply here.
- `next-frontend/` — **no open frontend-only decision in this document.** Fase 03 in `docs/project-plan.md` has no UI bullet (upload screen, player and management panel are Fases 04/05), so no screen is built here. The two `Cross-layer` TDs (TD-04 upload handshake, TD-09 delivery) fix the wire contract that the future upload UI and player must implement; the frontend side of that contract is consumed, not decided, in this phase.

---

## TD-01: Object Storage Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The C4 container diagram fixes the storage technology as "Object Storage — S3 or MinIO", but not which Node client the API and the worker use to talk to it. This choice determines the presigning API surface consumed by TD-04 (multipart upload) and TD-09 (streaming/download), and it is referenced from at least three places that must stay consistent: the API's storage module, the worker container, and the Compose/env configuration. MinIO runs locally in Compose; a managed S3 is the production target — so the client must speak plain S3 against both.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`
- Official AWS SDK v3 (modular). `S3Client` configured with `endpoint`, `forcePathStyle: true` and static credentials points at MinIO unchanged; dropping those three options points it at real S3. Presigning is a separate small package (`getSignedUrl(client, command, { expiresIn })`).
- **Pros:** First-party, actively released (v3.1095.x). Complete multipart command set (`CreateMultipartUpload`, `UploadPart`, `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`) and the presigner supports presigning *any* command, including `UploadPart` — which is what TD-04 needs. Same code path for MinIO (dev) and S3 (prod), so no vendor-specific branch. Excellent TypeScript types; `aws-sdk-client-mock` gives a clean unit-test seam.
- **Cons:** Larger dependency footprint (modular, but still several `@smithy/*` transitive packages). Verbose command-object API. Credential-provider chain has to be pinned to static credentials in dev or it probes IMDS and adds latency.

### Option B: `minio` official JavaScript client
- MinIO's own SDK (v8.x). Higher-level, promise-based API: `presignedPutObject`, `presignedGetObject`, `fPutObject`, and multipart helpers.
- **Pros:** Terser API for the common cases. Smaller dependency tree. Written for exactly the server running in Compose.
- **Cons:** Couples the codebase to a vendor SDK for a workload that must also run on real S3 — the SDK targets the S3 API but is not the reference implementation, and its presigning helpers are less complete for the per-part multipart flow TD-04 needs. MinIO Community Edition entered a contentious period in 2025 (admin console removed from CE, license moved to AGPLv3, features moved to the paid AIStor edition), which makes betting the client layer on the MinIO ecosystem the higher-risk option even though the *server* stays as the dev backend.

### Option C: Community NestJS wrapper module (`nestjs-minio-client` / `@nestjs/aws-sdk`-style)
- A thin NestJS module that registers the underlying client as an injectable provider via `forRootAsync`.
- **Pros:** Saves writing a custom provider (~20 lines). Config wiring follows the familiar `forRootAsync({ useFactory })` shape already used by `TypeOrmModule` and `MailerModule` in this repo.
- **Cons:** Adds a low-adoption dependency in front of the SDK for something the project can do in one custom provider. These wrappers historically lag the underlying SDK's major versions and constrain which client version can be installed. No behavioral benefit — DI wiring is not the hard part of this phase.

**Recommendation:** **Option A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)** — TD-04 requires presigning individual `UploadPart` commands, which the AWS SDK's generic `getSignedUrl(client, command)` supports directly and the alternatives cover less completely. Keeping the client vendor-neutral matters because MinIO is only the local dev backend while production targets S3, and the 2025 MinIO CE changes make vendor coupling the riskier bet. Registered as a custom provider in a `StorageModule` following the repo's existing `registerAs`-based config pattern (`docs/decisions/technical-decisions-phase-01-configuracao-base.md` TD-03/TD-04) — no wrapper package.

**Decision:** A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, custom provider — no wrapper package)

**Note:** Decision initially explored Option C (a community NestJS wrapper module), but no candidate wrapper package (`@lab08/nestjs-s3`, `@ntegral/nestjs-s3`, and others) has any Context7-indexed documentation, confirming Option C's own stated low-adoption risk. Reverted to the original Recommendation (Option A) for verifiable, actively-documented dependencies.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-02: Bucket Topology and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Two artifact types are stored per video (the source file and the generated thumbnail), written by two different containers (the API presigns the source upload; the worker writes the thumbnail), and read by two different flows (streaming and download). The bucket/key layout is a cross-component contract: the API's presign calls, the worker's read/write calls, and the Compose bucket-provisioning step all have to agree on it. It also determines whether renaming a video's public URL (TD-08) forces objects to move, and whether abandoned multipart uploads can be garbage-collected by a lifecycle rule.

**Options:**

### Option A: Single bucket, per-video prefix keyed by internal UUID
- One bucket (e.g. `streamtube`). Keys: `videos/{videoId}/source{ext}` and `videos/{videoId}/thumbnail.jpg`, where `{videoId}` is the entity's UUID primary key — not the public slug.
- **Pros:** One bucket to provision, one policy, one lifecycle configuration. All artifacts of a video share a prefix, so deleting a video is a single prefix listing + batch delete. Keying by the immutable UUID means the public slug (TD-08) can change in a later phase without moving a single byte. A single `AbortIncompleteMultipartUpload` lifecycle rule reclaims space from abandoned 10GB uploads across the whole bucket.
- **Cons:** Thumbnails (small, public, cacheable) and source videos (huge, bandwidth-heavy) share one bucket, so they cannot get different storage classes or CDN policies without prefix-scoped rules. Prefix-scoped rules are supported but slightly more configuration than per-bucket rules.

### Option B: Separate buckets per artifact type
- `streamtube-videos` and `streamtube-thumbnails`, each keyed by `{videoId}`.
- **Pros:** Per-bucket policies map cleanly to the access asymmetry: thumbnails can be made publicly readable and CDN-fronted, source videos stay private behind presigned URLs. Independent lifecycle/storage-class configuration. Clear blast-radius separation.
- **Cons:** Two buckets to provision, configure and keep in sync in every environment. Deleting a video touches two buckets — no atomic prefix delete. Two more env keys. The asymmetry it buys is not exercised in Phase 03 (no CDN, no public-read requirement yet).

### Option C: Single bucket with a separate staging prefix for in-flight uploads
- `uploads/{videoId}/…` while the multipart upload is open; the API copies (or `CompleteMultipartUpload` + server-side copy) into `videos/{videoId}/…` on completion.
- **Pros:** Committed objects are never mixed with half-written ones — a listing of `videos/` is by definition a listing of complete files. Aggressive lifecycle expiry on `uploads/` cleans up abandoned attempts without touching real data.
- **Cons:** A server-side copy of a 10GB object is not free — S3 `CopyObject` is capped at 5 GB and a larger object requires a multipart *copy*, so the "commit" step becomes its own multi-request operation. Solves a problem that `AbortIncompleteMultipartUpload` already solves: an incomplete multipart upload is not visible as an object at all, so `videos/` never lists partial files in the first place.

**Recommendation:** **Option A (single bucket, `videos/{videoId}/…` prefix, keyed by UUID)** — Option C's staging separation is unnecessary because S3 multipart uploads are invisible until `CompleteMultipartUpload` succeeds, and the 5 GB `CopyObject` cap makes its commit step expensive at this file size. Option B's per-bucket policy split buys nothing in Phase 03 and can be adopted later without a code change (only the key-builder's bucket argument moves). Keying by the immutable UUID rather than the public slug decouples storage from TD-08. Bucket creation and the `AbortIncompleteMultipartUpload` lifecycle rule are provisioned by a one-shot `mc` init service in Compose — note that MinIO CE no longer ships an admin web console, so provisioning must be CLI/API-driven regardless of this decision.

**Decision:** A (Single bucket, `videos/{videoId}/…` prefix, keyed by UUID)

**Libraries:** —

---

## TD-03: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** This is the "TBD" in the C4 diagram's `Message Queue` container and the central infrastructure decision of the phase. The API must hand off video processing to a worker (TD-05) without blocking the request, jobs must survive an API restart, must retry on transient failure with backoff (TD-10), and must not be processed twice for the same video. Jobs are few but long — a single ffprobe + thumbnail extraction over a multi-GB file runs for seconds to minutes, so the queue's handling of long-running consumers (visibility/lock renewal, stalled-job detection) matters more than raw throughput. No message broker exists in the stack today; `compose.yaml` has `nestjs-api`, `db` (PostgreSQL 17) and `mailpit`.

**Options:**

### Option A: BullMQ + Redis, via `@nestjs/bullmq`
- Redis-backed queue (`bullmq` 5.x) with the official NestJS integration (`@nestjs/bullmq` 11.x, aligned with NestJS 11). Producers inject a `Queue` registered by `BullModule.registerQueue({ name })`; consumers are classes decorated with `@Processor(name)` extending `WorkerHost`. Requires adding a `redis` service to Compose.
- **Pros:** The only option with a first-class, DI-native NestJS integration — the worker (TD-05) is the same Nest codebase, so `@Processor`/`WorkerHost` classes get constructor injection of the storage service, repositories and config with no glue. Built-in `attempts` + exponential `backoff`, per-job `jobId` (natural idempotency key: the video id), concurrency limits, rate limiting, and — critical here — explicit stalled-job detection with lock renewal designed for long-running jobs. Failed jobs are retained and re-drivable. Mature observability via Bull Board. Largest ecosystem of the three.
- **Cons:** Adds a stateful container (Redis) to the stack that must be configured for persistence (AOF/RDB) or queued jobs are lost on restart — a second durability domain alongside PostgreSQL. **Enqueue cannot participate in the database transaction** that writes the video row: a commit followed by a failed enqueue silently drops the job, so a reconciliation sweep is needed to recover stuck rows. One more service to run, monitor and back up.

### Option B: RabbitMQ, via `@nestjs/microservices` (RMQ transport) or `amqplib` directly
- A real AMQP broker. NestJS's built-in RMQ transport exposes `@EventPattern` handlers and a `ClientProxy` producer; `amqplib` can be used directly for full control over exchanges, queues and acknowledgements.
- **Pros:** Purpose-built broker with strong delivery semantics, publisher confirms, per-message ack/nack, prefetch control, and first-class dead-letter exchanges. Routing topologies (fanout/topic) if the pipeline later grows several consumer types (transcode ladder, moderation, indexing). Battle-tested at far higher scale than this project needs.
- **Cons:** `@nestjs/microservices`' RMQ transport is designed around request/response and event patterns, not job queues — retries with backoff, delayed redelivery and DLQ routing are not provided; they must be hand-built with dead-letter exchanges and TTL queues. Long-running consumers require careful manual `prefetch` and ack handling to avoid redelivery storms. Heaviest operational footprint of the three (broker + management plugin + vhost/user provisioning). Substantially more code for a pipeline that currently has exactly one job type.

### Option C: pg-boss on the existing PostgreSQL
- Job queue implemented as PostgreSQL tables using `SELECT … FOR UPDATE SKIP LOCKED` (pg-boss 12.x). Installs its own schema; no new container.
- **Pros:** **Zero new infrastructure** — PostgreSQL is already in Compose, already backed up, already monitored. Jobs are ACID rows, so the enqueue can run **inside the same transaction** as the video row insert: either both happen or neither does, eliminating the lost-job window that Options A and B have. Ships retries with exponential backoff, dead-letter queues (as ordinary queues), priorities, deferral, cron scheduling and exactly-once delivery. One durability domain, one operational surface.
- **Cons:** No first-party NestJS module — the `PgBoss` instance and each worker registration must be wired manually as custom providers with explicit lifecycle hooks (`OnModuleInit`/`OnModuleDestroy`). Job polling shares the application's PostgreSQL connection pool with request traffic, so pool sizing becomes a shared concern. Lower throughput ceiling than a Redis/AMQP broker (irrelevant at this project's volume, but it is the reason the ecosystem is smaller). No mature ready-made dashboard equivalent to Bull Board.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — decisive factor is that the worker is a separate container running the *same* NestJS codebase (TD-05), and `@nestjs/bullmq`'s `@Processor`/`WorkerHost` model is the only one that makes that worker plain Nest code with normal DI instead of hand-wired lifecycle glue. Its stalled-job detection and lock renewal are built for exactly the multi-minute FFmpeg jobs this phase runs, and `jobId = videoId` gives TD-10 its idempotency key for free. Adding a Redis container is not an architectural deviation — the C4 diagram already models a dedicated `Message Queue` container.

**What is lost by choosing A:** transactional enqueue. The video row is committed before the job is queued, so a crash in between leaves a row in `processing` with no job. This is recoverable with a periodic reconciliation query (`status = 'processing' AND updated_at < now() - interval '15 minutes'` → re-enqueue), and that sweep is worth planning for regardless.

**If the priority is "no new infrastructure", Option C (pg-boss) is the correct choice and is not a compromise on features** — it covers retries, backoff, DLQ and exactly-once delivery, and its transactional enqueue is strictly stronger than A's. The cost is manual NestJS wiring and a smaller ecosystem. Option B is not recommended: it is the most operational work for capabilities this phase does not use.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

**Libraries:** `bullmq`, `@nestjs/bullmq`, `ioredis`

---

## TD-04: Large-File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The requirement has two halves: files up to 10GB, and "sem impacto na performance" — the byte stream must not be carried by the NestJS process. `docs/project-plan.md` §4 adds that the upload must be resumable after a connection failure. This decision defines the handshake contract between the future upload UI and the API (which endpoints exist, in what order, and what shape each response has), so it is decided once for both sides.

**A documented S3 limit eliminates the simplest option:** a single `PutObject` — and therefore a single presigned PUT URL — is capped at **5 GB**. A 10GB file physically cannot be uploaded that way. Multipart upload accepts 1–10 000 parts of 5 MiB–5 GiB each (last part exempt from the minimum), so 10 GiB at 64 MiB parts is 160 parts — comfortably inside every limit. Any viable option here is therefore chunked.

**Options:**

### Option A: S3 multipart upload with presigned part URLs
- Three-step handshake, bytes never touch the API. `POST /videos/uploads` → API pre-registers the draft video row (TD-10) and calls `CreateMultipartUpload`, returning `{ videoId, uploadId, partSize, presigned part URLs }`. The browser `PUT`s each part **directly to storage** and collects each part's `ETag`. `POST /videos/uploads/{id}/complete` → API calls `CompleteMultipartUpload` with the part/ETag list and enqueues the processing job (TD-03).
- **Pros:** The API handles three small JSON requests for a 10GB upload — the literal reading of "sem impacto na performance". Resumability is inherent: a dropped connection only loses the parts in flight, and `ListParts` lets the API tell the client exactly which parts already landed. Parts can be uploaded in parallel for throughput. Uses the storage API already chosen in TD-01, with no additional server component and no second auth surface. Works identically on MinIO and S3.
- **Cons:** The client is responsible for the chunking loop, retry-per-part and ETag bookkeeping — more frontend code than a single `<input type=file>` POST. Presigned URLs expire, so a long upload needs either a generous TTL or an endpoint to re-issue URLs for the remaining parts. The complete step must validate that the client's declared parts match what storage actually holds.

### Option B: tus resumable upload protocol (`@tus/server` + `@tus/s3-store`)
- An open protocol for resumable uploads over HTTP. `@tus/server` is mounted as a route on the NestJS app; `@tus/s3-store` persists to any S3-compatible backend. The browser uses `tus-js-client` (or Uppy), which handles chunking, offset negotiation and resume automatically.
- **Pros:** Best client ergonomics by a wide margin — resume, retry and progress are the client library's job, not the application's. A real specification with multiple mature implementations; battle-tested in production at scale (Supabase, among others). Server-side hooks give a natural place to enforce size/type limits before bytes are accepted.
- **Cons:** **Reintroduces the exact load this phase is trying to avoid** — every byte flows through the Node process, which buffers and re-uploads parts to S3. For a 10GB file that is 10GB of ingress, memory/disk churn and event-loop pressure on the API container. Adds a second HTTP surface with its own auth model that must be reconciled with the existing JWT guards. Adds two dependencies and a protocol for the team to learn. Scaling it means putting the tus server behind a distributed lock (supported, but more moving parts).

### Option C: Proxy the upload through the API (`@aws-sdk/lib-storage` streaming)
- Client POSTs a multipart/form-data body to the API; the API pipes the incoming stream into `Upload` from `@aws-sdk/lib-storage`, which internally performs a multipart upload to storage.
- **Pros:** Simplest possible client (one `<form>`/`fetch`). Every byte passes through application code, so validation (magic-number sniffing, size enforcement) is trivial and no presigned URL is ever exposed.
- **Cons:** Directly violates "sem impacto na performance" — one 10GB upload occupies an API connection and its event loop for the whole transfer, and N concurrent uploads multiply that. Not resumable: a dropped connection restarts from byte zero, contradicting `docs/project-plan.md` §4. Reverse proxies and platform gateways commonly impose request body-size and timeout limits far below 10GB. Contradicts the C4 diagram, which routes bulk bytes between the browser and object storage, not through the API.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — it is the only option that satisfies both halves of the capability simultaneously: the byte path bypasses the API entirely, and resumability falls out of the protocol rather than being added on top. Option B has better client ergonomics but puts 10GB back through the Node process, defeating the requirement; Option C fails both the performance and the resumability requirement. Concrete shape of the contract: part size **64 MiB** (160 parts for a 10 GiB file, well under the 10 000-part ceiling and comfortably over the 5 MiB floor), presigned part URLs issued in **batches on demand** (`GET /videos/uploads/{id}/parts?from=&to=`) rather than 160 URLs in one response, presign TTL sized to the batch, resume driven by `ListParts`, and `AbortMultipartUpload` on explicit cancel with the lifecycle rule from TD-02 as the backstop for abandoned uploads.

**Decision:** A (S3 multipart upload with presigned part URLs)

**Libraries:** —

---

## TD-05: Video Worker Topology and Runtime

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The C4 diagram models a dedicated `Video Worker (FFmpeg)` container that consumes from the queue, reads/writes storage and updates the database. What it does not fix is *how* that container relates to the API codebase: whether it is the same NestJS project booted differently, or a separate application. This determines how many Dockerfiles and package manifests exist, whether the worker can reuse the TypeORM entities and config modules, and where the FFmpeg binaries are installed.

**Options:**

### Option A: Separate Compose service running the same NestJS codebase in a worker-only bootstrap
- A second entrypoint (`src/main.worker.ts`) boots `NestFactory.createApplicationContext(WorkerModule)` — a headless Nest context with no HTTP server. `WorkerModule` imports only what processing needs (config, TypeORM, storage, queue consumer). A `Dockerfile.worker` extends the same base image and adds the `ffmpeg`/`ffprobe` binaries.
- **Pros:** One codebase, one `package.json`, one test suite, one lint/tsc gate — entities, config (`registerAs` providers), and the storage service are imported directly with no duplication or package extraction. Matches the C4 diagram's separate container. FFmpeg stays out of the API image, so the API image remains small. Scaling the worker is a Compose `replicas` change. The processor class is ordinary NestJS code with constructor DI.
- **Cons:** Two Dockerfiles and two Compose services from one build context. `WorkerModule` must be curated so the worker does not accidentally pull in controllers/guards it has no use for. A shared codebase means an API-only change still rebuilds the worker image.

### Option B: Worker runs in-process inside the API container
- The BullMQ `Worker`/`@Processor` is registered in the same Nest application that serves HTTP.
- **Pros:** Simplest possible setup — no second service, no second Dockerfile, no separate bootstrap. Everything in one process.
- **Cons:** A multi-minute FFmpeg job competes with HTTP request handling in the same container; spawned FFmpeg processes consume CPU and memory that the API needs, which is precisely the "sem impacto na performance" risk this phase exists to avoid. FFmpeg must be installed in the API image, inflating it. Worker and API cannot be scaled independently. Contradicts the C4 diagram's container split.

### Option C: Standalone worker application (`video-worker/`) with its own manifest
- A third top-level subproject with its own `package.json`, TypeScript config and dependency set, sharing nothing with the API except the database and the queue.
- **Pros:** Hard isolation — the worker's dependency tree is exactly what it needs, and it can evolve (or be rewritten in another language) independently. Clear ownership boundary.
- **Cons:** Entities, migrations, config schemas and the storage client are duplicated or must be extracted into a shared package, which means introducing monorepo workspace tooling that the repo does not have today (`docs/decisions/technical-decisions-phase-01-configuracao-base.md` established no `packages/*` layer). Two dependency trees to keep in version lockstep against the same database schema. Significant structural cost for a worker with one job type.

**Recommendation:** **Option A (same codebase, separate worker container)** — it delivers the C4 diagram's process isolation (the real requirement) without paying Option C's structural cost of a second manifest and a shared-code extraction the repo is not set up for. Reusing the existing entities and `registerAs` config providers directly is a meaningful correctness win: the worker writes to the same tables the API reads, and a duplicated entity definition is a class of bug worth designing out. Option B is rejected on the phase's own performance requirement.

**Decision:** A (Same codebase, separate worker container)

**Libraries:** —

---

## TD-06: FFmpeg / FFprobe Invocation Approach

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Both processing capabilities are FFmpeg operations: `ffprobe` reads duration, resolution, codec and bitrate; `ffmpeg` extracts a single frame as the thumbnail. The question is whether to drive the binaries through a Node wrapper library or invoke them directly, which determines how commands are built, how errors surface, and how the worker is unit-tested.

**The historically default answer is no longer viable:** `fluent-ffmpeg`, for a decade the standard Node wrapper, was **archived on 2025-05-22 and is marked deprecated on npm** ("Package no longer supported"), with the maintainers stating it "no longer works properly with recent ffmpeg versions". It cannot be recommended for greenfield code in 2026.

**Options:**

### Option A: Direct `child_process.spawn` of `ffprobe`/`ffmpeg`, behind a thin typed service
- A `FfmpegService` builds argument arrays and spawns the binaries. Metadata: `ffprobe -v quiet -print_format json -show_format -show_streams <input>` → parse stdout as JSON into a typed result. Thumbnail: `ffmpeg -ss <t> -i <input> -frames:v 1 -q:v 2 -f image2 <out.jpg>`.
- **Pros:** No dependency, and specifically no *unmaintained* dependency in the hot path. `ffprobe -print_format json` is a stable, documented machine-readable contract — parsing it is more robust than depending on a wrapper's own normalization. Full access to every FFmpeg flag with no abstraction to fight, including argument order semantics that matter (`-ss` before `-i` for fast seeking). Exit code + stderr give precise failure information for TD-10. Trivial to unit-test by mocking `spawn`, and the exact command is greppable in logs.
- **Cons:** The project owns argument construction, stream handling and error parsing (~100 lines). No progress-event abstraction — must be parsed from stderr if ever needed. Argument arrays must be built carefully (array form, never a shell string) to avoid injection from filenames or URLs.

### Option B: `fluent-ffmpeg`
- Chainable builder API (`ffmpeg(input).screenshots({...})`, `ffmpeg.ffprobe(input, cb)`).
- **Pros:** Familiar, well-documented API with a large body of examples. Handles argument ordering and provides progress events out of the box.
- **Cons:** **Deprecated on npm and archived upstream since May 2025**, with an explicit maintainer statement that it no longer works correctly with recent FFmpeg versions. No security or compatibility fixes will land. Adopting it in a greenfield 2026 project means shipping known technical debt on day one.

### Option C: A maintained fork or TypeScript rewrite (e.g. `@ts-ffmpeg/fluent-ffmpeg`)
- Community continuation of the fluent API with modern typings.
- **Pros:** Keeps the ergonomic builder API while being nominally maintained. Native TypeScript types.
- **Cons:** Low adoption and typically single-maintainer, so it trades a known-dead dependency for an unproven one. Inherits fluent-ffmpeg's core design problem — a stable API over FFmpeg's deliberately unstable CLI — which is what caused the original to fail. The two commands this phase needs are short enough that the ergonomic benefit is marginal.

**Recommendation:** **Option A (direct `spawn` behind a typed `FfmpegService`)** — with fluent-ffmpeg dead, the choice is between owning ~100 lines of well-understood process invocation and adopting an unproven fork of a library that failed for structural reasons. This phase needs exactly two commands, both fully specified by stable, documented FFmpeg flags, and `ffprobe -print_format json` is itself the machine-readable contract a wrapper would otherwise provide. Arguments are always passed as an array (never a shell string) so that filenames and presigned URLs cannot inject. *Which* frame the thumbnail command targets is a separate strategic choice, independent of this invocation mechanism — see TD-11 (Thumbnail Frame-Selection Strategy).

**Decision:** A (Direct `child_process.spawn` behind a typed `FfmpegService`)

**Libraries:** —

---

## TD-07: Worker Access to the Source Object

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The source file lives in object storage and can be 10GB. Before FFmpeg can read it, the worker has to decide *how* the bytes reach the process. This is not an implementation detail: it determines whether the worker container needs a scratch volume sized for concurrent multi-GB downloads, how long a job holds its queue lock, and what the storage service must expose. It is referenced by the worker's Compose service definition, the storage module's presign surface, and the FFmpeg command built in TD-06.

**Options:**

### Option A: Presigned GET URL read directly by FFmpeg over HTTP
- The worker asks the storage service for a short-lived presigned GET URL and passes it as FFmpeg's input (`ffprobe … "<url>"`, `ffmpeg -ss <t> -i "<url>" …`). FFmpeg's HTTP protocol is seekable — it issues HTTP Range requests — so it fetches only the bytes it actually needs.
- **Pros:** **No local copy, so no 10GB scratch disk and no per-job disk sizing.** Metadata extraction reads only the container header, and thumbnail extraction with `-ss` before `-i` seeks straight to the target region instead of decoding from byte zero — both are small-range reads over a huge file, so jobs finish in seconds rather than after a multi-GB transfer. Nothing to clean up on crash: a killed worker leaves no orphaned temp files. Shortest queue-lock hold time of the three.
- **Cons:** Job duration depends on network round-trips to storage; a slow or flaky link surfaces as FFmpeg I/O errors rather than a clean download failure. If the MP4's `moov` atom sits at the end of the file (not `faststart`), FFmpeg must range-read the tail first — correct, but a few extra round-trips. The presigned URL must outlive the job, so its TTL has to be sized against the worst-case processing time. URLs appear in process arguments, so they must be redacted in logs.

### Option B: Download the whole object to a scratch volume, then process locally
- The worker `GetObject`s to `/tmp/{videoId}/source`, runs both FFmpeg commands against the local file, then deletes it.
- **Pros:** FFmpeg gets a fast, fully seekable local file — the most predictable I/O behavior, with no dependency on storage latency during decode. Download failure is a clean, separately-diagnosable error before any FFmpeg work starts. Multiple passes over the same file cost nothing extra.
- **Cons:** **Requires up to 10GB of ephemeral disk per concurrent job** — the worker container's volume must be sized `concurrency × 10GB`, and exhausting it fails jobs in a way that is unpleasant to diagnose. Every job pays a full multi-GB transfer before doing seconds of actual work, inflating job duration and queue-lock hold time by orders of magnitude. Requires disciplined cleanup on both success and failure paths, plus a sweeper for files orphaned by hard crashes.

### Option C: Stream the object into FFmpeg's stdin (`-i pipe:0`)
- The worker pipes the `GetObject` body straight into the FFmpeg process.
- **Pros:** No local file and no presigned URL — the worker's existing credentialed client does the read. Constant, small memory footprint.
- **Cons:** **A pipe is not seekable**, which breaks both operations this phase needs: `ffprobe` cannot jump to a tail-located `moov` atom, and `-ss` cannot seek, so thumbnail extraction degrades to decoding sequentially from the start of a 10GB file. Two commands means either streaming the object twice or buffering it. Strictly worse than A for this workload.

**Recommendation:** **Option A (presigned GET URL, read over HTTP Range by FFmpeg)** — it is the only option that keeps the worker stateless with respect to disk. Sizing a scratch volume at `concurrency × 10GB` (Option B) is a real and permanent operational constraint accepted in exchange for I/O predictability the workload does not need: both commands read a small fraction of the file, and FFmpeg's HTTP protocol seeks via Range requests, so the "streaming is slow" intuition does not apply here. Option C is eliminated by seekability. The presign TTL for the worker's URL is set independently of (and longer than) the upload URLs in TD-04, sized to the job timeout; URLs are redacted from logs and from any error text persisted by TD-10. The generated thumbnail is written back with a plain `PutObject` — it is a small file and needs no multipart path.

**Decision:** A (Presigned GET URL, read directly by FFmpeg over HTTP Range)

**Libraries:** —

---

## TD-08: Unique Public Video URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `docs/project-plan.md` §4 states the requirement precisely: "cada vídeo precisa de uma URL **curta** e única que nunca conflite com outro vídeo". The repo's entity convention (`.claude/rules/nestjs-entities.md`) makes every primary key a UUID, so the public identifier is a separate concern from the PK. This identifier is minted at draft pre-registration (TD-10), stored on the video row, and consumed by the delivery endpoints (TD-09), so it is fixed once here.

**A packaging constraint applies to one candidate:** `nanoid` has been **ESM-only since v4** (current v6 declares `"type": "module"`). The backend compiles to CommonJS (`module: nodenext` with no `"type": "module"` in `nestjs-project/package.json`), so a plain `import { nanoid } from 'nanoid'` emits a `require()` that fails at runtime. Using nanoid means pinning the still-maintained CJS `nanoid@3` line or routing through a dynamic `import()`.

**Options:**

### Option A: Expose the UUID primary key as the public URL
- `/watch/{uuid}` — no new column, no generation logic.
- **Pros:** Zero code, zero collision risk (v4 UUIDs are collision-free at any realistic scale), no second index. One identifier for internal and external use.
- **Cons:** 36 characters — fails the "curta" requirement in the project plan. Ugly in a share link. Couples the public URL to the storage-layer primary key, so it can never change without a data migration.

### Option B: `nanoid` short slug in a dedicated unique column
- An 11–12 character URL-safe id stored in `videos.slug` with a unique index, generated at pre-registration.
- **Pros:** Purpose-built, widely used, well-audited generator with a configurable alphabet and documented collision math. Compact and URL-safe.
- **Cons:** The ESM/CJS constraint above forces either `nanoid@3` (a maintenance-mode major, still patched) or an awkward dynamic import inside a synchronous code path. Adds a dependency for roughly ten lines of `node:crypto`.

### Option C: `node:crypto` random slug in a dedicated unique column
- `randomBytes(8).toString('base64url')` → an 11-character URL-safe id (64 bits of entropy), stored in `videos.slug` with a unique index and a bounded regeneration retry on unique-violation.
- **Pros:** Identical output shape and entropy to nanoid's default with **zero dependencies and no module-format friction** — `node:crypto` is CommonJS-safe. `base64url` is URL-safe by definition (RFC 4648 §5). Follows the grain of the repo's existing precedent for this exact kind of choice (`technical-decisions-phase-02-auth.md` TD-10 chose dependency-free generation over adding a library). Decoupled from the PK, so the slug can be changed later without touching storage keys (TD-02 keys by UUID precisely to allow this).
- **Cons:** The project owns the generator and its tests, small as they are. No library-provided collision guidance — the unique index plus retry loop is the actual guarantee and must be written deliberately.

### Option D: Reversible encoding of a sequential id (`sqids`/hashids)
- Encode an auto-increment integer into a short string.
- **Pros:** Guaranteed collision-free by construction — no retry loop needed. Shortest strings for early rows.
- **Cons:** Reversible by design, so the URL leaks the row's ordinal — total video count and publication order become public, and the id space is trivially enumerable for scraping. Requires abandoning the repo-wide UUID primary-key convention or maintaining a parallel sequence column.

**Recommendation:** **Option C (`node:crypto` base64url slug in a unique `slug` column)** — it produces the same 11-character URL-safe identifier as nanoid with the same entropy, avoids both the ESM/CJS friction and a dependency, and matches how the repo already resolved an equivalent generation question in Phase 02. Option A fails the plan's explicit "curta" requirement; Option D leaks ordering and enumerability, which is the wrong trade for public content URLs. Collision handling is the same for B and C and must be explicit regardless of generator: unique index on `videos.slug` plus a bounded retry (3 attempts) on unique-violation, which at 64 bits of entropy will effectively never trigger but must exist so a collision degrades to a retry rather than a 500.

**Decision:** C (`node:crypto` base64url slug in a unique `slug` column)

**Libraries:** —

---

## TD-09: Video Delivery — Streaming and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Two capabilities share one delivery mechanism. Streaming requires HTTP Range/206 support so the player can start on the first bytes and seek without fetching the whole file; download requires the same object served with `Content-Disposition: attachment`. This is the read-side mirror of TD-04 and defines the response shape the player and download button consume, so it is a single cross-layer contract. The C4 diagram already draws the byte path as `Frontend → Object Storage ("Streams")`, not through the API.

**Options:**

### Option A: Presigned GET URLs returned in the video's metadata response
- `GET /videos/{slug}` returns the video's data plus `streamUrl` and `downloadUrl` (the latter presigned with `ResponseContentDisposition=attachment; filename="…"`) and an `expiresAt`. The `<video>` element points at `streamUrl`; storage serves Range/206 natively.
- **Pros:** Zero bytes through the API — the C4 byte path exactly. Range/206, conditional requests and caching headers are handled by the storage layer, which already implements them correctly; nothing to reimplement. `ResponseContentDisposition` gives the download a proper filename without a second code path. Trivially CDN-frontable later. One round-trip: metadata and playback URL arrive together.
- **Cons:** The URL is a bearer capability — anyone it is shared with can fetch the object until it expires, and it cannot be revoked before then. TTL must be long enough for a full watch session yet short enough to bound sharing, and the client must refetch metadata when `expiresAt` passes mid-session. The storage endpoint (and its hostname) is exposed to the browser.

### Option B: The API proxies the byte stream with its own Range handling
- `GET /videos/{slug}/stream` reads the object and pipes it through the NestJS process, parsing the `Range` header and returning 206 with the right `Content-Range`.
- **Pros:** A stable, permanent URL under the API's own domain. Every request passes through the auth layer, so per-request authorization, view counting and revocation are straightforward. Storage stays completely hidden from the browser.
- **Cons:** Every streamed byte crosses the API — the same load problem TD-04 rejected, now on the read side and multiplied by concurrent viewers, which is the dominant traffic of a video platform. Requires hand-implementing Range parsing, 206/416 semantics and caching headers that storage already provides. Contradicts the C4 diagram. Makes the API the bandwidth bottleneck and blocks CDN offload.

### Option C: Stable API route that 302-redirects to a freshly signed URL
- `GET /videos/{slug}/stream` authorizes, signs a short-lived URL and returns `302 Location: <presigned>`. Download is the same with a `Content-Disposition` override.
- **Pros:** Keeps a permanent, shareable, authorizable URL under the API domain while the bytes still come from storage. The signed URL's TTL can be very short because it is minted per request. A natural place to hook view counting and, later, unlisted/private checks.
- **Cons:** Every Range request may re-hit the API — browsers do not uniformly reuse the redirect target for subsequent range requests on a media element, so seek-heavy playback can produce a redirect per range. Redirect-following behavior across `<video>` implementations is less predictable than a direct URL. More moving parts than A for a benefit (revocability) that Phase 03 does not yet need.

**Recommendation:** **Option A (presigned GET URLs in the metadata response)** — it matches the C4 byte path, and it inherits correct Range/206 semantics from the storage layer rather than reimplementing them, which is the substantive engineering argument: Range, `Content-Range`, 416 and conditional-request handling are easy to get subtly wrong and are already solved on the other side of the presign. Option B is rejected on the same performance grounds as TD-04 Option C, amplified by read traffic. Option C's revocability buys nothing in Phase 03 — every video in this phase is anonymously watchable per `docs/project-plan.md`, and `unlisted`/private visibility is a Fase 04 capability; when that lands, moving to C is a change to one endpoint, not a redesign. Suggested shape: playback TTL sized to a long watch session (a few hours), `expiresAt` returned so the client can refetch, and `downloadUrl` presigned separately with `ResponseContentDisposition` set from the video title.

**Decision:** A (Presigned GET URLs returned in the video's metadata response)

**Libraries:** —

---

## TD-10: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is created *before* its bytes exist ("pré-cadastro automático como rascunho ao iniciar o upload"), then mutated asynchronously by a worker that may fail. The schema needs to represent "uploading", "being processed", "ready" and "failed" unambiguously, and the pipeline needs a defined behaviour for a job that throws. This model is consumed by the upload endpoints (TD-04), the worker (TD-05), the delivery endpoints (TD-09, which must refuse to serve a video with no bytes), and — importantly — by Fase 04's management panel, whose bullet lists **status** as a displayed column and whose "Fluxo de rascunho → publicação" is a *different* concept from processing state.

**Options:**

### Option A: One `status` enum covering both processing and publication
- `videos.status`: `draft → uploading → processing → ready | failed`; Fase 04 later adds `published`.
- **Pros:** Single column, single source of truth, simplest queries and simplest UI mapping. Directly mirrors the capability bullet's wording ("como rascunho"). One state machine to test.
- **Cons:** **Conflates two orthogonal axes.** A fully processed video that its owner has not yet published must be `ready` *and* `draft` at the same time — unrepresentable in one column. Fase 04 would have to either add a second column anyway or overload the enum with combined states (`ready_draft`, `ready_published`), which multiplies states and invites invalid transitions. Publication is user-driven; processing is system-driven — merging them makes it impossible to express "publish when processing finishes".

### Option B: A processing-lifecycle column owned by Phase 03, orthogonal to a publication column owned by Fase 04
- `videos.processing_status`: `awaiting_upload → processing → ready | failed`, plus `processing_error text null` for the last failure. Publication state (`draft`/`published`, visibility) is a separate column introduced by Fase 04 and out of scope here.
- **Pros:** The two axes stay independent and each has one owner, so Fase 04 adds a column instead of migrating an enum's meaning. "Rascunho" is satisfied at the semantic level: a video whose processing has not reached `ready` is not publishable, which is exactly what the pre-registration bullet asks for. `processing_error` gives the panel and the logs a concrete failure reason. Queries stay simple and each state machine is small enough to test exhaustively.
- **Cons:** Two columns instead of one, and the UI must combine them to show a single user-facing label. Slightly more up-front modelling for a benefit that only fully pays off in the next phase.

### Option C: Derive status from data presence, with a separate `video_jobs` table
- No status column: a video is "ready" if duration and thumbnail key are non-null; job attempts and errors live in their own table.
- **Pros:** No enum to migrate; state cannot drift from reality because it *is* reality. Full per-attempt audit history.
- **Cons:** Cannot distinguish "never started" from "in progress" from "failed" without joining the jobs table on every listing query — the exact query Fase 04's panel runs. Duplicates state the queue (TD-03) already tracks. Derived predicates are re-implemented at every call site and drift.

**Recommendation:** **Option B (dedicated processing-status column, orthogonal to Fase 04's publication state)** — the deciding argument is representability, not style: with Option A a processed-but-unpublished video has no valid single state, and Fase 04's own bullets require both concepts to coexist. Option B lets Phase 03 own exactly one axis and hand Fase 04 a clean seam. Option C makes the listing query in Fase 04's panel unnecessarily expensive. Accompanying failure model, all of which the chosen queue (TD-03) supplies directly: `jobId = videoId` so a duplicated enqueue is deduplicated rather than processed twice; `attempts: 3` with exponential backoff for transient failures (storage or network); on final failure the worker sets `processing_status = 'failed'` and persists a redacted `processing_error` (never the presigned URL from TD-07); the worker is idempotent so a retry after a partial run simply overwrites the thumbnail and metadata; `failed` is terminal-but-re-drivable through an explicit re-enqueue; and a periodic reconciliation sweep re-enqueues rows stuck in `processing` past a threshold, covering the lost-enqueue window that TD-03's recommendation identifies.

**Decision:** B (Dedicated `processing_status` column, orthogonal to Fase 04's publication state)

**Libraries:** —

---

## TD-11: Thumbnail Frame-Selection Strategy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** TD-06 decides *how* FFmpeg is invoked (direct spawn vs. a wrapper library), but not *which* frame of the video becomes the thumbnail. A poorly chosen frame — a black leader frame, the very first frame before content starts, or a frame past the end of a short clip — produces a low-quality or broken thumbnail, directly visible on every video card across the platform. This is a separate strategic choice from TD-06's invocation mechanism and needs its own trade-off analysis.

**Options:**

### Option A: Fixed proportional offset (e.g., 10% of duration, floored to a small minimum)
- After `ffprobe` reports duration (already fetched by the same pipeline, per TD-05/TD-06), compute `t = max(duration * 0.10, 1s)` and extract with `ffmpeg -ss t -i <input> -frames:v 1 -q:v 2 <out.jpg>`.
- **Pros:** Deterministic and cheap — a single seek plus a single frame decode, no extra passes over the file. Scales with video length: avoids grabbing frame 0 (often black/blank) on any video, and avoids seeking past the end on very short clips because the offset is proportional, not absolute. Reuses the exact invocation shape TD-06 Option A already builds — no new FFmpeg filter to learn or test.
- **Cons:** Purely positional — a fixed 10% mark can still land on a transition frame, a black frame, or an unrepresentative moment (e.g., a title-card fade). No quality signal is used; it is a heuristic, not a "best frame" search.

### Option B: Fixed absolute timestamp (e.g., always the frame at 00:00:03)
- `ffmpeg -ss 3 -i <input> -frames:v 1 -q:v 2 <out.jpg>` regardless of duration.
- **Pros:** Simplest possible implementation — one constant, no dependency on `ffprobe`'s duration value being available first.
- **Cons:** Breaks on any video shorter than the constant (a 2-second clip has no frame at 3s — `ffmpeg` either errors or clamps to the last frame, an edge case that must be special-cased anyway). No proportionality: a 3-second mark is early on a 2-hour video and does not scale across the range of upload lengths this phase must support.

### Option C: FFmpeg `thumbnail` video filter (histogram-based "most representative frame")
- `ffmpeg -i <input> -vf "thumbnail=N,scale=...:..." -frames:v 1 <out.jpg>` — analyzes a batch of `N` consecutive frames and picks the one whose color histogram is most representative of the batch, repeating until the batch is exhausted. Official default `N` is 100.
- **Pros:** Purpose-built for this exact problem; the closest thing to a "smart" thumbnail without a full computer-vision pipeline. Naturally skips solid-color/black frames within the analyzed batch.
- **Cons:** The filter must decode and buffer every frame in the batch before picking one — the FFmpeg docs themselves warn that a bigger `N` increases memory usage. For a 10GB / potentially multi-hour video, covering more than the first `N` frames means either chaining batches across the whole file (multiplying decode cost) or accepting that only an early segment of the video is ever considered. Slower and heavier than a single seek, for an operation that runs on every upload under this phase's own "sem impacto na performance" constraint.

**Recommendation:** **Option A (fixed proportional offset)** — it is the cheapest operation (one seek, one frame decode) while still solving Option B's short-video failure mode, matching the phase's performance constraint (`phase-03-videos/TD-04`, AMB-1). Option C's per-upload cost (decoding up to 100 frames, or more for full-file coverage) is disproportionate for a background job that already competes for worker capacity under TD-05, for a quality gain that is marginal versus a well-chosen proportional offset. Nothing prevents revisiting Option C later as a quality improvement once the pipeline is live and thumbnail quality is measured against real uploads.

**Decision:** A (Fixed proportional offset, e.g. 10% of duration, floored to a small minimum)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object Storage Client Library | **A** (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) | A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, custom provider) |
| TD-02 | Backend | Bucket Topology and Object Key Layout | **A** (single bucket, `videos/{videoId}/…`, keyed by UUID) | A (single bucket, `videos/{videoId}/…`, keyed by UUID) |
| TD-03 | Backend | Background Job Queue Technology | **A** (BullMQ + Redis via `@nestjs/bullmq`) | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-04 | Cross-layer | Large-File Upload Protocol (up to 10GB) | **A** (S3 multipart with presigned part URLs) | A (S3 multipart with presigned part URLs) |
| TD-05 | Backend | Video Worker Topology and Runtime | **A** (same codebase, separate worker container) | A (same codebase, separate worker container) |
| TD-06 | Backend | FFmpeg / FFprobe Invocation Approach | **A** (direct `spawn` behind a typed service) | A (direct `spawn` behind a typed service) |
| TD-07 | Backend | Worker Access to the Source Object | **A** (presigned GET URL read over HTTP Range) | A (presigned GET URL read over HTTP Range) |
| TD-08 | Backend | Unique Public Video URL Strategy | **C** (`node:crypto` base64url slug + unique index) | C (`node:crypto` base64url slug + unique index) |
| TD-09 | Cross-layer | Video Delivery — Streaming and Download | **A** (presigned GET URLs in metadata response) | A (presigned GET URLs in metadata response) |
| TD-10 | Backend | Video Status Lifecycle and Failure Handling | **B** (processing-status column, orthogonal to publication) | B (processing-status column, orthogonal to publication) |
| TD-11 | Backend | Thumbnail Frame-Selection Strategy | **A** (fixed proportional offset, e.g. 10% of duration) | A (fixed proportional offset, e.g. 10% of duration) |

---

## Notes for downstream pipeline

- **Monolithic phase — `covers_capabilities` deliberately omitted.** This is the only `scope_type: phase` document for Fase 03 and it covers all nine capability bullets, so the frontmatter keeps monolithic semantics. Every bullet is claimed by at least one TD: storage service → TD-01/TD-02; filas → TD-03; upload 10GB → TD-04; pré-cadastro → TD-10; processamento/metadados → TD-05/TD-06/TD-07/TD-10; thumbnail → TD-06/TD-11; URL única → TD-08; streaming → TD-09; download → TD-09.
- **`Scope` field and Tech Specs rendering.** No TD is marked `Repo-wide`, deliberately: `Repo-wide` TDs do not render in any Tech Specs subsection downstream, and every decision here needs to reach Data Model, API Contracts or Events/Messages. The Compose additions (`redis`, `minio`, `video-worker`) are consequences of TD-01/TD-03/TD-05 rather than a separate infra decision, so they travel with those `Backend` TDs.
- **`### Events/Messages` will be required in the plan.** TD-03 introduces the first queue in the project, so the phase plan needs the Events/Messages Tech Specs subsection (payload, producer, consumer, trigger, delivery semantics) for the video-processing job. TD-10's `jobId`/retry/backoff parameters are the delivery-semantics content.
- **Dependency chain between TDs** (matters for `/plan-resolve` if a recommendation is rejected):
  - TD-04 and TD-09 both assume TD-01's presigner. Choosing TD-01 Option B (`minio` client) does not invalidate them but changes the presign API surface.
  - TD-05 Option A is what makes TD-03 Option A's DI ergonomics decisive. If TD-05 swings to Option C (standalone app), TD-03's argument weakens and pg-boss becomes comparably attractive.
  - TD-07 depends on TD-01 (presigned GET) and feeds TD-06's command construction.
  - TD-10's retry/idempotency parameters are expressed in the vocabulary of TD-03 Option A (`jobId`, `attempts`, `backoff`). If TD-03 swings to pg-boss, the same concepts map to `singletonKey`, `retryLimit` and `retryBackoff`, and TD-10's transactional-enqueue caveat disappears.
  - TD-02's UUID-based keys exist to keep TD-08's slug changeable. Choosing TD-08 Option A (UUID as public URL) makes that decoupling moot but harmless.
- **New dependencies implied by the decided set** (pinned with versions by `/plan-resolve` into `library-refs.md`): `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (TD-01, custom provider — Option C's community wrapper was explored and rejected, see TD-01's **Note**), `bullmq`, `@nestjs/bullmq`, `ioredis` (TD-03). No FFmpeg npm package (TD-06 A) and no id-generation package (TD-08 C) — both use the Node standard library. TD-11 (thumbnail frame-selection) also introduces no new dependency — it only changes the `-ss` value passed to the same `ffmpeg` invocation TD-06 already builds. Dev/test additions likely: `aws-sdk-client-mock`.
- **New Compose services implied:** `redis` (TD-03 A), `minio` + a one-shot `mc` bucket-provisioning service (TD-01/TD-02), and `video-worker` built from `Dockerfile.worker` (TD-05 A). Per the repo's Docker networking rule, all hosts are Compose service names (`minio`, `redis`), never `localhost`.
- **New env keys implied:** `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `REDIS_HOST`, `REDIS_PORT`, upload part size and the three presign TTLs (upload part / playback / worker read). These must land in `.env.example` and in the Joi schema at `src/config/env.validation.ts` (per `technical-decisions-phase-01-configuracao-base.md` TD-02).
- **FE↔BE contract typing is already decided elsewhere — do not open a new TD for it.** `docs/decisions/technical-decisions-next-frontend-openapi-typing.md` establishes OpenAPI-generated types as the single source of truth for every wire shape. The upload handshake (TD-04) and delivery response (TD-09) are new contracts that must therefore be fully described in the NestJS Swagger decorators so they reach `openapi.json`; no shape is hand-transcribed on the frontend. If `plan-validate` raises a shared-types `MD-N` for this phase, that existing document is the answer.
- **No UI in this phase.** Fase 03 has no screen bullet, so `plan-context` should run with `ui_in_scope: false` and no `## UI Inventory` section, matching `docs/phases/phase-02-auth/context.md`.
- **Out of scope, deliberately, with a pointer:** transcoding to multiple resolutions/bitrates (an ABR ladder) is not a Fase 03 capability — the phase asks only for metadata extraction and a thumbnail. TD-05's separate worker container and TD-03's queue are the seams where a transcode job would later attach. Video metadata *editing*, categories, visibility and the management panel are Fase 04; the player UI is Fase 05.
- **Documentation deltas deferred to implementation:** the C4 diagram's `Message Queue "TBD"` label and a videos/storage section in `nestjs-project/CLAUDE.md` should be updated by the implementation phase, once the code they describe exists.

---

Sources consulted during research:

- [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) and [Uploading objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html) — single `PutObject` capped at 5 GB; multipart parts 1–10 000, 5 MiB–5 GiB each. This is what eliminates the single presigned-PUT option in TD-04.
- [`@aws-sdk/s3-request-presigner` README](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md) and the [S3 multipart e2e lifecycle](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/test/e2e/S3.e2e.spec.ts) (via context7) — confirms `getSignedUrl(client, command, { expiresIn })` presigns arbitrary commands including `UploadPart`, and the `CreateMultipartUpload → UploadPart → ListParts → CompleteMultipartUpload → AbortMultipartUpload` sequence used in TD-04.
- [BullMQ NestJS guide](https://docs.bullmq.io/guide/nestjs.md) and [retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs.md) (via context7) — `@Processor` + `WorkerHost`, `BullModule.registerQueue`, `attempts`/`backoff`/custom `jobId`; underpins TD-03 and TD-10.
- [pg-boss README](https://github.com/timgit/pg-boss/blob/master/README.md) — `SKIP LOCKED`, exactly-once delivery, dead-letter queues, retries with exponential backoff, transactional enqueue; the basis for TD-03 Option C and for the honest statement of what Option A gives up.
- [tus Node.js server 2.0](https://tus.io/blog/2025/03/25/tus-node-server-v200) and [tus-node-server](https://github.com/tus/tus-node-server) — `@tus/server` + `@tus/s3-store` maturity and the fact that bytes traverse the Node process; TD-04 Option B.
- [fluent-ffmpeg on npm](https://www.npmjs.com/package/fluent-ffmpeg) and ["Phasing out fluent-ffmpeg"](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324) — package deprecated, repository archived 2025-05-22, maintainers state it no longer works properly with recent FFmpeg versions; decisive for TD-06.
- [FFmpeg `thumbnail` video filter docs](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/thumbnail.html) — histogram-based "most representative frame" selection over a batch of `N` frames (default 100), explicit memory-usage warning for larger `N`; basis for TD-11 Option C and its rejection.
- [MinIO removes management features from Community Edition](https://blocksandfiles.com/2025/06/19/minio-removes-management-features-from-basic-community-edition-object-storage-code/) and [minio/minio#21584](https://github.com/minio/minio/issues/21584) — admin console removed from CE, AGPLv3 relicensing; informs TD-01's vendor-neutrality argument and TD-02's CLI-based bucket provisioning note.
- npm registry (`npm view`) — installed/latest versions checked against `nestjs-project/package.json`: `bullmq` 5.81.2, `@nestjs/bullmq` 11.0.4 (aligned with the installed NestJS 11), `pg-boss` 12.26.3, `@aws-sdk/client-s3` 3.1095.x, `minio` 8.0.7, `@tus/server` 2.4.2, `nanoid` 6.0.0 (`"type": "module"`, ESM-only — the constraint in TD-08) with `nanoid@3.3.16` as the last CJS line.
- Repo constraints consumed as fixed: `docs/diagrams/software-arch.mermaid` (worker/queue/storage containers and the `Frontend → Object Storage` byte path), `docs/project-plan.md` §4 (10GB, resumable, short unique URLs, streaming without full download), `docs/decisions/technical-decisions-phase-01-configuracao-base.md` (config via `registerAs`, Joi env validation), `docs/decisions/technical-decisions-phase-02-auth.md` (error contract, guards), `.claude/rules/nestjs-entities.md` (UUID PKs, explicit table names, migrations), and `nestjs-project/tsconfig.json` (`module: nodenext` → CommonJS output).
