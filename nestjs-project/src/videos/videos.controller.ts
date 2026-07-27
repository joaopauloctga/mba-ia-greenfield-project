import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import {
  InitiateUploadResult,
  PartUrlsResult,
  VideoDeliveryInfo,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post('uploads')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers a draft video owned by the caller's channel and opens an S3 multipart upload session.",
  })
  @ApiResponse({
    status: 201,
    description: 'Upload session created',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        uploadId: { type: 'string' },
        partSize: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    return this.videosService.initiateUpload(channel.id, dto);
  }

  @Get('uploads/:videoId/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Issue presigned part-upload URLs',
    description:
      'Issues a batch of presigned UploadPart URLs for a range of part numbers on an open upload session.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs issued',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'from/to are missing, non-numeric, or out of bounds',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: "Caller does not own this upload session's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<PartUrlsResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    return this.videosService.getPartUrls(
      videoId,
      channel.id,
      Number(from),
      Number(to),
    );
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get video delivery info',
    description:
      'Returns video metadata plus presigned streaming and download URLs once processing has completed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video is ready for delivery',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        durationSeconds: { type: 'number' },
        streamUrl: { type: 'string' },
        downloadUrl: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'No video exists with this slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for delivery',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDeliveryInfo(
    @Param('slug') slug: string,
  ): Promise<VideoDeliveryInfo> {
    return this.videosService.getDeliveryInfo(slug);
  }
}
