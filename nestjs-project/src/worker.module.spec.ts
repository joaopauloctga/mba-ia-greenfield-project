import { Test, TestingModule } from '@nestjs/testing';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile standalone via a headless application context', () => {
    expect(moduleRef).toBeDefined();
  });
});
