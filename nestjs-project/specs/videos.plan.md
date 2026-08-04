---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5, SI-03.6, SI-03.7, SI-03.8, SI-03.12
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# Videos Test Plan

## Application Overview

The `/videos` resource covers the upload handshake (S3 multipart: initiate, part-URL issuance, completion, abort) and the public delivery endpoint (streaming/download URLs) for Fase 03 — Upload e Processamento de Vídeos. Upload endpoints are owner-scoped (the authenticated user's channel); the delivery endpoint is anonymous.

## Test Scenarios

### 1. Upload Initiation

**Setup:** `beforeEach` truncate `videos` and `channels`/`users` tables; bootstrap the Nest test module (`Test.createTestingModule(...).compile()`) with a real Postgres test DB and a real MinIO/Redis test instance; seed one authenticated user + channel and obtain a valid access token.

#### 1.1. initiate-upload-success

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `POST /videos/uploads` with a valid `Authorization` bearer token and body `{ filename: "clip.mp4", content_type: "video/mp4" }`
    - expect: 201 response with `videoId`, `slug`, `uploadId`, `partSize` fields present
    - expect: the created row in `videos` has `processing_status = 'awaiting_upload'` and a non-null `upload_id`

#### 1.2. initiate-upload-validation-error

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `POST /videos/uploads` with a valid bearer token and body missing `content_type`
    - expect: 400 response with a validation error

---

### 2. Part-URL Issuance

**Setup:** same as Group 1, plus one video row already created via `POST /videos/uploads` in `beforeEach` to obtain a live `videoId`.

#### 2.1. get-part-urls-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `GET /videos/uploads/{videoId}/parts?from=1&to=5` with the owning user's bearer token
    - expect: 200 response with a `parts` array of exactly 5 entries, each with `partNumber`, `url`, `expiresAt`

#### 2.2. get-part-urls-forbidden-not-owner

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. Seed a second user + channel; `GET /videos/uploads/{videoId}/parts?from=1&to=5` with the second user's bearer token (not the owner)
    - expect: 403 response with `errorCode: "FORBIDDEN_NOT_OWNER"`

#### 2.3. get-part-urls-invalid-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `GET /videos/uploads/{videoId}/parts?from=0&to=5` with the owning user's bearer token
    - expect: 400 response with `errorCode: "INVALID_PART_RANGE"`
  2. `GET /videos/uploads/{videoId}/parts?from=1&to=10001` with the owning user's bearer token
    - expect: 400 response with `errorCode: "INVALID_PART_RANGE"`

#### 2.4. get-part-urls-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `GET /videos/uploads/00000000-0000-0000-0000-000000000000/parts?from=1&to=5` with any authenticated user's bearer token
    - expect: 404 response with `errorCode: "UPLOAD_SESSION_NOT_FOUND"`

---

### 3. Upload Completion

**Setup:** same as Group 2, plus real parts uploaded to MinIO via the presigned URLs from Group 2 (or directly via the storage test client) so `CompleteMultipartUpload` has real ETags to validate against.

#### 3.1. complete-upload-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `POST /videos/uploads/{videoId}/complete` with the owning user's bearer token and body `{ parts: [{ part_number: 1, e_tag: "<real-etag>" }] }`
    - expect: 200 response with `processing_status: "processing"`
    - expect: exactly one `video.process` job is present on the `video-processing` queue with `jobId = videoId`

#### 3.2. complete-upload-already-completed

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. Call `POST /videos/uploads/{videoId}/complete` a second time for the same, already-completed session
    - expect: 409 response with `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 3.3. complete-upload-part-mismatch

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `POST /videos/uploads/{videoId}/complete` with an `e_tag` that does not match what storage's `ListParts` reports
    - expect: 400 response with `errorCode: "PART_LIST_MISMATCH"`

#### 3.4. complete-upload-forbidden-not-owner

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `POST /videos/uploads/{videoId}/complete` with a non-owner user's bearer token
    - expect: 403 response with `errorCode: "FORBIDDEN_NOT_OWNER"`

---

### 4. Upload Abort

**Setup:** same as Group 1, with a fresh `awaiting_upload` video row per test.

#### 4.1. abort-upload-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `DELETE /videos/uploads/{videoId}` with the owning user's bearer token
    - expect: 204 response with no body
    - expect: the `videos` row no longer exists
    - expect: the multipart upload no longer exists in storage (a subsequent `ListParts` call errors)

#### 4.2. abort-upload-already-completed

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `DELETE /videos/uploads/{videoId}` on a session already completed via Group 3
    - expect: 409 response with `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 4.3. abort-upload-forbidden-not-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `DELETE /videos/uploads/{videoId}` with a non-owner user's bearer token
    - expect: 403 response with `errorCode: "FORBIDDEN_NOT_OWNER"`

---

### 5. Public Delivery

**Setup:** a video row with `processing_status = 'ready'` seeded directly in the test DB (bypassing the full upload+worker flow, since the worker is out of E2E scope for this spec); no `Authorization` header sent.

#### 5.1. get-delivery-ready-success

**Covers AC:** #1, #4
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `GET /videos/{slug}` for the `ready` video, with no `Authorization` header
    - expect: 200 response with `streamUrl`, `downloadUrl`, and `expiresAt`, and both URLs share the same `expiresAt`

#### 5.2. get-delivery-not-found

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `GET /videos/does-not-exist`
    - expect: 404 response with `errorCode: "VIDEO_NOT_FOUND"`

#### 5.3. get-delivery-not-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-26T21:37:57Z

**Steps:**
  1. `GET /videos/{slug}` for a video seeded with `processing_status = 'processing'`
    - expect: 409 response with `errorCode: "VIDEO_NOT_READY"`
