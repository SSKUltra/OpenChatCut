import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadDir } from '../media-dir.ts';

export const SAMPLE_RATE = 24000;
export function wavHeader(samples: number): Buffer {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples * 2 > 0xffffffff - 36) throw new Error('Invalid WAV sample count');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
  return header;
}
export function pcm16(samples: Float32Array): Buffer {
  if (!(samples instanceof Float32Array) || !samples.length) throw new Error('Kokoro returned empty or invalid audio');
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new Error('Kokoro returned non-finite audio');
    // Two-ms edge ramps suppress discontinuities between independently generated
    // spans, without inserting silence, crossfading words, or changing duration.
    const edge = Math.min(i, samples.length - 1 - i, 48) / 48;
    const value = Math.max(-1, Math.min(1, samples[i])) * (0.5 - 0.5 * Math.cos(Math.PI * edge));
    pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
  }
  return pcm;
}
export class NarrationWav {
  private file?: FileHandle;
  private samples = 0;
  private readonly name = `${randomUUID()}.wav`;
  private readonly directory: string;
  private readonly partial: string;
  constructor(directory = uploadDir()) {
    this.directory = directory;
    this.partial = join(directory, `.${this.name}.partial`);
  }
  async append(samples: Float32Array): Promise<void> {
    const bytes = pcm16(samples);
    if (!this.file) {
      await mkdir(this.directory, { recursive: true });
      this.file = await open(this.partial, 'wx');
      await this.file.write(Buffer.alloc(44));
    }
    wavHeader(this.samples + samples.length);
    await this.file.writeFile(bytes);
    this.samples += samples.length;
  }
  async publish(signal?: AbortSignal): Promise<{ path: string; durationSeconds: number }> {
    if (!this.file) throw new Error('Kokoro returned no audio');
    signal?.throwIfAborted();
    await this.file.write(wavHeader(this.samples), 0, 44, 0);
    await this.file.sync();
    await this.file.close();
    this.file = undefined;
    signal?.throwIfAborted();
    const destination = join(this.directory, this.name);
    await rename(this.partial, destination);
    if (signal?.aborted) {
      await unlink(destination);
      signal.throwIfAborted();
    }
    return { path: `/media/uploads/${this.name}`, durationSeconds: this.samples / SAMPLE_RATE };
  }
  async discard(): Promise<void> {
    await this.file?.close().catch(() => undefined);
    this.file = undefined;
    await unlink(this.partial).catch(() => undefined);
  }
}
