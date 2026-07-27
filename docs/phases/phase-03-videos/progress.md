# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/13 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.4 — QueueModule (BullMQ Registration)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Upload Initiation Endpoint (POST /videos/uploads)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Video Worker Bootstrap (Headless NestJS Worker and Dockerfile.worker)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.12 — Public Video Delivery Endpoint (GET /videos/:slug)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
