import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile and resolve an injectable video-processing queue', () => {
    expect(moduleRef).toBeDefined();

    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
  });
});
