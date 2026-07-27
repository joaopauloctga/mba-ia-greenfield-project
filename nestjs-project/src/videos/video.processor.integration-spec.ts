import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideoProcessingJobData, VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, Video];

function fakeJob(videoId: string): Job<VideoProcessingJobData> {
  return {
    data: { videoId },
    attemptsMade: 1,
    opts: { attempts: 3 },
  } as unknown as Job<VideoProcessingJobData>;
}

describe('VideoProcessor — process (integration)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessor;
  let storageService: StorageService;
  let ffmpegService: jest.Mocked<FfmpegService>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    ffmpegService = {
      getMetadata: jest.fn(),
      extractThumbnail: jest.fn(),
    } as unknown as jest.Mocked<FfmpegService>;

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [
        VideoProcessor,
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();

    processor = moduleRef.get(VideoProcessor);
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
    ffmpegService.getMetadata.mockReset();
    ffmpegService.extractThumbnail.mockReset();
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_proc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_proc_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('transitions a real video row to ready with duration and thumbnail key persisted', async () => {
    const channel = await createChannel();
    const objectKey = `videos/proc-test-${Date.now()}/source.mp4`;
    await storageService.putObject(objectKey, Buffer.from('source-bytes'));

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: `prc${counter}`.padEnd(11, '0').slice(0, 11),
        original_filename: 'clip.mp4',
        object_key: objectKey,
        processing_status: VideoProcessingStatus.PROCESSING,
      }),
    );

    ffmpegService.getMetadata.mockResolvedValue({ durationSeconds: 12.4 });
    ffmpegService.extractThumbnail.mockResolvedValue(
      Buffer.from('thumb-bytes'),
    );

    await processor.process(fakeJob(video.id));

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.processing_status).toBe(VideoProcessingStatus.READY);
    expect(persisted!.duration_seconds).toBe(12);
    expect(persisted!.thumbnail_key).toBe(
      storageService.buildThumbnailKey(video.id),
    );

    const thumbResponse = await fetch(
      await storageService.presignGetUrl(persisted!.thumbnail_key as string),
    );
    expect(thumbResponse.ok).toBe(true);
    const thumbBody = Buffer.from(await thumbResponse.arrayBuffer());
    expect(thumbBody.equals(Buffer.from('thumb-bytes'))).toBe(true);
  });
});
