import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideoProcessingJobData, VideoProcessor } from './video.processor';

function fakeJob(
  overrides: {
    attemptsMade?: number;
    attempts?: number;
    videoId?: string;
  } = {},
): Job<VideoProcessingJobData> {
  const { attemptsMade = 1, attempts = 3, videoId = 'video-1' } = overrides;
  return {
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
    save: jest.Mock;
  };
  let ffmpegService: jest.Mocked<FfmpegService>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    videoRepository = {
      findOneByOrFail: jest.fn(),
      findOneBy: jest.fn(),
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

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: FfmpegService, useValue: ffmpegService },
        { provide: StorageService, useValue: storageService },
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
});
