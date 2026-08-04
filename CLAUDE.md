# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for auth, users, channels, videos, storage, queue and ffmpeg. Also hosts the video worker (`src/main.worker.ts` + `src/worker.module.ts`), which runs as its own container from the same codebase.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — frontend app (Phases 01–02)

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (BullMQ on Redis) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos (Phase 03)

Video upload, processing and delivery live in `nestjs-project/src/videos/`, backed by three supporting modules: `storage/` (S3/MinIO), `queue/` (BullMQ) and `ffmpeg/`.

### Upload — bytes never pass through the API

Uploads use **S3 multipart with presigned part URLs**. The API only issues signed URLs and records state; the client `PUT`s each part **directly to object storage**. This is what makes a 10GB upload possible without occupying the API.

| Endpoint | Auth | Effect |
|---|---|---|
| `POST /videos/uploads` | required | Pre-registers the draft video (`awaiting_upload`) and opens the multipart session. Returns `videoId`, `slug`, `uploadId`, `partSize` (64 MiB) |
| `GET /videos/uploads/:videoId/parts?from&to` | required | Issues presigned `UploadPart` URLs for a range of part numbers (1–10000) |
| `POST /videos/uploads/:videoId/complete` | required | Validates the submitted parts against storage's own `ListParts`, completes the upload, moves the video to `processing` and enqueues the job |
| `DELETE /videos/uploads/:videoId` | required | Aborts the session in storage and removes the draft row |
| `GET /videos/:slug` | **public** | Returns metadata plus presigned streaming and download URLs; `409` until processing finishes |

Ownership is enforced per request: the caller's channel must own the video, otherwise `403`.

### Processing — the worker

`POST .../complete` enqueues `video.process` on the `video-processing` queue (3 attempts, exponential backoff, `jobId = videoId`). The **`video-worker` container** consumes it (`VideoProcessor`, `src/videos/video.processor.ts`) and:

1. presigns a GET URL for the source and runs **ffprobe** over it to extract duration
2. runs **ffmpeg** to grab a thumbnail at 10% of the duration (minimum 1s)
3. stores the JPEG and flips the row to `ready` with `duration_seconds` and `thumbnail_key`

If every attempt fails, `OnWorkerEvent('failed')` sets the video to `failed` with `processing_error`. A repeatable `reconcile` job re-enqueues videos stuck in `processing` for more than 15 minutes.

**FFmpeg is installed only in the worker image** (`Dockerfile.worker`) — not in `nestjs-api`.

### Status lifecycle

`awaiting_upload` → `processing` → `ready` | `failed` — persisted in `videos.processing_status` (Postgres enum). Table created by `1785111578614-CreateVideosTable.ts`; `Video` belongs to a `Channel` via `channel_id`.

### Storage layout and delivery

Single bucket (`S3_BUCKET`, default `streamtube`), keyed by video UUID:

- `videos/{videoId}/source{ext}` — the uploaded file
- `videos/{videoId}/thumbnail.jpg` — the generated thumbnail

Each video gets a unique `slug` (base64url over 8 random bytes) used as its public URL identifier, with retry on collision. Playback and download are presigned GET URLs served straight from storage, which honors HTTP Range (`206 Partial Content`) — so playback never requires a full download. The download URL differs only by carrying `ResponseContentDisposition: attachment`.

> **Known limitation:** presigned URLs are signed against `S3_ENDPOINT` (`http://minio:9000`), which only resolves **inside** the Compose network. A browser on the host cannot use them: the hostname does not resolve, and rewriting it to `localhost:9000` invalidates the SigV4 signature (`host` is a signed header). Serving these URLs to a real client requires presigning against a client-reachable endpoint.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.