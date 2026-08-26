// SPDX-License-Identifier: AGPL-3.0-or-later

import { mapConcurrent } from "./concurrency";

export interface UploadPipelineOptions<T, O> {
  ready: T[];
  encrypted: T[];
  uploadConcurrency: number;
  conversionConcurrency: number;
  maxConversionBytes: number;
  conversionBytes(item: T): number;
  uploadReady(item: T): Promise<void>;
  convert(item: T): Promise<O>;
  uploadConverted(item: T, output: O): Promise<void>;
  onConversionFailure(item: T, error: unknown): void;
}

export class ConversionMemoryLimitError extends Error {
  constructor(public readonly size: number, public readonly limit: number) {
    super(`conversion requires ${size} bytes, exceeding the ${limit}-byte memory limit`);
    this.name = "ConversionMemoryLimitError";
  }
}

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) { this.available = limit; }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.available === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.available--;
    try { return await work(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    }
  }
}

class ByteGate {
  private used = 0;
  private readonly waiters: Array<{ size: number; resolve: () => void }> = [];

  constructor(private readonly limit: number) {}

  async reserve(size: number): Promise<() => void> {
    if (size > this.limit) throw new ConversionMemoryLimitError(size, this.limit);
    if (this.used + size > this.limit) {
      await new Promise<void>((resolve) => this.waiters.push({ size, resolve }));
    }
    this.used += size;
    return () => {
      this.used -= size;
      for (let index = 0; index < this.waiters.length;) {
        const next = this.waiters[index];
        if (this.used + next.size > this.limit) { index++; continue; }
        this.waiters.splice(index, 1);
        next.resolve();
      }
    };
  }
}

/**
 * Converted output stays owned by its conversion lane until its upload settles.
 * That gives conversion a natural backpressure boundary instead of caching a
 * whole batch of decrypted files in memory.
 */
export async function runUploadPipeline<T, O>(options: UploadPipelineOptions<T, O>): Promise<void> {
  const uploads = new Semaphore(options.uploadConcurrency);
  const memory = new ByteGate(options.maxConversionBytes);
  await Promise.all([
    mapConcurrent(options.ready, options.uploadConcurrency, async (item) => { await uploads.run(() => options.uploadReady(item)); }),
    mapConcurrent(options.encrypted, options.conversionConcurrency, async (item) => {
      let output: O;
      let release: (() => void) | undefined;
      try {
        release = await memory.reserve(options.conversionBytes(item));
        output = await options.convert(item);
      } catch (error) {
        release?.();
        options.onConversionFailure(item, error);
        return;
      }
      try { await uploads.run(() => options.uploadConverted(item, output)); }
      finally { release(); }
    }),
  ]);
}
