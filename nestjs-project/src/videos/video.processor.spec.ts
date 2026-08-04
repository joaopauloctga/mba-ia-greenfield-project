import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, Queue } from 'bullmq';
import { LessThan } from 'typeorm';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import {
  RECONCILE_JOB_NAME,
  RECONCILE_STALE_THRESHOLD_MS,
  VIDEO_PROCESS_JOB_ATTEMPTS,
  VIDEO_PROCESS_JOB_NAME,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideoProcessingJobData, VideoProcessor } from './video.processor';

function fakeJob(
  overrides: {
    name?: string;
    attemptsMade?: number;
    attempts?: number;
    videoId?: string;
  } = {},
): Job<VideoProcessingJobData> {
  const {
    name = VIDEO_PROCESS_JOB_NAME,
    attemptsMade = 1,
    attempts = 3,
    videoId = 'video-1',
  } = overrides;
  return {
    name,
    data: { videoId },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<VideoProcessingJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videoRepository: {
    findOneByOrFail: jest.Mock;
    findOneBy: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
  };
  let ffmpegService: jest.Mocked<FfmpegService>;
  let storageService: jest.Mocked<StorageService>;
  let queue: jest.Mocked<Queue>;

  beforeEach(async () => {
    videoRepository = {
      findOneByOrFail: jest.fn(),
      findOneBy: jest.fn(),
      find: jest.fn(),
      save: jest.fn(async (v) => v),
    };
    ffmpegService = {
      getMetadata: jest.fn(),
      extractThumbnail: jest.fn(),
    } as unknown as jest.Mocked<FfmpegService>;
    storageService = {
      presignGetUrl: jest.fn(),
      putObject: jest.fn(),
      buildThumbnailKey: jest.fn(
        (videoId: string) => `videos/${videoId}/thumbnail.jpg`,
      ),
    } as unknown as jest.Mocked<StorageService>;
    queue = { add: jest.fn() } as unknown as jest.Mocked<Queue>;

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: FfmpegService, useValue: ffmpegService },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('transitions the video to ready with duration and thumbnail key on success', async () => {
      const video = {
        id: 'video-1',
        object_key: 'videos/video-1/source.mp4',
        processing_status: VideoProcessingStatus.PROCESSING,
      } as Video;
      videoRepository.findOneByOrFail.mockResolvedValue(video);
      storageService.presignGetUrl.mockResolvedValue(
        'https://storage.example/source',
      );
      ffmpegService.getMetadata.mockResolvedValue({ durationSeconds: 42.7 });
      ffmpegService.extractThumbnail.mockResolvedValue(Buffer.from('thumb'));

      await processor.process(fakeJob());

      expect(ffmpegService.getMetadata).toHaveBeenCalledWith(
        'https://storage.example/source',
      );
      expect(ffmpegService.extractThumbnail).toHaveBeenCalledWith(
        'https://storage.example/source',
        42.7,
      );
      expect(storageService.putObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        Buffer.from('thumb'),
      );
      expect(video.processing_status).toBe(VideoProcessingStatus.READY);
      expect(video.duration_seconds).toBe(43);
      expect(video.thumbnail_key).toBe('videos/video-1/thumbnail.jpg');
      expect(videoRepository.save).toHaveBeenCalledWith(video);
    });
  });

  describe('onFailed', () => {
    it('marks the video as failed with a redacted error on the final attempt', async () => {
      const video = {
        id: 'video-1',
        processing_status: VideoProcessingStatus.PROCESSING,
      } as Video;
      videoRepository.findOneBy.mockResolvedValue(video);

      await processor.onFailed(fakeJob({ attemptsMade: 3, attempts: 3 }));

      expect(video.processing_status).toBe(VideoProcessingStatus.FAILED);
      expect(video.processing_error).toBeTruthy();
      expect(video.processing_error).not.toContain('https://');
      expect(videoRepository.save).toHaveBeenCalledWith(video);
    });

    it('does not mark the video as failed before the final attempt', async () => {
      await processor.onFailed(fakeJob({ attemptsMade: 1, attempts: 3 }));

      expect(videoRepository.findOneBy).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('process — reconcile branch', () => {
    const fixedNow = new Date('2026-01-01T00:00:00.000Z').getTime();

    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    });

    afterEach(() => {
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('queries stale processing rows and re-enqueues each with the same jobId/attempts contract', async () => {
      videoRepository.find.mockResolvedValue([
        { id: 'stale-1' },
        { id: 'stale-2' },
      ]);

      await processor.process(fakeJob({ name: RECONCILE_JOB_NAME }));

      expect(videoRepository.find).toHaveBeenCalledWith({
        where: {
          processing_status: VideoProcessingStatus.PROCESSING,
          updated_at: LessThan(
            new Date(fixedNow - RECONCILE_STALE_THRESHOLD_MS),
          ),
        },
      });
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        VIDEO_PROCESS_JOB_NAME,
        { videoId: 'stale-1' },
        expect.objectContaining({
          jobId: 'stale-1',
          attempts: VIDEO_PROCESS_JOB_ATTEMPTS,
        }),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
        VIDEO_PROCESS_JOB_NAME,
        { videoId: 'stale-2' },
        expect.objectContaining({
          jobId: 'stale-2',
          attempts: VIDEO_PROCESS_JOB_ATTEMPTS,
        }),
      );
    });

    it('does not re-enqueue anything when no rows match the stale filter', async () => {
      videoRepository.find.mockResolvedValue([]);

      await processor.process(fakeJob({ name: RECONCILE_JOB_NAME }));

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('does not query for stale rows on a regular video.process job', async () => {
      videoRepository.findOneByOrFail.mockResolvedValue({
        id: 'video-1',
        object_key: 'videos/video-1/source.mp4',
      } as Video);
      storageService.presignGetUrl.mockResolvedValue(
        'https://storage.example/source',
      );
      ffmpegService.getMetadata.mockResolvedValue({ durationSeconds: 5 });
      ffmpegService.extractThumbnail.mockResolvedValue(Buffer.from('thumb'));

      await processor.process(fakeJob());

      expect(videoRepository.find).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
