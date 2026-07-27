import { randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 3;
const PART_SIZE_BYTES = 64 * 1024 * 1024;

export interface InitiateUploadResult {
  videoId: string;
  slug: string;
  uploadId: string;
  partSize: number;
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

    const { uploadId } = await this.storageService.createMultipartUpload(
      objectKey,
    );

    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return {
      videoId: video.id,
      slug: video.slug,
      uploadId,
      partSize: PART_SIZE_BYTES,
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
