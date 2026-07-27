# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/13 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — FfmpegService (Metadata Extraction and Thumbnail Frame Extraction)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
