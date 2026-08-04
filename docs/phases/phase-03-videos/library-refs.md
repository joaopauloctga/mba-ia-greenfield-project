---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1095.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-26T03:00:56Z"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1095.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-26T03:00:56Z"
  "bullmq":
    version: "^5.81.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-26T03:00:56Z"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-26T03:00:56Z"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-07-26T03:00:56Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-25T23:59:59-03:00"
---

# phase-03-videos — Library References

## @aws-sdk/client-s3

_(TD-01, TD-04, TD-07, TD-09 — storage client; presigned multipart upload; worker read; delivery)_

Configure the client with a custom endpoint + `forcePathStyle` so the exact same code targets MinIO in dev and real S3 in prod (per TD-01's Recommendation):

```typescript
const client = new S3Client({
  endpoint: config.s3Endpoint, // MinIO: http://minio:9000 ; omit/unset for real AWS S3
  forcePathStyle: config.s3ForcePathStyle, // true for MinIO, false/omitted for AWS S3
  region: config.s3Region,
  credentials: {
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
  },
});
```

Multipart upload flow (TD-04's decided contract — `CreateMultipartUpload → UploadPart (per part) → CompleteMultipartUpload`, or `AbortMultipartUpload` on cancel/failure):

```typescript
const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// per part, client presigns each UploadPartCommand (see s3-request-presigner below) —
// the API itself never calls UploadPartCommand directly; the browser PUTs to the presigned URL
// and returns the ETag, which the API collects:
const completedParts = [{ PartNumber, ETag }, /* ... */];

await client.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: completedParts },
}));

// on cancel/failure:
await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

Note (v3 naming, relevant if any TD-01-adjacent code references older docs/blog posts): `s3ForcePathStyle` (v2) is `forcePathStyle` (v3); `s3DisableBodySigning` is `applyChecksum`.

## @aws-sdk/s3-request-presigner

_(TD-01, TD-04 — presigns UploadPart for the browser; TD-07 — presigns GetObject for the worker; TD-09 — presigns GetObject with `ResponseContentDisposition` for streaming/download)_

```typescript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const url = await getSignedUrl(client, command, { expiresIn: 3600 }); // seconds; defaults to 900 if omitted
```

`getSignedUrl` accepts **any** command object — this is what makes presigning `UploadPartCommand` (TD-04) work identically to presigning `GetObjectCommand` (TD-07, TD-09). For TD-09's download URL, pass `ResponseContentDisposition` on the `GetObjectCommand` itself (it is signed as part of the request, mapped to the `response-content-disposition` query parameter on the presigned URL):

```typescript
const command = new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: `attachment; filename="${title}"`,
});
const downloadUrl = await getSignedUrl(client, command, { expiresIn: playbackTtlSeconds });
```

## bullmq

_(TD-03 — queue technology; TD-10 — idempotency/retry parameters consumed by this library's own options)_

Producer side (video-processing job, enqueued after TD-04's `CompleteMultipartUpload` step):

```typescript
import { Queue } from 'bullmq';

const myQueue = new Queue('video-processing', {
  connection: { host: config.redisHost, port: config.redisPort },
  defaultJobOptions: {
    attempts: 3,          // per TD-10's failure model
    backoff: { type: 'exponential', delay: 1000 },
  },
});

await myQueue.add('process-video', { videoId }, { jobId: videoId }); // jobId = videoId, per TD-10's dedup key
```

A duplicate `add()` call with the same `jobId` returns the existing job instead of enqueueing a second one — this is the literal mechanism behind TD-10's "`jobId = videoId` so a duplicated enqueue is deduplicated" statement.

## @nestjs/bullmq

_(TD-05 — worker topology; the worker's headless Nest bootstrap registers the processor via this module)_

```typescript
// Producer side (API) — AppModule or StorageModule:
BullModule.forRootAsync({
  useFactory: (config: ConfigType<typeof redisConfig>) => ({
    connection: { host: config.host, port: config.port },
  }),
  inject: [redisConfig.KEY],
});
BullModule.registerQueue({ name: 'video-processing' });

// Consumer side (worker, WorkerModule per TD-05) — plain NestJS class with constructor DI:
@Processor('video-processing')
class VideoProcessor extends WorkerHost {
  constructor(
    private readonly ffmpegService: FfmpegService, // TD-06
    private readonly storageService: StorageService, // TD-01/TD-07
  ) { super(); }

  async process(job: Job<{ videoId: string }>): Promise<any> {
    // ffprobe metadata (TD-05/TD-06/TD-07) + thumbnail (TD-06/TD-11) + status update (TD-10)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // persist redacted processing_error per TD-10 — never log the presigned URL from TD-07
  }
}
```

`WorkerHost` is the abstract base every processor extends; `process(job, token?)` is the one method to implement. Coverage note: this package (`/nestjs/bull` Context7 index) has thin snippet coverage (3 snippets) for the dedicated `@nestjs/bullmq` subpackage — the examples above were cross-checked against the package's own e2e test suite (`packages/bullmq/e2e/module.e2e-spec.ts`), which is the most authoritative source available for this integration.

## ioredis

_(transitive — the connection library BullMQ/`@nestjs/bullmq` use under the hood; TD-03's Redis container)_

```typescript
new Redis({
  host: config.redisHost,     // Compose service name "redis" — never "localhost", per repo convention
  port: config.redisPort,     // default 6379
});
```

No direct application code is expected to instantiate `Redis` — `@nestjs/bullmq`'s `connection` option (shown above) is passed straight through to `ioredis` internally. Relevant only if a future SI needs a raw Redis client outside the queue (not currently the case for any TD in this phase).
