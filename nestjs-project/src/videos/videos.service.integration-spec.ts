import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { PartListMismatchException } from '../common/exceptions/domain.exception';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

async function createVideosTestModule(): Promise<TestingModule> {
  const ds = createTestDataSource(ALL_ENTITIES);

  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, queueConfig],
      }),
      TypeOrmModule.forRoot(ds.options),
      TypeOrmModule.forFeature([Video]),
      StorageModule,
      QueueModule,
    ],
    providers: [VideosService],
  }).compile();
}

describe('VideosService — initiateUpload (integration)', () => {
  let moduleRef: TestingModule;
  let videosService: VideosService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await createVideosTestModule();
    videosService = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_svc_${counter}`,
        user_id: user.id,
      }),
    );
  }

  const dto: CreateUploadDto = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
  };

  it('persists a draft video with awaiting_upload status and a real multipart upload id', async () => {
    const channel = await createChannel();

    const result = await videosService.initiateUpload(channel.id, dto);

    expect(result.uploadId).toBeTruthy();
    expect(result.slug).toHaveLength(11);

    const persisted = await videoRepository.findOneBy({ id: result.videoId });
    expect(persisted).not.toBeNull();
    expect(persisted!.processing_status).toBe(
      VideoProcessingStatus.AWAITING_UPLOAD,
    );
    expect(persisted!.upload_id).toBe(result.uploadId);
    expect(persisted!.channel_id).toBe(channel.id);
    expect(persisted!.object_key).toBe(`videos/${result.videoId}/source.mp4`);
  });

  it("opens the multipart upload with the request's content type so playback is served as video", async () => {
    const channel = await createChannel();

    const result = await videosService.initiateUpload(channel.id, dto);

    const storageService = moduleRef.get(StorageService);
    const partUrl = await storageService.presignUploadPart(
      `videos/${result.videoId}/source.mp4`,
      result.uploadId,
      1,
    );
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: Buffer.from('content-type-wiring-check'),
    });
    await storageService.completeMultipartUpload(
      `videos/${result.videoId}/source.mp4`,
      result.uploadId,
      [{ partNumber: 1, eTag: putResponse.headers.get('etag') as string }],
    );

    const getResponse = await fetch(
      await storageService.presignGetUrl(`videos/${result.videoId}/source.mp4`),
    );

    expect(getResponse.headers.get('content-type')).toBe('video/mp4');
  });
});

describe('VideosService — getDeliveryInfo (integration)', () => {
  let moduleRef: TestingModule;
  let videosService: VideosService;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await createVideosTestModule();
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_delivery_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_delivery_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function slug(): string {
    counter += 1;
    return `dsl${counter}`.padEnd(11, '0').slice(0, 11);
  }

  it('returns working presigned stream and download URLs for a ready video', async () => {
    const channel = await createChannel();
    const objectKey = `videos/delivery-test-${Date.now()}/source.mp4`;
    const body = Buffer.from('integration-test-video-bytes');
    await storageService.putObject(objectKey, body);

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: slug(),
        original_filename: 'clip.mp4',
        object_key: objectKey,
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: 42,
      }),
    );

    const result = await videosService.getDeliveryInfo(video.slug);

    expect(result.id).toBe(video.id);
    expect(result.durationSeconds).toBe(42);
    expect(result.expiresAt).toBeTruthy();

    const streamResponse = await fetch(result.streamUrl);
    expect(streamResponse.ok).toBe(true);
    const streamBody = Buffer.from(await streamResponse.arrayBuffer());
    expect(streamBody.equals(body)).toBe(true);

    const downloadResponse = await fetch(result.downloadUrl);
    expect(downloadResponse.ok).toBe(true);
    expect(downloadResponse.headers.get('content-disposition')).toContain(
      'attachment',
    );
  });
});

describe('VideosService — getPartUrls (integration)', () => {
  let moduleRef: TestingModule;
  let videosService: VideosService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await createVideosTestModule();
    videosService = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_parts_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_parts_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('issues presigned part URLs that accept real UploadPart PUTs against MinIO', async () => {
    const channel = await createChannel();
    const { videoId } = await videosService.initiateUpload(channel.id, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
    });

    const result = await videosService.getPartUrls(videoId, channel.id, 1, 2);

    expect(result.parts).toHaveLength(2);
    for (const part of result.parts) {
      const putResponse = await fetch(part.url, {
        method: 'PUT',
        body: Buffer.alloc(1024, part.partNumber),
      });
      expect(putResponse.ok).toBe(true);
      expect(putResponse.headers.get('etag')).toBeTruthy();
    }

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted!.upload_id).toBeTruthy();
  });
});

describe('VideosService — completeUpload (integration)', () => {
  let moduleRef: TestingModule;
  let videosService: VideosService;
  let queue: Queue;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await createVideosTestModule();
    videosService = moduleRef.get(VideosService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_complete_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_complete_${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function initiateAndUploadOnePart(
    channelId: string,
  ): Promise<{ videoId: string; dto: CompleteUploadDto }> {
    const { videoId } = await videosService.initiateUpload(channelId, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
    });
    const { parts } = await videosService.getPartUrls(videoId, channelId, 1, 1);
    const putResponse = await fetch(parts[0].url, {
      method: 'PUT',
      body: Buffer.from('integration-test-part-content'),
    });
    const eTag = putResponse.headers.get('etag') as string;

    return { videoId, dto: { parts: [{ part_number: 1, e_tag: eTag }] } };
  }

  it('completes a real CompleteMultipartUpload, transitions status, and enqueues a visible job', async () => {
    const channel = await createChannel();
    const { videoId, dto } = await initiateAndUploadOnePart(channel.id);

    const result = await videosService.completeUpload(videoId, channel.id, dto);

    expect(result.processingStatus).toBe(VideoProcessingStatus.PROCESSING);

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted!.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    expect(persisted!.upload_id).toBeNull();

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ videoId });
  });

  it('rejects a part list whose ETag does not match storage', async () => {
    const channel = await createChannel();
    const { videoId } = await initiateAndUploadOnePart(channel.id);

    await expect(
      videosService.completeUpload(videoId, channel.id, {
        parts: [{ part_number: 1, e_tag: '"not-the-real-etag"' }],
      }),
    ).rejects.toThrow(PartListMismatchException);
  });
});

describe('VideosService — abortUpload (integration)', () => {
  let moduleRef: TestingModule;
  let videosService: VideosService;
  let storageService: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await createVideosTestModule();
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_abort_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_abort_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('aborts a real multipart upload and deletes the draft row', async () => {
    const channel = await createChannel();
    const { videoId, uploadId } = await videosService.initiateUpload(
      channel.id,
      { filename: 'clip.mp4', content_type: 'video/mp4' },
    );
    const video = await videoRepository.findOneByOrFail({ id: videoId });

    await videosService.abortUpload(videoId, channel.id);

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted).toBeNull();
    await expect(
      storageService.listParts(video.object_key, uploadId),
    ).rejects.toThrow();
  });
});
