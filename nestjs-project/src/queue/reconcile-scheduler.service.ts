import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  RECONCILE_JOB_NAME,
  RECONCILE_STALE_THRESHOLD_MS,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

@Injectable()
export class ReconcileSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.videoProcessingQueue.add(
      RECONCILE_JOB_NAME,
      {},
      { repeat: { every: RECONCILE_STALE_THRESHOLD_MS } },
    );
  }
}
