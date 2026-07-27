import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
