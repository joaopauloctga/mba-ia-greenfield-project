import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

function slugUniqueViolation(): QueryFailedError {
  return new QueryFailedError('INSERT INTO "videos" ...', [], {
    code: '23505',
    detail: 'Key (slug)=(aaaaaaaaaaa) already exists.',
  } as any);
}

describe('VideosService — initiateUpload', () => {
  let videosService: VideosService;
  let videoRepository: { create: jest.Mock; save: jest.Mock };
  let storageService: jest.Mocked<StorageService>;

  const dto: CreateUploadDto = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
  };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((input) => input),
      save: jest.fn(async (input) => input),
    };
    storageService = {
      buildObjectKey: jest.fn(
        (videoId: string, ext: string) => `videos/${videoId}/source${ext}`,
      ),
      createMultipartUpload: jest
        .fn()
        .mockResolvedValue({ uploadId: 'upload-1' }),
    } as unknown as jest.Mocked<StorageService>;

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('creates a draft video and opens a multipart upload on the first attempt', async () => {
    const result = await videosService.initiateUpload('channel-1', dto);

    expect(result.uploadId).toBe('upload-1');
    expect(result.partSize).toBe(64 * 1024 * 1024);
    expect(result.slug).toHaveLength(11);
    expect(result.videoId).toBeDefined();
    expect(videoRepository.create).toHaveBeenCalledTimes(1);
    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      `videos/${result.videoId}/source.mp4`,
    );
  });

  it('retries slug generation on a unique-violation and does not surface it to the caller', async () => {
    videoRepository.save.mockRejectedValueOnce(slugUniqueViolation());

    const result = await videosService.initiateUpload('channel-1', dto);

    expect(result.slug).toHaveLength(11);
    expect(videoRepository.create).toHaveBeenCalledTimes(2);
    expect(videoRepository.save).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all slug attempts on repeated unique-violations', async () => {
    videoRepository.save.mockRejectedValue(slugUniqueViolation());

    await expect(
      videosService.initiateUpload('channel-1', dto),
    ).rejects.toThrow(QueryFailedError);
    expect(videoRepository.create).toHaveBeenCalledTimes(3);
    expect(videoRepository.save).toHaveBeenCalledTimes(3);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('propagates non-collision errors immediately without retrying', async () => {
    const dbError = new Error('connection refused');
    videoRepository.save.mockRejectedValueOnce(dbError);

    await expect(
      videosService.initiateUpload('channel-1', dto),
    ).rejects.toThrow(dbError);
    expect(videoRepository.create).toHaveBeenCalledTimes(1);
    expect(videoRepository.save).toHaveBeenCalledTimes(1);
  });
});

describe('VideosService — getDeliveryInfo', () => {
  let videosService: VideosService;
  let videoRepository: { findOneBy: jest.Mock };
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn(),
    };
    storageService = {
      presignGetUrl: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('throws VideoNotFoundException when no video matches the slug', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      videosService.getDeliveryInfo('missing-slug'),
    ).rejects.toThrow(VideoNotFoundException);
    expect(storageService.presignGetUrl).not.toHaveBeenCalled();
  });

  it('throws VideoNotReadyException when the video has not finished processing', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    await expect(videosService.getDeliveryInfo('some-slug')).rejects.toThrow(
      VideoNotReadyException,
    );
    expect(storageService.presignGetUrl).not.toHaveBeenCalled();
  });
});
