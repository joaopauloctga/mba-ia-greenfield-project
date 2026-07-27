# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/13 completed

### SI-03.1 — Dependencies, Storage/Queue Configuration Namespaces, and Docker Compose Infrastructure
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Wired `storage.config.ts` + `queue.config.ts` into `app.module.ts`'s global `ConfigModule.forRoot({ load: [...] })` array — not explicitly listed in the SI's Technical actions, but required for `@Inject(storageConfig.KEY)`/`@Inject(queueConfig.KEY)` to resolve later (SI-03.3/SI-03.4), matching the repo's existing pattern (every other `registerAs` namespace is loaded there, e.g. `authConfig`).
  - Added `redis`/`mc` to `nestjs-api`'s `depends_on` in `compose.yaml` (not explicitly requested) since the API will consume both once SI-03.3/SI-03.4 land; mirrors the existing `db`/`mailpit` `depends_on` pattern.
  - Extended `env.validation.integration-spec.ts`'s `requiredEnv` fixture with the new required S3/Redis keys so the pre-existing test keeps passing — required collateral fix, not scope creep.
  - Deferred TD-02's recommended `AbortIncompleteMultipartUpload` MinIO lifecycle rule on the `mc` one-shot service — not in this SI's Technical actions/AC (which only require bucket provisioning), and the exact `mc ilm` flag syntax isn't verifiable via context7 (not an npm library); revisit if a future SI needs it.
  - `S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`REDIS_HOST` made Joi-required (no default); `S3_ENDPOINT`/`S3_REGION`/`S3_FORCE_PATH_STYLE`/`REDIS_PORT` default, mirroring the existing `DB_*` required-vs-defaulted split in `env.validation.ts`.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 5 passing (`src/videos/entities/video.entity.integration-spec.ts`)
- **Observations:**
  - Created `src/videos/videos.module.ts` (bare `TypeOrmModule.forFeature([Video])`) and registered it in `app.module.ts` — not in the SI's Technical actions, but required: adding `Channel`'s inverse `@OneToMany` to `Video` (an explicit Technical action) makes TypeORM's metadata builder require `Video` to be loaded into the app's entity graph, and per `.claude/rules/nestjs-modules.md` every entity must be registered via `forFeature` in its owning module. Without it, `autoLoadEntities` never picks up `Video` and the real app fails to boot with `Entity metadata for Channel#videos was not found`. SI-03.5 will extend this module with the controller/service rather than creating it from scratch.
  - Added `Video` to the entity arrays of 12 pre-existing test files (`*.module.spec.ts`, `*.service.integration-spec.ts`, `*.entity.integration-spec.ts` across `auth/`, `channels/`, `users/`, `database/`) and to `cleanAllTables()` in `src/test/create-test-data-source.ts` — same root cause as above: any `createTestDataSource(...)` call that includes `Channel` but not `Video` hit the identical metadata error. Verified via full-suite run: all previously-passing suites still pass.
  - Ran `npm run lint` scoped to every file this SI touched (new + patched) — all clean. The full-repo `npm run lint` has ~190 pre-existing problems in unrelated files (mail service, exception filters, `auth.e2e-spec.ts`, etc.) predating this SI; left untouched per scope limits.
  - Full-suite run (`npm test -- --runInBand`) surfaced one unrelated pre-existing failure: `src/database/migrations.integration-spec.ts › should apply all migrations and create all four tables` fails with `type "verification_tokens_type_enum" already exists`. Root cause: that spec's `beforeAll` drops the 4 managed tables + `migrations` tracking table but never drops the Postgres enum type `CreateAuthTokens`'s `up()` creates, so once the type exists in the shared dev DB (it has since a migration run in April, well before this session) any full run of that file fails on the first `CREATE TYPE`. Unrelated to `Video`/`Channel` — not touched, per scope limits; flagging for a separate fix.

