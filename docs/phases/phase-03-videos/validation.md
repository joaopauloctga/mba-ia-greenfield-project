---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-26T00:00:16-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-25T23:59:59-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "10GB upload capability has no measurable 'no performance impact' criterion"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "No TD decides thumbnail frame-selection strategy (which frame/timestamp)"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Object Storage Client Library"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Bucket Topology and Object Key Layout"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Background Job Queue Technology"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Large-File Upload Protocol (up to 10GB)"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Worker Topology and Runtime"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — FFmpeg / FFprobe Invocation Approach"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Worker Access to the Source Object"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Unique Public Video URL Strategy"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Video Delivery — Streaming and Download"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle and Processing Failure Handling"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Thumbnail Frame-Selection Strategy"
    resolved_by: phase-03-videos/TD-11
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (`## UI Inventory` is absent — Fase 03 has no UI capability in scope; `next-frontend/` is listed as a deferred subproject in context.md's `## Scope`.)

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-11)_ — Capability "Geração automática de thumbnail a partir de um frame do vídeo" now has a dedicated TD (TD-11, "Thumbnail Frame-Selection Strategy") deciding which frame/timestamp is captured, closing the gap left by TD-06 (which only covers the FFmpeg invocation mechanism). Added via `/research phase-03-videos`.
- **AMB-1** _(resolved_by clarification)_ — Resolved as: TD-04's decided mechanism (S3 multipart upload with presigned part URLs — bytes bypass the API entirely) IS the concrete answer to "sem impacto na performance"; no separate numeric SLA needed. `/plan-build` should state this explicitly as the acceptance criterion (the API never buffers upload bytes).
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Decision: A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, custom provider). Option C (community wrapper) was explored first but reverted — no candidate wrapper package has Context7-indexed documentation.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Decision: A (single bucket, `videos/{videoId}/…` prefix, keyed by UUID).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Decision: A (BullMQ + Redis via `@nestjs/bullmq`).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — Decision: A (S3 multipart upload with presigned part URLs).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Decision: A (same codebase, separate worker container).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — Decision: A (direct `child_process.spawn` behind a typed `FfmpegService`).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — Decision: A (presigned GET URL, read directly by FFmpeg over HTTP Range).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Decision: C (`node:crypto` base64url slug in a unique `slug` column).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — Decision: A (presigned GET URLs returned in the video's metadata response).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — Decision: B (dedicated `processing_status` column, orthogonal to Fase 04's publication state).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — Decision: A (fixed proportional offset, e.g. 10% of duration, floored to a small minimum).
