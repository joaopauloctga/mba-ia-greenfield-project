import { randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import {
  ForbiddenNotOwnerException,
  InvalidPartRangeException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
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

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as any;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
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
