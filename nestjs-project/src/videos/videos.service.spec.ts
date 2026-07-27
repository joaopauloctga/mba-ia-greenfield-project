import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError } from 'typeorm';
import {
  ForbiddenNotOwnerException,
  InvalidPartRangeException,
  PartListMismatchException,
  UploadAlreadyCompletedException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
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
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
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
      'video/mp4',
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
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('throws VideoNotFoundException when no video matches the slug', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(videosService.getDeliveryInfo('missing-slug')).rejects.toThrow(
      VideoNotFoundException,
    );
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

describe('VideosService — getPartUrls', () => {
  let videosService: VideosService;
  let videoRepository: { findOneBy: jest.Mock };
  let storageService: jest.Mocked<StorageService>;

  const openVideo = {
    id: 'video-1',
    channel_id: 'channel-1',
    object_key: 'videos/video-1/source.mp4',
    upload_id: 'upload-1',
    processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
  };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn(),
    };
    storageService = {
      presignUploadPart: jest
        .fn()
        .mockImplementation(
          async (_key: string, _uploadId: string, partNumber: number) =>
            `https://storage.example/part-${partNumber}`,
        ),
    } as unknown as jest.Mocked<StorageService>;

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('returns one presigned URL per part number in range', async () => {
    videoRepository.findOneBy.mockResolvedValue(openVideo);

    const result = await videosService.getPartUrls(
      'video-1',
      'channel-1',
      1,
      5,
    );

    expect(result.parts).toHaveLength(5);
    expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(result.parts[0].url).toBe('https://storage.example/part-1');
    expect(result.parts.every((p) => p.expiresAt)).toBe(true);
    expect(storageService.presignUploadPart).toHaveBeenCalledTimes(5);
    expect(storageService.presignUploadPart).toHaveBeenCalledWith(
      openVideo.object_key,
      openVideo.upload_id,
      3,
    );
  });

  it('throws UploadSessionNotFoundException when no video matches videoId', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      videosService.getPartUrls('missing', 'channel-1', 1, 5),
    ).rejects.toThrow(UploadSessionNotFoundException);
    expect(storageService.presignUploadPart).not.toHaveBeenCalled();
  });

  it('throws UploadSessionNotFoundException when the video is no longer awaiting upload', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      ...openVideo,
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    await expect(
      videosService.getPartUrls('video-1', 'channel-1', 1, 5),
    ).rejects.toThrow(UploadSessionNotFoundException);
    expect(storageService.presignUploadPart).not.toHaveBeenCalled();
  });

  it('throws ForbiddenNotOwnerException when the caller channel does not own the video', async () => {
    videoRepository.findOneBy.mockResolvedValue(openVideo);

    await expect(
      videosService.getPartUrls('video-1', 'other-channel', 1, 5),
    ).rejects.toThrow(ForbiddenNotOwnerException);
    expect(storageService.presignUploadPart).not.toHaveBeenCalled();
  });

  it.each([
    ['from below 1', 0, 5],
    ['to above 10000', 1, 10001],
    ['from greater than to', 5, 1],
    ['non-numeric from', NaN, 5],
    ['non-numeric to', 1, NaN],
  ])('throws InvalidPartRangeException for %s', async (_label, from, to) => {
    videoRepository.findOneBy.mockResolvedValue(openVideo);

    await expect(
      videosService.getPartUrls('video-1', 'channel-1', from, to),
    ).rejects.toThrow(InvalidPartRangeException);
    expect(storageService.presignUploadPart).not.toHaveBeenCalled();
  });
});

