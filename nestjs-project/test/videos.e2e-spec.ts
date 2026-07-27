import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  // Group 1: Upload Initiation (SI-03.5)

  it('initiate-upload-success', async () => {
    const accessToken = await registerAndLogin('upload-init-1@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', content_type: 'video/mp4' });

    expect(res.status).toBe(201);
    expect(res.body.videoId).toBeDefined();
    expect(res.body.slug).toBeDefined();
    expect(res.body.uploadId).toBeDefined();
    expect(res.body.partSize).toBe(64 * 1024 * 1024);

    const videoRepository = dataSource.getRepository(Video);
    const persisted = await videoRepository.findOneBy({
      id: res.body.videoId,
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.processing_status).toBe(
      VideoProcessingStatus.AWAITING_UPLOAD,
    );
    expect(persisted!.upload_id).not.toBeNull();
  });

  it('initiate-upload-validation-error', async () => {
    const accessToken = await registerAndLogin('upload-init-2@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4' });

    expect(res.status).toBe(400);
  });

  // Group 2: Part-URL Issuance (SI-03.6)

  async function initiateUploadFor(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', content_type: 'video/mp4' });
    return res.body.videoId as string;
  }

  it('get-part-urls-success', async () => {
    const accessToken = await registerAndLogin('part-urls-1@example.com');
    const videoId = await initiateUploadFor(accessToken);

    const res = await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .query({ from: 1, to: 5 })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.parts).toHaveLength(5);
    for (const part of res.body.parts) {
      expect(part.partNumber).toBeDefined();
      expect(part.url).toBeDefined();
      expect(part.expiresAt).toBeDefined();
    }
  });

  it('get-part-urls-forbidden-not-owner', async () => {
    const ownerToken = await registerAndLogin('part-urls-owner@example.com');
    const videoId = await initiateUploadFor(ownerToken);
    const otherToken = await registerAndLogin('part-urls-other@example.com');

    const res = await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .query({ from: 1, to: 5 })
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_NOT_OWNER');
  });

  it('get-part-urls-invalid-range', async () => {
    const accessToken = await registerAndLogin('part-urls-2@example.com');
    const videoId = await initiateUploadFor(accessToken);

    const belowMin = await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .query({ from: 0, to: 5 })
      .set('Authorization', `Bearer ${accessToken}`);
    expect(belowMin.status).toBe(400);
    expect(belowMin.body.error).toBe('INVALID_PART_RANGE');

    const aboveMax = await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .query({ from: 1, to: 10001 })
      .set('Authorization', `Bearer ${accessToken}`);
    expect(aboveMax.status).toBe(400);
    expect(aboveMax.body.error).toBe('INVALID_PART_RANGE');
  });

  it('get-part-urls-not-found', async () => {
    const accessToken = await registerAndLogin('part-urls-3@example.com');

    const res = await request(app.getHttpServer())
      .get('/videos/uploads/00000000-0000-0000-0000-000000000000/parts')
      .query({ from: 1, to: 5 })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('UPLOAD_SESSION_NOT_FOUND');
  });

  // Group 3: Upload Completion (SI-03.7)

  async function initiateAndUploadOnePart(accessToken: string): Promise<{
    videoId: string;
    part: { part_number: number; e_tag: string };
  }> {
    const videoId = await initiateUploadFor(accessToken);
    const partsRes = await request(app.getHttpServer())
      .get(`/videos/uploads/${videoId}/parts`)
      .query({ from: 1, to: 1 })
      .set('Authorization', `Bearer ${accessToken}`);
    const putResponse = await fetch(partsRes.body.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('e2e-test-part-content'),
    });
    const eTag = putResponse.headers.get('etag') as string;

    return { videoId, part: { part_number: 1, e_tag: eTag } };
  }

  it('complete-upload-success', async () => {
    const accessToken = await registerAndLogin('complete-1@example.com');
    const { videoId, part } = await initiateAndUploadOnePart(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [part] });

    expect(res.status).toBe(200);
    expect(res.body.processingStatus).toBe('processing');

    const queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
  });

  it('complete-upload-already-completed', async () => {
    const accessToken = await registerAndLogin('complete-2@example.com');
    const { videoId, part } = await initiateAndUploadOnePart(accessToken);
    await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [part] });

    const res = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [part] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('UPLOAD_ALREADY_COMPLETED');
  });

  it('complete-upload-part-mismatch', async () => {
    const accessToken = await registerAndLogin('complete-3@example.com');
    const { videoId, part } = await initiateAndUploadOnePart(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        parts: [{ part_number: part.part_number, e_tag: '"not-the-etag"' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PART_LIST_MISMATCH');
  });

  it('complete-upload-forbidden-not-owner', async () => {
    const ownerToken = await registerAndLogin('complete-owner@example.com');
    const { videoId, part } = await initiateAndUploadOnePart(ownerToken);
    const otherToken = await registerAndLogin('complete-other@example.com');

    const res = await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ parts: [part] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_NOT_OWNER');
  });

  // Group 4: Upload Abort (SI-03.8)

  it('abort-upload-success', async () => {
    const accessToken = await registerAndLogin('abort-1@example.com');
    const videoId = await initiateUploadFor(accessToken);
    const videoRepository = dataSource.getRepository(Video);
    const video = await videoRepository.findOneByOrFail({ id: videoId });

    const res = await request(app.getHttpServer())
      .delete(`/videos/uploads/${videoId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted).toBeNull();

    const storageService = app.get(StorageService);
    await expect(
      storageService.listParts(video.object_key, video.upload_id as string),
    ).rejects.toThrow();
  });

  it('abort-upload-already-completed', async () => {
    const accessToken = await registerAndLogin('abort-2@example.com');
    const { videoId, part } = await initiateAndUploadOnePart(accessToken);
    await request(app.getHttpServer())
      .post(`/videos/uploads/${videoId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [part] });

    const res = await request(app.getHttpServer())
      .delete(`/videos/uploads/${videoId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('UPLOAD_ALREADY_COMPLETED');
  });

  it('abort-upload-forbidden-not-owner', async () => {
    const ownerToken = await registerAndLogin('abort-owner@example.com');
    const videoId = await initiateUploadFor(ownerToken);
    const otherToken = await registerAndLogin('abort-other@example.com');

    const res = await request(app.getHttpServer())
      .delete(`/videos/uploads/${videoId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_NOT_OWNER');
  });

  // Group 5: Public Delivery (SI-03.12)

  let deliverySeedCounter = 0;
  async function seedVideoWithStatus(
    status: VideoProcessingStatus,
  ): Promise<Video> {
    deliverySeedCounter += 1;
    const userRepository = dataSource.getRepository(User);
    const channelRepository = dataSource.getRepository(Channel);
    const videoRepository = dataSource.getRepository(Video);

    const user = await userRepository.save(
      userRepository.create({
        email: `delivery_${deliverySeedCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Delivery Channel ${deliverySeedCounter}`,
        nickname: `delivery_chan_${deliverySeedCounter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: `dlv${deliverySeedCounter}`.padEnd(11, '0').slice(0, 11),
        original_filename: 'clip.mp4',
        object_key: `videos/e2e-delivery-${deliverySeedCounter}/source.mp4`,
        processing_status: status,
        duration_seconds: 42,
      }),
    );
  }

  it('get-delivery-ready-success', async () => {
    const video = await seedVideoWithStatus(VideoProcessingStatus.READY);

    const res = await request(app.getHttpServer()).get(`/videos/${video.slug}`);

    expect(res.status).toBe(200);
    expect(res.body.streamUrl).toBeDefined();
    expect(res.body.downloadUrl).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
  });

  it('get-delivery-not-found', async () => {
    const res = await request(app.getHttpServer()).get(
      '/videos/does-not-exist',
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('get-delivery-not-ready', async () => {
    const video = await seedVideoWithStatus(VideoProcessingStatus.PROCESSING);

    const res = await request(app.getHttpServer()).get(`/videos/${video.slug}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });
});
