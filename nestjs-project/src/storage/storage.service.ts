import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './storage.constants';

const DEFAULT_PRESIGN_EXPIRES_SECONDS = 3600;

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface PresignGetUrlOptions {
  expiresIn?: number;
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  buildObjectKey(videoId: string, ext: string): string {
    return `videos/${videoId}/source${ext}`;
  }

  buildThumbnailKey(videoId: string): string {
    return `videos/${videoId}/thumbnail.jpg`;
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );

    if (!result.UploadId) {
      throw new Error(
        `CreateMultipartUpload for key "${key}" returned no UploadId`,
      );
    }

    return { uploadId: result.UploadId };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.config.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    return getSignedUrl(this.client, command, {
      expiresIn: DEFAULT_PRESIGN_EXPIRES_SECONDS,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async presignGetUrl(
    key: string,
    opts: PresignGetUrlOptions = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ResponseContentDisposition: opts.responseContentDisposition,
    });

    return getSignedUrl(this.client, command, {
      expiresIn: opts.expiresIn ?? DEFAULT_PRESIGN_EXPIRES_SECONDS,
    });
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
      }),
    );
  }
}
