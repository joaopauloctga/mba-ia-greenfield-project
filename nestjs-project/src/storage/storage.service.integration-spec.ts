import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('builds the source and thumbnail object keys per TD-02', () => {
    expect(service.buildObjectKey('abc', '.mp4')).toBe(
      'videos/abc/source.mp4',
    );
    expect(service.buildThumbnailKey('abc')).toBe('videos/abc/thumbnail.jpg');
  });

  it('completes a multipart upload against real MinIO and the resulting object is retrievable', async () => {
    const key = `videos/test-${Date.now()}/source.mp4`;
    const { uploadId } = await service.createMultipartUpload(key);

    const partUrl = await service.presignUploadPart(key, uploadId, 1);
    const body = Buffer.from('integration-test-part-content');
    const putResponse = await fetch(partUrl, { method: 'PUT', body });
    expect(putResponse.ok).toBe(true);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag as string },
    ]);

    const getUrl = await service.presignGetUrl(key);
    const getResponse = await fetch(getUrl);
    expect(getResponse.ok).toBe(true);
    const retrieved = Buffer.from(await getResponse.arrayBuffer());
    expect(retrieved.equals(body)).toBe(true);
  });

  it('aborts a multipart upload without throwing', async () => {
    const key = `videos/test-${Date.now()}/source.mp4`;
    const { uploadId } = await service.createMultipartUpload(key);

    await service.abortMultipartUpload(key, uploadId);
  });

  it('presigns a GET URL with a custom Content-Disposition that is fetchable before expiry', async () => {
    const key = `videos/test-${Date.now()}/source.mp4`;
    const body = Buffer.from('download-test-content');
    await service.putObject(key, body);

    const url = await service.presignGetUrl(key, {
      responseContentDisposition: 'attachment; filename="video.mp4"',
    });
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-disposition')).toContain(
      'attachment',
    );
  });
});