### SI-03.9 — FfmpegService (Metadata Extraction and Thumbnail Frame Extraction)
- **Status:** completed
- **Tests:** 5 passing (`src/ffmpeg/ffmpeg.service.spec.ts`)
- **Observations:**
  - No npm library added — TD-06 chose direct `child_process.spawn` over `fluent-ffmpeg`, so `getMetadata`/`extractThumbnail` share a private `run()` helper collecting stdout/stderr as `Buffer`s and rejecting with a custom `FfmpegProcessError` (exit code + stderr) on non-zero exit, per the SI's acceptance criteria.
  - Did not register `FfmpegModule` in `app.module.ts` — unlike `VideosModule` in SI-03.2, there's no TypeORM entity-metadata requirement forcing early registration; the only consumer (`WorkerModule`) is SI-03.10, not yet implemented. Matches the SI's Technical actions, which don't list an `app.module.ts` change.
  - No `FfmpegModule` compilation test — per `testing-guide-nestjs-project`'s `artifacts/modules.md`, a module with only local providers and no configured imports (TypeORM, JWT, Bull, etc.) skips the module test; matches the SI's Tests table, which lists only `FfmpegService`.

### SI-03.3 — StorageModule (S3 Client Provider, Key Builder, and Presign Helpers)
- **Status:** completed
- **Tests:** 5 passing (`src/storage/storage.module.spec.ts`, `src/storage/storage.service.integration-spec.ts`)
- **Observations:**
  - Added `src/storage/storage.constants.ts` exporting the `S3_CLIENT` DI token string — not an explicit Technical action, but needed so both `storage.module.ts` (provider) and `storage.service.ts` (`@Inject`) reference the same token without a magic-string duplication; mirrors the repo's `<module>.constants.ts` convention (`auth.constants.ts`, `mail.constants.ts`), even though those hold business constants rather than DI tokens — no existing precedent for a token file, so this establishes one.
  - Did not create a `listParts` method on `StorageService` even though the plan's `POST /videos/uploads/:videoId/complete` API Contract (SI-03.7) says `completeUpload` "compares `dto.parts` against storage's `ListParts`" — SI-03.3's Technical actions list only `createMultipartUpload`/`presignUploadPart`/`completeMultipartUpload`/`abortMultipartUpload`/`presignGetUrl`/`putObject`; `listParts` isn't among them. Left for SI-03.7 to add when its own Technical actions call for it.
  - `presignUploadPart` and the default branch of `presignGetUrl` use a 3600s presign expiry (no TD or AC pins an exact value for these two); `presignGetUrl` accepts an optional `expiresIn` override for callers that need a different TTL (e.g., SI-03.12's playback delivery).
  - Integration spec bundles the key-builder assertions (`buildObjectKey`/`buildThumbnailKey`) into `storage.service.integration-spec.ts` rather than a separate unit spec — the SI's Tests table lists only one `StorageService` row (Integration) covering "key builder shape, multipart create/complete/abort round trip, presigned URL is fetchable" as a single artifact, so no separate `.spec.ts` was created for the pure-logic key builders.

### SI-03.4 — QueueModule (BullMQ Registration)
- **Status:** completed
- **Tests:** 1 passing (`src/queue/queue.module.spec.ts`)
- **Observations:**
  - Added `src/queue/queue.constants.ts` exporting `VIDEO_PROCESSING_QUEUE = 'video-processing'` — not an explicit Technical action, but the queue name is a literal the SI's own description says future SIs (VideosService producer, VideoProcessor consumer) will reuse; centralizing it now avoids duplicating the string literal per `.claude/rules/nestjs-common-conventions.md` ("Never duplicate string literals across files"). Mirrors the `S3_CLIENT` token precedent from SI-03.3.
  - No `defaultJobOptions` (`attempts: 3`, exponential backoff) set on `BullModule.registerQueue()` — the SI's Technical action doesn't call for it, and per the plan's API Contracts (`POST .../complete`), those options are passed per-call at `queue.add(...)` time in SI-03.7's `VideosService.completeUpload`, not baked into the queue registration.
  - Did not add a dedicated test proving the AC "module fails to compile if `REDIS_HOST`/`REDIS_PORT` are absent" — the SI's Tests table lists only one row (compilation + injectable queue), and that AC explicitly delegates to SI-03.1's Joi validation, already covered by `env.validation.integration-spec.ts`.

### SI-03.5 — Upload Initiation Endpoint (POST /videos/uploads)
- **Status:** completed
- **Tests:** 7 passing (`src/videos/videos.service.spec.ts`, `src/videos/videos.service.integration-spec.ts`, `test/videos.e2e-spec.ts`)
- **Observations:**
  - Added `ChannelsService.findByUserId(userId)` — not an explicit Technical action, but necessary: the SI's own signature `VideosService.initiateUpload(channelId, dto)` requires the controller to resolve `channelId` from the JWT payload's `sub` (userId), and no existing mechanism did this. Per CLAUDE.md's Single Responsibility principle, this lookup belongs in `ChannelsService` (its own domain), not in `VideosService`/`VideosController`. Uses `findOneByOrFail` (not a new domain exception) since every authenticated user is guaranteed a channel at registration (`UsersService` → `ChannelsService.createChannel`), making a miss a genuine invariant violation rather than a user-facing error case.
  - The video's `id` (UUID PK) is generated client-side via `randomUUID()` *before* the insert, so the object key (`videos/{id}/source{ext}`, TD-02) can be computed ahead of the draft row's creation — matches TD-02/TD-10 ("slug minted at draft pre-registration") rather than a two-step insert-then-patch of `object_key`.
  - Wired `StorageModule` and `ChannelsModule` into `VideosModule` for the first time — neither had been imported by any consumer yet (SI-03.3/SI-03.1 only registered them standalone).
  - Response fields (`videoId`, `slug`, `uploadId`, `partSize`) use camelCase per the SI's Technical actions prose and the `videos.plan.md` E2E spec (scenario `initiate-upload-success`), even though the Tech Specs' API Contracts table rendered them snake_case (`video_id`, `upload_id`, `part_size`). Confirmed the codebase has no enforced global casing convention (auth's OAuth2-style token fields are snake_case, error envelopes are camelCase), so the more concrete, testable sources (SI prose + spec) were treated as authoritative over the prose table.
  - `test/videos.e2e-spec.ts` is shared across 5 SIs per its spec frontmatter (`si: SI-03.5, SI-03.6, SI-03.7, SI-03.8, SI-03.12`). This SI authored only the Group 1 (Upload Initiation) scenarios; the file will be extended incrementally as each dependent SI (parts issuance, completion, abort, public delivery) is implemented.
  - Followed a single flat `describe()` block with a `// Group 1: ...` comment marker (per the `/implement` skill's Step 3a cardinality rule for spec-derived E2E files) rather than nesting a `describe()` per resource, which is how the pre-existing `auth.e2e-spec.ts` is structured — that file predates the spec-driven authoring convention.

### SI-03.10 — Video Worker Bootstrap (Headless NestJS Worker and Dockerfile.worker)
- **Status:** completed
- **Tests:** 1 passing (`src/worker.module.spec.ts`)
- **Observations:**
  - `WorkerModule` registers `TypeOrmModule.forRootAsync` directly (not by importing `VideosModule`), since importing any domain module would also pull in its controller — the SI's own AC explicitly requires the worker image to exclude HTTP controllers/guards. No `TypeOrmModule.forFeature([...])` is registered yet because this SI has no consumer of any entity repository; SI-03.11 (Video Processor) will add `forFeature([Video])` directly to `WorkerModule` when it needs repository access.
  - `WorkerModule`'s `ConfigModule.forRoot` reuses the full `envValidationSchema` (same Joi schema as `AppModule`) rather than a worker-specific subset — the worker shares the same `.env` file per the SI's own Technical action ("sharing the same env file as nestjs-api"), so every required key is already present, and reusing the schema gives the worker the same fail-fast behavior as the API instead of booting silently with a missing S3/Redis var.
  - `Dockerfile.worker` mirrors `Dockerfile.dev`'s bind-mount development model (no `COPY`/build step baked into the image; `.`. is bind-mounted at `/home/node/app` in `compose.yaml`) rather than a production multi-stage build — consistent with how `nestjs-api` itself is run in this repo. Its `CMD` runs the compiled `node dist/main.worker.js` directly (unlike `nestjs-api`'s idle `tail -f /dev/null`), since the worker has no interactive dev workflow — it's meant to run continuously, not be `exec`'d into for `start:dev`.
  - Verified manually (not by an automated test, since this AC is Docker-level, not a Jest concern): rebuilt `dist/`, built the `video-worker` image, ran `docker compose up -d video-worker` — container stays up (not crash-looping), `docker compose exec video-worker ffmpeg -version` and `ffprobe -version` both succeed, and the boot log shows only `WorkerModule`/`TypeOrmModule`/`QueueModule`/`FfmpegModule`/`StorageModule`/`BullModule` initializing — no `RoutesResolver` or controller mapping, confirming no HTTP surface ships in this image.

### SI-03.12 — Public Video Delivery Endpoint (GET /videos/:slug)
- **Status:** completed
- **Tests:** 6 passing (`src/videos/videos.service.spec.ts`, adding to existing file), 2 passing (`src/videos/videos.service.integration-spec.ts`, adding to existing file), 5 passing (`test/videos.e2e-spec.ts`, adding to existing file) — 13 total across the three files, all runs green on the first attempt
- **Observations:**
  - Added `VideoNotFoundException` (404) and `VideoNotReadyException` (409) to `common/exceptions/domain.exception.ts` — necessary collateral matching the Error Catalog's `VIDEO_NOT_FOUND`/`VIDEO_NOT_READY` codes; no existing exception covered these.
  - `VideoDeliveryInfo.durationSeconds` is typed `number` (non-nullable) even though the entity column `duration_seconds` is nullable; the service asserts it (`video.duration_seconds as number`) because a `ready` video is guaranteed to have it populated by the worker (SI-03.11, not yet built) before the status flips to `'ready'` — matches the Tech Spec's API Contract, which also types it as a plain `number`.
  - Introduced a local `DELIVERY_URL_EXPIRES_SECONDS = 3600` constant in `videos.service.ts` rather than a new env-configurable TTL — the phase's decisions doc anticipated three distinct presign TTLs (upload-part/playback/worker-read) but none were ever added as env keys in SI-03.1; both the stream and download presigns share this same constant, and `expiresAt` is computed once from it so the two URLs provably share the same expiry instant.
  - Response fields (`id`, `slug`, `durationSeconds`, `streamUrl`, `downloadUrl`, `expiresAt`) use camelCase, same rationale as SI-03.5: the SI's Technical action prose and the `videos.plan.md` E2E spec (scenario `get-delivery-ready-success`) both use camelCase, even though the Tech Specs' API Contracts table rendered them snake_case.
  - Refactored `videos.service.integration-spec.ts` to extract a shared `createVideosTestModule()` helper (mirrors `auth.service.integration-spec.ts`'s `createAuthTestModule()` pattern) so the new `getDeliveryInfo` describe block doesn't duplicate the full NestJS test-module bootstrap inline.
  - Extended `test/videos.e2e-spec.ts` with the Group 5 (Public Delivery) scenarios from `videos.plan.md`. Seeds `User`+`Channel`+`Video` directly via TypeORM repositories rather than through the register/login HTTP flow, since the endpoint is anonymous and no caller identity/ownership is relevant to this delivery check — only a valid `channel_id` FK is needed on the seeded `Video` row.

### SI-03.6 — Part-URL Issuance Endpoint (GET /videos/uploads/:videoId/parts)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.11 — Video Processor (Job Consumer: Metadata, Thumbnail, and Status Update)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Upload Completion Endpoint (POST /videos/uploads/:videoId/complete)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Upload Abort Endpoint (DELETE /videos/uploads/:videoId)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.13 — Reconciliation Sweep for Stuck Processing Jobs
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
