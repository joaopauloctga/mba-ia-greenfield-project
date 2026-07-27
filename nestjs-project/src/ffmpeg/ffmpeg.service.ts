import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';

export class FfmpegProcessError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}: ${stderr}`);
    this.name = 'FfmpegProcessError';
  }
}

interface FfprobeOutput {
  format?: {
    duration?: string;
  };
}

@Injectable()
export class FfmpegService {
  async getMetadata(sourceUrl: string): Promise<{ durationSeconds: number }> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      sourceUrl,
    ]);

    const parsed = JSON.parse(stdout.toString('utf-8')) as FfprobeOutput;
    return { durationSeconds: Number(parsed.format?.duration) };
  }

  async extractThumbnail(
    sourceUrl: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const t = Math.max(durationSeconds * 0.1, 1);

    return this.run('ffmpeg', [
      '-ss',
      String(t),
      '-i',
      sourceUrl,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-f',
      'image2',
      'pipe:1',
    ]);
  }

  private run(command: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('error', (err) => reject(err));

      child.on('close', (code) => {
        if (code !== 0) {
          reject(
            new FfmpegProcessError(
              command,
              code,
              Buffer.concat(stderrChunks).toString('utf-8'),
            ),
          );
          return;
        }
        resolve(Buffer.concat(stdoutChunks));
      });
    });
  }
}
