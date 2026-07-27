import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
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

    const res = await request(app.getHttpServer()).get(
      `/videos/${video.slug}`,
    );

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

    const res = await request(app.getHttpServer()).get(
      `/videos/${video.slug}`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });
});
