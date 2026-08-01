import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoProcessingStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function slug(): string {
    counter += 1;
    return `slug${counter}`.padEnd(11, '0').slice(0, 11);
  }

  it('should reject a video without channel_id (not-null FK constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: slug(),
          original_filename: 'movie.mp4',
          object_key: 'videos/x/source.mp4',
        } as Partial<Video>),
      ),
    ).rejects.toThrow();
  });

  it('should reject two videos with the same slug (unique constraint)', async () => {
    const channel = await createChannel();
    const duplicateSlug = slug();

    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: duplicateSlug,
        original_filename: 'movie-1.mp4',
        object_key: 'videos/1/source.mp4',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          slug: duplicateSlug,
          original_filename: 'movie-2.mp4',
          object_key: 'videos/2/source.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default processing_status to awaiting_upload when omitted', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: slug(),
        original_filename: 'movie.mp4',
        object_key: 'videos/3/source.mp4',
      }),
    );

    expect(video.processing_status).toBe(VideoProcessingStatus.AWAITING_UPLOAD);
  });

  it('should reject a channel deletion violating the FK constraint from an existing video', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: slug(),
        original_filename: 'movie.mp4',
        object_key: 'videos/4/source.mp4',
      }),
    );

    await expect(
      dataSource.query('DELETE FROM "channels" WHERE "id" = $1', [channel.id]),
    ).rejects.toThrow();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: slug(),
        original_filename: 'movie.mp4',
        object_key: 'videos/5/source.mp4',
      }),
    );

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
