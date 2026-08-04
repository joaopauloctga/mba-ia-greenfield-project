import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { FfmpegProcessError, FfmpegService } from './ffmpeg.service';

jest.mock('child_process');

const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createMockChildProcess() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(() => {
    service = new FfmpegService();
    mockedSpawn.mockReset();
  });

  describe('getMetadata', () => {
    it('spawns ffprobe with array-form arguments and parses the duration from JSON stdout', async () => {
      const child = createMockChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.getMetadata('https://example.com/video.mp4');

      expect(mockedSpawn).toHaveBeenCalledWith('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'https://example.com/video.mp4',
      ]);

      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ format: { duration: '125.5' } })),
      );
      child.emit('close', 0);

      await expect(promise).resolves.toEqual({ durationSeconds: 125.5 });
    });

    it('rejects with an error carrying the exit code and stderr output on a non-zero exit code', async () => {
      const child = createMockChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.getMetadata('https://example.com/video.mp4');

      child.stderr.emit('data', Buffer.from('invalid data found'));
      child.emit('close', 1);

      await expect(promise).rejects.toMatchObject({
        name: 'FfmpegProcessError',
        exitCode: 1,
        stderr: 'invalid data found',
      });
      await expect(promise).rejects.toBeInstanceOf(FfmpegProcessError);
    });
  });

  describe('extractThumbnail', () => {
    it('computes t = 10 for a 100-second video and spawns ffmpeg with array-form arguments', async () => {
      const child = createMockChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.extractThumbnail(
        'https://example.com/video.mp4',
        100,
      );

      expect(mockedSpawn).toHaveBeenCalledWith('ffmpeg', [
        '-ss',
        '10',
        '-i',
        'https://example.com/video.mp4',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-f',
        'image2',
        'pipe:1',
      ]);

      child.stdout.emit('data', Buffer.from('thumbnail-bytes'));
      child.emit('close', 0);

      await expect(promise).resolves.toEqual(Buffer.from('thumbnail-bytes'));
    });

    it('computes the floor t = 1 for a 2-second video, never seeking past the end', async () => {
      const child = createMockChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.extractThumbnail(
        'https://example.com/video.mp4',
        2,
      );

      expect(mockedSpawn).toHaveBeenCalledWith(
        'ffmpeg',
        expect.arrayContaining(['-ss', '1']),
      );

      child.emit('close', 0);
      await promise;
    });

    it('rejects with an error carrying the exit code and stderr output on a non-zero exit code', async () => {
      const child = createMockChildProcess();
      mockedSpawn.mockReturnValue(child);

      const promise = service.extractThumbnail(
        'https://example.com/video.mp4',
        100,
      );

      child.stderr.emit('data', Buffer.from('cannot find codec parameters'));
      child.emit('close', 2);

      await expect(promise).rejects.toMatchObject({
        name: 'FfmpegProcessError',
        exitCode: 2,
        stderr: 'cannot find codec parameters',
      });
    });
  });
});
