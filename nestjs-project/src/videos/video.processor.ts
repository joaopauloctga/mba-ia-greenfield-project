import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import {
  RECONCILE_JOB_NAME,
  RECONCILE_STALE_THRESHOLD_MS,
  VIDEO_PROCESS_JOB_ATTEMPTS,
  VIDEO_PROCESS_JOB_BACKOFF_DELAY_MS,
  VIDEO_PROCESS_JOB_NAME,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';

const PROCESSING_FAILURE_MESSAGE =
  'Video processing failed after exhausting all retry attempts';

export interface VideoProcessingJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly ffmpegService: FfmpegService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    if (job.name === RECONCILE_JOB_NAME) {
      await this.reconcileStaleProcessingVideos();
      return;
    }

    const { videoId } = job.data;
    const video = await this.videoRepository.findOneByOrFail({ id: videoId });

    const sourceUrl = await this.storageService.presignGetUrl(video.object_key);
    const { durationSeconds } = await this.ffmpegService.getMetadata(sourceUrl);
    const thumbnail = await this.ffmpegService.extractThumbnail(
      sourceUrl,
      durationSeconds,
    );

    const thumbnailKey = this.storageService.buildThumbnailKey(videoId);
    await this.storageService.putObject(thumbnailKey, thumbnail);

    video.processing_status = VideoProcessingStatus.READY;
    video.duration_seconds = Math.round(durationSeconds);
    video.thumbnail_key = thumbnailKey;
    await this.videoRepository.save(video);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJobData>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      return;
    }

    video.processing_status = VideoProcessingStatus.FAILED;
    video.processing_error = PROCESSING_FAILURE_MESSAGE;
    await this.videoRepository.save(video);
  }

  private async reconcileStaleProcessingVideos(): Promise<void> {
    const staleBefore = new Date(Date.now() - RECONCILE_STALE_THRESHOLD_MS);
    const staleVideos = await this.videoRepository.find({
      where: {
        processing_status: VideoProcessingStatus.PROCESSING,
        updated_at: LessThan(staleBefore),
      },
    });

    for (const video of staleVideos) {
      await this.videoProcessingQueue.add(
        VIDEO_PROCESS_JOB_NAME,
        { videoId: video.id },
        {
          jobId: video.id,
          attempts: VIDEO_PROCESS_JOB_ATTEMPTS,
          backoff: {
            type: 'exponential',
            delay: VIDEO_PROCESS_JOB_BACKOFF_DELAY_MS,
          },
        },
      );
    }
  }
}
