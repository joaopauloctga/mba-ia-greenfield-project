import { randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import {
  ForbiddenNotOwnerException,
  InvalidPartRangeException,
  PartListMismatchException,
  UploadAlreadyCompletedException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB_NAME,
} from '../queue/queue.constants';
import { CompletedPart, StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 3;
const PART_SIZE_BYTES = 64 * 1024 * 1024;
const DELIVERY_URL_EXPIRES_SECONDS = 3600;
const UPLOAD_PART_URL_EXPIRES_SECONDS = 3600;
const MIN_PART_NUMBER = 1;
const MAX_PART_NUMBER = 10000;
const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_DELAY_MS = 1000;

export interface InitiateUploadResult {
  videoId: string;
  slug: string;
  uploadId: string;
  partSize: number;
}

export interface VideoDeliveryInfo {
  id: string;
  slug: string;
  durationSeconds: number;
  streamUrl: string;
  downloadUrl: string;
  expiresAt: string;
}

export interface PartUrlEntry {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface PartUrlsResult {
  parts: PartUrlEntry[];
}

export interface CompleteUploadResult {
  videoId: string;
  processingStatus: VideoProcessingStatus;
}

interface PostgresDriverError {
  code?: string;
  detail?: string;
}

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PostgresDriverError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}

function generateSlug(): string {
  return randomBytes(8).toString('base64url');
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {}

  async initiateUpload(
    channelId: string,
    dto: CreateUploadDto,
  ): Promise<InitiateUploadResult> {
    const ext = extname(dto.filename);
    const videoId = randomUUID();
    const objectKey = this.storageService.buildObjectKey(videoId, ext);

    const video = await this.createDraftWithRetry(
      videoId,
      channelId,
      objectKey,
      dto,
    );

    const { uploadId } =
      await this.storageService.createMultipartUpload(objectKey);

    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return {
      videoId: video.id,
      slug: video.slug,
      uploadId,
      partSize: PART_SIZE_BYTES,
    };
  }

  async getDeliveryInfo(slug: string): Promise<VideoDeliveryInfo> {
    const video = await this.videoRepository.findOneBy({ slug });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.processing_status !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }

    const expiresIn = DELIVERY_URL_EXPIRES_SECONDS;
    const [streamUrl, downloadUrl] = await Promise.all([
      this.storageService.presignGetUrl(video.object_key, { expiresIn }),
      this.storageService.presignGetUrl(video.object_key, {
        expiresIn,
        responseContentDisposition: `attachment; filename="${video.original_filename}"`,
      }),
    ]);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    return {
      id: video.id,
      slug: video.slug,
      durationSeconds: video.duration_seconds as number,
      streamUrl,
      downloadUrl,
      expiresAt,
    };
  }

  async getPartUrls(
    videoId: string,
    channelId: string,
    from: number,
    to: number,
  ): Promise<PartUrlsResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (
      !video ||
      video.processing_status !== VideoProcessingStatus.AWAITING_UPLOAD
    ) {
      throw new UploadSessionNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new ForbiddenNotOwnerException();
    }
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < MIN_PART_NUMBER ||
      to > MAX_PART_NUMBER ||
      from > to
    ) {
      throw new InvalidPartRangeException();
    }

    const expiresAt = new Date(
      Date.now() + UPLOAD_PART_URL_EXPIRES_SECONDS * 1000,
    ).toISOString();
    const partNumbers = Array.from(
      { length: to - from + 1 },
      (_, i) => from + i,
    );
    const urls = await Promise.all(
      partNumbers.map((partNumber) =>
        this.storageService.presignUploadPart(
          video.object_key,
          video.upload_id as string,
          partNumber,
        ),
      ),
    );

    return {
      parts: partNumbers.map((partNumber, i) => ({
        partNumber,
        url: urls[i],
        expiresAt,
      })),
    };
  }

  async completeUpload(
    videoId: string,
    channelId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new UploadSessionNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new ForbiddenNotOwnerException();
    }
    if (video.processing_status !== VideoProcessingStatus.AWAITING_UPLOAD) {
      throw new UploadAlreadyCompletedException();
    }

    await this.assertPartsMatchStorage(video, dto);

    const parts: CompletedPart[] = dto.parts.map((part) => ({
      partNumber: part.part_number,
      eTag: part.e_tag,
    }));
    await this.storageService.completeMultipartUpload(
      video.object_key,
      video.upload_id as string,
      parts,
    );

    video.processing_status = VideoProcessingStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.videoProcessingQueue.add(
      VIDEO_PROCESS_JOB_NAME,
      { videoId },
      {
        jobId: videoId,
        attempts: JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: JOB_BACKOFF_DELAY_MS },
      },
    );

    return {
      videoId: video.id,
      processingStatus: video.processing_status,
    };
  }

  async abortUpload(videoId: string, channelId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new UploadSessionNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new ForbiddenNotOwnerException();
    }
    if (video.processing_status !== VideoProcessingStatus.AWAITING_UPLOAD) {
      throw new UploadAlreadyCompletedException();
    }

    await this.storageService.abortMultipartUpload(
      video.object_key,
      video.upload_id as string,
    );
    await this.videoRepository.remove(video);
  }

  private async assertPartsMatchStorage(
    video: Video,
    dto: CompleteUploadDto,
  ): Promise<void> {
    const storageParts = await this.storageService.listParts(
      video.object_key,
      video.upload_id as string,
    );
    if (storageParts.length !== dto.parts.length) {
      throw new PartListMismatchException();
    }

    const eTagByPartNumber = new Map(
      storageParts.map((part) => [part.partNumber, part.eTag]),
    );
    for (const part of dto.parts) {
      if (eTagByPartNumber.get(part.part_number) !== part.e_tag) {
        throw new PartListMismatchException();
      }
    }
  }

  private async createDraftWithRetry(
    videoId: string,
    channelId: string,
    objectKey: string,
    dto: CreateUploadDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: videoId,
            channel_id: channelId,
            slug: generateSlug(),
            original_filename: dto.filename,
            object_key: objectKey,
            processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
          }),
        );
      } catch (err) {
        const isLastAttempt = attempt === MAX_SLUG_ATTEMPTS - 1;
        if (!isPgUniqueViolationOnColumn(err, SLUG_COLUMN) || isLastAttempt) {
          throw err;
        }
      }
    }

    throw new Error('unreachable');
  }
}
