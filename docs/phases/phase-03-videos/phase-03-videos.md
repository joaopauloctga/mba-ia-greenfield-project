---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-26T00:00:16-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-26T00:01:23-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-25T23:59:59-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-20T17:14:42-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video upload and processing pipeline — resumable S3 multipart upload for files up to 10GB with automatic draft pre-registration, background metadata extraction and thumbnail generation via a dedicated FFmpeg worker, unique short public URLs, and streaming/download delivery — establishing the storage and processing foundation that video management (Fase 04) and playback (Fase 05) build on.

---

## Step Implementations

### SI-03.1 — Dependencies, Storage/Queue Configuration Namespaces, and Docker Compose Infrastructure

**Description:** Install the new backend dependencies (S3 client, presigner, BullMQ, Redis client), add `registerAs` configuration namespaces for storage and the queue, extend Joi env validation, and add the `redis`, `minio`, and one-shot bucket-provisioning services to Docker Compose.

**Technical actions:**
- Run `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner bullmq @nestjs/bullmq ioredis` inside the `nestjs-api` container (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
- Create `src/config/storage.config.ts` — `registerAs('storage', () => ({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }))` per the repo's namespaced-config convention (`phase-01-configuracao-base/TD-03`)
- Create `src/config/queue.config.ts` — `registerAs('queue', () => ({ redisHost, redisPort }))`
- Extend `src/config/env.validation.ts` — add Joi keys `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `REDIS_HOST`, `REDIS_PORT`, and mirror them in `.env.example`
- Add `redis`, `minio`, and a one-shot `mc` bucket-provisioning service to `compose.yaml` — hosts referenced as Compose service names (`redis`, `minio`), never `localhost`, per the repo's Docker networking rule

**Tests:** _(empty — Infra; config/compose changes are verified by container startup and by the modules that consume them in later SIs)_

**Dependencies:** none

**Acceptance criteria:**
- `docker compose up -d` starts `redis` and `minio` alongside the existing services, and the `mc` init service exits 0 after provisioning the bucket
- `nestjs-api` fails to start when a required `S3_*` or `REDIS_*` env var is missing (Joi validation)
- `npx tsc --noEmit` exits 0 after the new config files are added

---

### SI-03.2 — Video Entity and Migration

**Description:** Add the `Video` entity (`videos` table) capturing the draft-through-ready lifecycle, storage keys, and the public slug, plus its migration.

**Technical actions:**
- Create `src/videos/entities/video.entity.ts` — `Video` entity per `## Technical Specifications → Data Model → Video` (columns, relation to `Channel`, indexes) verbatim
- Add the `processing_status` PostgreSQL enum type and the `Video` `@ManyToOne`/`@JoinColumn` relation to `Channel`; add the inverse `@OneToMany` on `Channel`
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideosTable`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, unique `slug`, FK to `channels` | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**
- Inserting a `Video` row without `channel_id` violates the not-null FK constraint
- Inserting two `Video` rows with the same `slug` violates the unique constraint
- A newly-inserted row defaults `processing_status` to `'awaiting_upload'` when the column is omitted
- Migration runs cleanly against an empty database (`npm run migration:run`)

---

### SI-03.3 — StorageModule (S3 Client Provider, Key Builder, and Presign Helpers)

**Description:** Provide a `StorageService` wrapping the AWS SDK v3 `S3Client` (configured for MinIO in dev, real S3 in prod per `phase-03-videos/TD-01`), the object-key builder (`phase-03-videos/TD-02`), and presigning helpers used by every upload/delivery endpoint.

**Technical actions:**
- Create `src/storage/storage.module.ts` — `StorageModule` registering a custom `S3Client` provider via `storageConfig` (`ConfigType<typeof storageConfig>`), following the repo's `registerAs`-based custom-provider pattern
- Create `src/storage/storage.service.ts` — `StorageService` with `buildObjectKey(videoId, ext)` / `buildThumbnailKey(videoId)` (`videos/{id}/source{ext}`, `videos/{id}/thumbnail.jpg` per TD-02), `createMultipartUpload(key)`, `presignUploadPart(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `presignGetUrl(key, opts)` (accepts `ResponseContentDisposition`), and `putObject(key, body)` (for the worker's thumbnail write-back)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: real MinIO — key builder shape, multipart create/complete/abort round trip, presigned URL is fetchable | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**
- `buildObjectKey('abc', '.mp4')` returns `videos/abc/source.mp4`; `buildThumbnailKey('abc')` returns `videos/abc/thumbnail.jpg`
- A multipart upload created via `createMultipartUpload` can be completed with real parts uploaded to MinIO and the resulting object is retrievable
- A presigned URL from `presignGetUrl` successfully fetches the object over plain HTTP before expiry

---

### SI-03.4 — QueueModule (BullMQ Registration)

**Description:** Register the `video-processing` BullMQ queue against the Redis instance (`phase-03-videos/TD-03`), available for both the API (producer) and, later, the worker (consumer).

**Technical actions:**
- Create `src/queue/queue.module.ts` — `QueueModule` with `BullModule.forRootAsync({ useFactory: (config) => ({ connection: { host: config.redisHost, port: config.redisPort } }), inject: [queueConfig.KEY] })` and `BullModule.registerQueue({ name: 'video-processing' })`, exporting the queue for injection in `VideosService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: real BullMQ + test Redis config — module compiles and the queue is injectable | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**
- `QueueModule` compiles and resolves an injectable `Queue` instance named `video-processing`
- The module fails to compile if `REDIS_HOST`/`REDIS_PORT` are absent from config (delegates to SI-03.1's Joi validation)

---

### SI-03.5 — Upload Initiation Endpoint (POST /videos/uploads)

**Route:** POST /videos/uploads
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Authenticated (creates a draft owned by the caller's channel)

**Description:** Implement the endpoint that pre-registers a draft `Video` row and opens an S3 multipart upload, minting the video's public slug.

**Technical actions:**
- Create `src/videos/dto/create-upload.dto.ts` — `CreateUploadDto` with `@IsString() @IsNotEmpty()` `filename` and `@IsString() @IsNotEmpty()` `content_type`
- Create `src/videos/videos.service.ts` — `VideosService.initiateUpload(channelId, dto)`: generate the slug via `randomBytes(8).toString('base64url')` with a bounded 3-attempt retry on unique-violation (`phase-03-videos/TD-08`), build the object key from `filename`'s extension (`phase-03-videos/TD-02`), insert the draft `Video` row (`processing_status = 'awaiting_upload'`), call `StorageService.createMultipartUpload`, persist the returned `upload_id`, return `{ videoId, slug, uploadId, partSize: 64 * 1024 * 1024 }` per `## Technical Specifications → API Contracts → POST /videos/uploads`
- Create `src/videos/videos.controller.ts` — `VideosController` with route prefix `'videos'`, `@Post('uploads')` guarded by the existing JWT access guard (`phase-02-auth`), calling `videosService.initiateUpload()` and returning 201

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: slug generation + collision retry (mock repo) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: draft persisted with `awaiting_upload`, real `CreateMultipartUpload` against MinIO | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**
- `POST /videos/uploads` with a valid body returns 201 with `videoId`, `slug`, `uploadId`, and `partSize`
- The created video row has `processing_status = 'awaiting_upload'` and a non-null `upload_id`
- `POST /videos/uploads` with a missing `filename` or `content_type` returns 400
- A slug collision (forced in test) is retried and does not surface to the caller

---

### SI-03.6 — Part-URL Issuance Endpoint (GET /videos/uploads/:videoId/parts)

**Route:** GET /videos/uploads/:videoId/parts
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Owner

**Description:** Issue a batch of presigned `UploadPart` URLs for a range of part numbers on an open upload session.

**Technical actions:**
- Add `VideosService.getPartUrls(videoId, channelId, from, to)` — load the video, throw `UploadSessionNotFoundException` (404) if missing or not `awaiting_upload`, throw `ForbiddenNotOwnerException` (403) if `channel_id` doesn't match the caller, validate `1 ≤ from ≤ to ≤ 10000` (else `InvalidPartRangeException`, 400), presign one `UploadPart` URL per part number in range via `StorageService.presignUploadPart`
- Add `@Get('uploads/:videoId/parts')` to `VideosController` with `from`/`to` query params (`ParseIntPipe`), returning 200 with `{ parts: [{ partNumber, url, expiresAt }] }` per `## Technical Specifications → API Contracts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPartUrls` | Unit: range validation, not-found, not-owner branches (mock repo) | `src/videos/videos.service.spec.ts` |
| `VideosService.getPartUrls` | Integration: presigned URLs accept real `UploadPart` PUTs against MinIO | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5

**Acceptance criteria:**
- `GET /videos/uploads/:videoId/parts?from=1&to=5` for the owning user returns 200 with 5 presigned part URLs
- The same call for a different authenticated user's own channel returns 403 `FORBIDDEN_NOT_OWNER`
- `from=0` or `to=10001` (or non-numeric) returns 400 `INVALID_PART_RANGE`
- An unknown `videoId` returns 404 `UPLOAD_SESSION_NOT_FOUND`

---

### SI-03.7 — Upload Completion Endpoint (POST /videos/uploads/:videoId/complete)

**Route:** POST /videos/uploads/:videoId/complete
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Owner

**Description:** Finalize the multipart upload and enqueue the video-processing job.

**Technical actions:**
- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `parts: { part_number: number; e_tag: string }[]`, validated with `@ValidateNested({ each: true })`
- Add `VideosService.completeUpload(videoId, channelId, dto)` — ownership + `awaiting_upload` state check (`UploadSessionNotFoundException` / `ForbiddenNotOwnerException` / `UploadAlreadyCompletedException`), compare `dto.parts` against storage's `ListParts` (`PartListMismatchException`, 400, on mismatch), call `StorageService.completeMultipartUpload`, set `processing_status = 'processing'`, enqueue `video.process` on the `video-processing` queue with `jobId: videoId`, `attempts: 3`, exponential backoff (`phase-03-videos/TD-03`, `phase-03-videos/TD-10`)
- Add `@Post('uploads/:videoId/complete')` to `VideosController`, returning 200 with `{ videoId, processingStatus }`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: state validation, part-mismatch branch (mock repo + storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: real `CompleteMultipartUpload`, `processing_status` transition, job visible on the test queue | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**
- `POST /videos/uploads/:videoId/complete` with matching parts/ETags returns 200 with `processing_status: "processing"` and enqueues exactly one `video.process` job with `jobId = videoId`
- Calling `complete` twice for the same session returns 409 `UPLOAD_ALREADY_COMPLETED` on the second call
- Submitting parts/ETags that don't match storage's `ListParts` returns 400 `PART_LIST_MISMATCH`
- A non-owner caller returns 403 `FORBIDDEN_NOT_OWNER`

---

### SI-03.8 — Upload Abort Endpoint (DELETE /videos/uploads/:videoId)

**Route:** DELETE /videos/uploads/:videoId
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Owner

**Description:** Cancel an in-progress upload, releasing the multipart upload and removing the draft row.

**Technical actions:**
- Add `VideosService.abortUpload(videoId, channelId)` — ownership + `awaiting_upload` state check (same exceptions as SI-03.7), call `StorageService.abortMultipartUpload`, delete the draft `Video` row
- Add `@Delete('uploads/:videoId')` to `VideosController`, returning 204

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.abortUpload` | Unit: state validation branch (mock repo + storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.abortUpload` | Integration: real `AbortMultipartUpload`, row deleted from DB | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**
- `DELETE /videos/uploads/:videoId` on an `awaiting_upload` session returns 204, the row no longer exists, and the multipart upload is aborted in storage
- The same call on an already-completed session returns 409 `UPLOAD_ALREADY_COMPLETED`
- A non-owner caller returns 403 `FORBIDDEN_NOT_OWNER`

---

### SI-03.9 — FfmpegService (Metadata Extraction and Thumbnail Frame Extraction)

**Description:** Provide the typed `FfmpegService` wrapping direct `child_process.spawn` calls to `ffprobe`/`ffmpeg` (`phase-03-videos/TD-06`), used by the worker to extract duration/metadata and the thumbnail frame at a proportional offset (`phase-03-videos/TD-11`).

**Technical actions:**
- Create `src/ffmpeg/ffmpeg.service.ts` — `FfmpegService.getMetadata(sourceUrl): Promise<{ durationSeconds: number }>` spawning `ffprobe -v quiet -print_format json -show_format -show_streams <sourceUrl>` (array-form arguments, never a shell string) and parsing stdout as JSON
- Add `FfmpegService.extractThumbnail(sourceUrl, durationSeconds): Promise<Buffer>` — computes `t = Math.max(durationSeconds * 0.10, 1)` and spawns `ffmpeg -ss <t> -i <sourceUrl> -frames:v 1 -q:v 2 -f image2 pipe:1`, collecting stdout into a Buffer
- Create `src/ffmpeg/ffmpeg.module.ts` — `FfmpegModule` exporting `FfmpegService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit: argument-array correctness, JSON parsing, proportional-offset calculation, spawn failure surfaces exit code/stderr (mock `child_process.spawn`) | `src/ffmpeg/ffmpeg.service.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**
- `getMetadata` returns the duration parsed from a mocked `ffprobe` JSON response
- `extractThumbnail` on a 100-second mocked video computes `t = 10`; on a 2-second video computes `t = 1` (the floor), never seeking past the end
- A non-zero `ffprobe`/`ffmpeg` exit code rejects with an error carrying the exit code and stderr output

---

### SI-03.10 — Video Worker Bootstrap (Headless NestJS Worker and Dockerfile.worker)

**Description:** Boot the FFmpeg worker as a separate Compose service running the same NestJS codebase in a headless application context (`phase-03-videos/TD-05`).

**Technical actions:**
- Create `src/main.worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, no HTTP listener
- Create `src/worker.module.ts` — `WorkerModule` importing `ConfigModule`, `TypeOrmModule` (entities), `StorageModule`, `QueueModule`, `FfmpegModule` — curated to exclude controllers/guards the worker has no use for
- Create `Dockerfile.worker` extending the same base image as the API Dockerfile, installing the `ffmpeg` package (provides both `ffmpeg` and `ffprobe` binaries) and running `node dist/main.worker.js`
- Add the `video-worker` service to `compose.yaml`, built from `Dockerfile.worker`, sharing the same env file as `nestjs-api`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4, SI-03.9

**Acceptance criteria:**
- `WorkerModule` compiles standalone via `NestFactory.createApplicationContext`
- `docker compose up -d video-worker` starts the container and `ffmpeg -version` / `ffprobe -version` succeed inside it
- `video-worker`'s image does not include the HTTP controllers/guards from the API

---

### SI-03.11 — Video Processor (Job Consumer: Metadata, Thumbnail, and Status Update)

**Description:** Consume `video.process` jobs — extract metadata and thumbnail, write the thumbnail back to storage, and update the video's processing status (`phase-03-videos/TD-10`).

**Technical actions:**
- Create `src/videos/video.processor.ts` — `VideoProcessor` (`@Processor('video-processing')` extends `WorkerHost`), `process(job: Job<{ videoId: string }>)`: load the video, presign a GET URL for the source object (`phase-03-videos/TD-07`), call `FfmpegService.getMetadata` then `extractThumbnail`, `StorageService.putObject` the thumbnail at `buildThumbnailKey(videoId)`, update `processing_status = 'ready'`, `duration_seconds`, `thumbnail_key`
- Add `@OnWorkerEvent('failed')` handling — on final failure (after 3 attempts), set `processing_status = 'failed'` and persist a redacted `processing_error` (never the presigned source URL)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: happy path + failure path (mock `FfmpegService`, `StorageService`, repo) | `src/videos/video.processor.spec.ts` |
| `VideoProcessor` | Integration: real DB status/duration/thumbnail_key transition on success | `src/videos/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.10

**Acceptance criteria:**
- Processing a valid job transitions the video to `processing_status = 'ready'` with `duration_seconds` and `thumbnail_key` populated
- A job that exhausts all 3 attempts sets `processing_status = 'failed'` with a non-null `processing_error` that never contains a presigned URL
- Re-processing the same `jobId` after success is a no-op (BullMQ dedup, per `phase-03-videos/TD-10`)

---

### SI-03.12 — Public Video Delivery Endpoint (GET /videos/:slug)

**Route:** GET /videos/:slug
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Anonymous

**Description:** Serve video metadata plus streaming and download URLs once processing has completed (`phase-03-videos/TD-09`).

**Technical actions:**
- Add `VideosService.getDeliveryInfo(slug)` — find by `slug` (`VideoNotFoundException`, 404, if absent), throw `VideoNotReadyException` (409) unless `processing_status === 'ready'`, presign a stream GET URL and a download GET URL (`ResponseContentDisposition: attachment; filename="${originalFilename}"`) with a shared `expiresAt`
- Add `@Get(':slug')` to `VideosController` (no auth guard), returning 200 with `{ id, slug, durationSeconds, streamUrl, downloadUrl, expiresAt }` per `## Technical Specifications → API Contracts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDeliveryInfo` | Unit: not-found and not-ready branches (mock repo) | `src/videos/videos.service.spec.ts` |
| `VideosService.getDeliveryInfo` | Integration: presigned stream/download URLs are fetchable against MinIO for a `ready` video | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**
- `GET /videos/:slug` for a `ready` video returns 200 with working `streamUrl` and `downloadUrl`, both expiring at the same `expiresAt`
- `GET /videos/:slug` for an unknown slug returns 404 `VIDEO_NOT_FOUND`
- `GET /videos/:slug` for a video still `processing` returns 409 `VIDEO_NOT_READY`
- No `Authorization` header is required for a successful call

---

### SI-03.13 — Reconciliation Sweep for Stuck Processing Jobs

**Description:** Recover videos stuck in `processing` past a threshold by re-enqueuing them, covering the non-transactional-enqueue gap accepted in `phase-03-videos/TD-03`.

**Technical actions:**
- Add a BullMQ repeatable job registration in `QueueModule`'s bootstrap (`queue.add('reconcile', {}, { repeat: { every: 15 * 60 * 1000 } })`) — no new dependency; uses the same `video-processing` queue decided in TD-03
- Add a `reconcile` job-name branch in `VideoProcessor.process()` that queries `videos` where `processing_status = 'processing' AND updated_at < now() - interval '15 minutes'`, and re-enqueues each row's `video.process` job with `jobId: videoId` (naturally deduplicated against any still-genuinely-in-flight job)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` (reconcile branch) | Unit: query filter + re-enqueue call (mock repo + queue) — per testing-guide `future-types.md`, the method's logic is tested directly; the schedule itself is trusted to BullMQ | `src/videos/video.processor.spec.ts` |

**Dependencies:** SI-03.4, SI-03.7

**Acceptance criteria:**
- A video row with `processing_status = 'processing'` and `updated_at` older than 15 minutes is re-enqueued by the sweep
- A row updated within the last 15 minutes is left untouched by the sweep
- Re-enqueuing a row whose job is still genuinely in-flight is a no-op (same `jobId` dedup)

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| channel_id | uuid | FK → channels.id, not null | Owning channel |
| slug | varchar(11) | unique, not null | Public identifier (TD-08) — `node:crypto` base64url, minted at draft creation |
| original_filename | varchar | not null | Captured at upload initiation; source of the `object_key` extension and the download `Content-Disposition` filename until a title field lands in Fase 04 |
| object_key | varchar | not null | Source object storage key, `videos/{id}/source{ext}` (TD-02) |
| thumbnail_key | varchar | nullable | Thumbnail object storage key, `videos/{id}/thumbnail.jpg` (TD-02/TD-06/TD-11); set once processing succeeds |
| upload_id | varchar | nullable | Storage multipart `UploadId` (TD-04); present only while `processing_status = 'awaiting_upload'` |
| processing_status | enum | not null, default `'awaiting_upload'`, values: `'awaiting_upload'`, `'processing'`, `'ready'`, `'failed'` | PostgreSQL enum type (TD-10) |
| processing_error | text | nullable | Redacted failure reason — never the presigned URL (TD-10) |
| duration_seconds | integer | nullable | Extracted via `ffprobe` (TD-05/TD-06/TD-07); set once processing succeeds |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one)
**Indexes:** `(slug)` — unique, `(channel_id)` — FK, `(processing_status, updated_at)` — composite, supports the reconciliation sweep query

---

### API Contracts

#### POST /videos/uploads (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- filename: string, required — original file name; used to derive the storage object key extension and the future download filename
- content_type: string, required — MIME type of the video file (e.g., `video/mp4`)

**Response 201:**
- video_id: string (uuid)
- slug: string
- upload_id: string — storage multipart `UploadId`
- part_size: number — bytes per part (64 MiB, per TD-04)

**Error responses:**
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/uploads/:videoId/parts (SI-03.6)

**Request headers:**
- Authorization: Bearer <access_token>

**Request query parameters:**
- from: number, required — first part number in the requested batch (1-indexed)
- to: number, required — last part number in the requested batch

**Response 200:**
- parts: array of `{ part_number: number, url: string, expires_at: string (ISO-8601) }`

**Error responses:**
- 404 UPLOAD_SESSION_NOT_FOUND: when `videoId` does not exist or does not belong to an in-progress upload
- 403 FORBIDDEN_NOT_OWNER: when the authenticated user does not own the video's channel
- 400 INVALID_PART_RANGE: when `from`/`to` are missing, non-numeric, or outside the 1–10 000 multipart bounds

---

#### POST /videos/uploads/:videoId/complete (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- parts: array of `{ part_number: number, e_tag: string }`, required

**Response 200:**
- video_id: string (uuid)
- processing_status: string (`'processing'`)

**Error responses:**
- 404 UPLOAD_SESSION_NOT_FOUND
- 403 FORBIDDEN_NOT_OWNER
- 409 UPLOAD_ALREADY_COMPLETED: when the session's `processing_status` is no longer `'awaiting_upload'`
- 400 PART_LIST_MISMATCH: when the submitted parts/ETags don't match what storage's `ListParts` reports

---

#### DELETE /videos/uploads/:videoId (SI-03.8)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 404 UPLOAD_SESSION_NOT_FOUND
- 403 FORBIDDEN_NOT_OWNER
- 409 UPLOAD_ALREADY_COMPLETED

---

#### GET /videos/:slug (SI-03.12)

**Request headers:** none.

**Response 200:**
- id: string (uuid)
- slug: string
- duration_seconds: number
- stream_url: string — presigned GET URL for playback (Range/206-capable, served by storage)
- download_url: string — presigned GET URL with `Content-Disposition: attachment`
- expires_at: string (ISO-8601) — shared TTL for both URLs

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video exists with this slug
- 409 VIDEO_NOT_READY: when `processing_status` is not `'ready'`

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner | Notes |
|----------|--------|----------------|-------|-------|
| POST /videos/uploads | | ✓ | | Creates a draft owned by the caller's channel |
| GET /videos/uploads/:videoId/parts | | | ✓ | Only the owning channel's user |
| POST /videos/uploads/:videoId/complete | | | ✓ | Only the owning channel's user |
| DELETE /videos/uploads/:videoId | | | ✓ | Only the owning channel's user |
| GET /videos/:slug | ✓ | | | Anonymous watch, per project overview |

---

### Error Catalog

**Error response format:** inherited from `phase-02-auth/TD-07` — `{ statusCode, error, message }` (no redefinition needed this phase).

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| UPLOAD_SESSION_NOT_FOUND | 404 | Upload session not found | GET .../parts, POST .../complete, or DELETE .../:videoId with a `videoId` that doesn't exist |
| FORBIDDEN_NOT_OWNER | 403 | You do not own this upload session | Any upload-session-scoped call by an authenticated user who isn't the owning channel's user |
| INVALID_PART_RANGE | 400 | Invalid part range | GET .../parts with a missing, non-numeric, or out-of-bounds `from`/`to` |
| UPLOAD_ALREADY_COMPLETED | 409 | Upload session is no longer accepting parts | POST .../complete or DELETE .../:videoId called on a session whose `processing_status` left `'awaiting_upload'` |
| PART_LIST_MISMATCH | 400 | Submitted parts do not match storage | POST .../complete with parts/ETags that don't match `ListParts` |
| VIDEO_NOT_FOUND | 404 | Video not found | GET /videos/:slug with an unknown slug |
| VIDEO_NOT_READY | 409 | Video is not ready for delivery | GET /videos/:slug when `processing_status` is not `'ready'` |

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`) — enqueued right after `CompleteMultipartUpload` succeeds (SI-03.7); also re-enqueued by the reconciliation sweep (SI-03.13) for rows stuck in `processing` past a threshold.
**Consumer:** `VideoProcessor` (`WorkerHost`), running in the separate worker container (per `phase-03-videos/TD-05`) (SI-03.11)
**Trigger:** Upload multipart completion, or the periodic reconciliation sweep re-driving a stalled row.
**Delivery semantics:** at-least-once, deduplicated by `jobId = videoId` (per `phase-03-videos/TD-10`); 3 attempts with exponential backoff (per `phase-03-videos/TD-03`); final failure sets `processing_status = 'failed'` with a redacted `processing_error`.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.3
└── SI-03.4

SI-03.2 (no deps)

SI-03.9 (no deps)

SI-03.2 + SI-03.3
├── SI-03.5
└── SI-03.12

SI-03.5
└── SI-03.6
    └── SI-03.8

SI-03.4 + SI-03.6
└── SI-03.7

SI-03.4 + SI-03.7
└── SI-03.13

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.9
└── SI-03.10
    └── SI-03.11
```

Linearized implementation order: SI-03.1, SI-03.2, SI-03.9 (parallel) → SI-03.3, SI-03.4 (parallel) → SI-03.5, SI-03.10, SI-03.12 (parallel) → SI-03.6, SI-03.11 (parallel) → SI-03.7, SI-03.8 (parallel) → SI-03.13

---

## Deliverables

- [ ] SI-03.1 — Dependencies, Storage/Queue Configuration Namespaces, and Docker Compose Infrastructure
- [ ] SI-03.2 — Video Entity and Migration
- [ ] SI-03.3 — StorageModule (S3 Client Provider, Key Builder, and Presign Helpers)
- [ ] SI-03.4 — QueueModule (BullMQ Registration)
- [ ] SI-03.5 — Upload Initiation Endpoint (POST /videos/uploads)
- [ ] SI-03.6 — Part-URL Issuance Endpoint (GET /videos/uploads/:videoId/parts)
- [ ] SI-03.7 — Upload Completion Endpoint (POST /videos/uploads/:videoId/complete)
- [ ] SI-03.8 — Upload Abort Endpoint (DELETE /videos/uploads/:videoId)
- [ ] SI-03.9 — FfmpegService (Metadata Extraction and Thumbnail Frame Extraction)
- [ ] SI-03.10 — Video Worker Bootstrap (Headless NestJS Worker and Dockerfile.worker)
- [ ] SI-03.11 — Video Processor (Job Consumer: Metadata, Thumbnail, and Status Update)
- [ ] SI-03.12 — Public Video Delivery Endpoint (GET /videos/:slug)
- [ ] SI-03.13 — Reconciliation Sweep for Stuck Processing Jobs
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
