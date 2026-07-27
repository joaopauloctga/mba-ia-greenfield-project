import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CreateUploadDto } from './dto/create-upload.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

async function createVideosTestModule(): Promise<TestingModule> {
  const ds = createTestDataSource(ALL_ENTITIES);

  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      TypeOrmModule.forRoot(ds.options),
      TypeOrmModule.forFeature([Video]),
      StorageModule,
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