describe('VideosService — completeUpload', () => {
  let videosService: VideosService;
  let videoRepository: { findOneBy: jest.Mock; save: jest.Mock };
  let storageService: jest.Mocked<StorageService>;
  let queue: jest.Mocked<Queue>;

  const openVideo = {
    id: 'video-1',
    channel_id: 'channel-1',
    object_key: 'videos/video-1/source.mp4',
    upload_id: 'upload-1',
    processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
  };

  const dto: CompleteUploadDto = {
    parts: [{ part_number: 1, e_tag: 'etag-1' }],
  };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn(),
      save: jest.fn(async (input) => input),
    };
    storageService = {
      listParts: jest
        .fn()
        .mockResolvedValue([{ partNumber: 1, eTag: 'etag-1' }]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StorageService>;
    queue = { add: jest.fn() } as unknown as jest.Mocked<Queue>;

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('completes the upload, transitions to processing, and enqueues exactly one job', async () => {
    videoRepository.findOneBy.mockResolvedValue({ ...openVideo });

    const result = await videosService.completeUpload(
      'video-1',
      'channel-1',
      dto,
    );

    expect(result).toEqual({
      videoId: 'video-1',
      processingStatus: VideoProcessingStatus.PROCESSING,
    });
    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      openVideo.object_key,
      openVideo.upload_id,
      [{ partNumber: 1, eTag: 'etag-1' }],
    );
    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        processing_status: VideoProcessingStatus.PROCESSING,
        upload_id: null,
      }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'video.process',
      { videoId: 'video-1' },
      expect.objectContaining({ jobId: 'video-1', attempts: 3 }),
    );
  });

  it('throws UploadSessionNotFoundException when no video matches videoId', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      videosService.completeUpload('missing', 'channel-1', dto),
    ).rejects.toThrow(UploadSessionNotFoundException);
    expect(storageService.listParts).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('throws ForbiddenNotOwnerException when the caller channel does not own the video', async () => {
    videoRepository.findOneBy.mockResolvedValue({ ...openVideo });

    await expect(
      videosService.completeUpload('video-1', 'other-channel', dto),
    ).rejects.toThrow(ForbiddenNotOwnerException);
    expect(storageService.listParts).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('throws UploadAlreadyCompletedException when the session left awaiting_upload', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      ...openVideo,
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    await expect(
      videosService.completeUpload('video-1', 'channel-1', dto),
    ).rejects.toThrow(UploadAlreadyCompletedException);
    expect(storageService.listParts).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('throws PartListMismatchException when storage reports a different part count', async () => {
    videoRepository.findOneBy.mockResolvedValue({ ...openVideo });
    storageService.listParts.mockResolvedValue([]);

    await expect(
      videosService.completeUpload('video-1', 'channel-1', dto),
    ).rejects.toThrow(PartListMismatchException);
    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('throws PartListMismatchException when an ETag does not match storage', async () => {
    videoRepository.findOneBy.mockResolvedValue({ ...openVideo });
    storageService.listParts.mockResolvedValue([
      { partNumber: 1, eTag: 'different-etag' },
    ]);

    await expect(
      videosService.completeUpload('video-1', 'channel-1', dto),
    ).rejects.toThrow(PartListMismatchException);
    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('VideosService — abortUpload', () => {
  let videosService: VideosService;
  let videoRepository: { findOneBy: jest.Mock; remove: jest.Mock };
  let storageService: jest.Mocked<StorageService>;

  const openVideo = {
    id: 'video-1',
    channel_id: 'channel-1',
    object_key: 'videos/video-1/source.mp4',
    upload_id: 'upload-1',
    processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
  };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn(),
      remove: jest.fn(async (input) => input),
    };
    storageService = {
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StorageService>;

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('aborts the multipart upload and removes the draft row', async () => {
    videoRepository.findOneBy.mockResolvedValue({ ...openVideo });

    await videosService.abortUpload('video-1', 'channel-1');

    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      openVideo.object_key,
      openVideo.upload_id,
    );
    expect(videoRepository.remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'video-1' }),
    );
  });

  it('throws UploadSessionNotFoundException when no video matches videoId', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      videosService.abortUpload('missing', 'channel-1'),
    ).rejects.toThrow(UploadSessionNotFoundException);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.remove).not.toHaveBeenCalled();
  });

  it('throws ForbiddenNotOwnerException when the caller channel does not own the video', async () => {
    videoRepository.findOneBy.mockResolvedValue({ ...openVideo });

    await expect(
      videosService.abortUpload('video-1', 'other-channel'),
    ).rejects.toThrow(ForbiddenNotOwnerException);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.remove).not.toHaveBeenCalled();
  });

  it('throws UploadAlreadyCompletedException when the session left awaiting_upload', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      ...openVideo,
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    await expect(
      videosService.abortUpload('video-1', 'channel-1'),
    ).rejects.toThrow(UploadAlreadyCompletedException);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.remove).not.toHaveBeenCalled();
  });
});
