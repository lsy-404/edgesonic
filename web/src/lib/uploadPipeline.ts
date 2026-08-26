// SPDX-License-Identifier: AGPL-3.0-or-later

import { mapConcurrent } from "./concurrency";

export interface UploadPipelineOptions<T, O> {
  ready: T[];
  encrypted: T[];
  uploadConcurrency: number;
  conversionConcurrency: number;
  uploadReady(item: T): Promise<void>;
  convert(item: T): Promise<O>;
  uploadConverted(item: T, output: O): Promise<void>;
  onConversionFailure(item: T, error: unknown): void;
}

/**
 * Converted output stays owned by its conversion lane until its upload settles.
 * That gives conversion a natural backpressure boundary instead of caching a
 * whole batch of decrypted files in memory.
 */
export async function runUploadPipeline<T, O>(options: UploadPipelineOptions<T, O>): Promise<void> {
  await Promise.all([
    mapConcurrent(options.ready, options.uploadConcurrency, options.uploadReady),
    mapConcurrent(options.encrypted, options.conversionConcurrency, async (item) => {
      let output: O;
      try {
        output = await options.convert(item);
      } catch (error) {
        options.onConversionFailure(item, error);
        return;
      }
      await options.uploadConverted(item, output);
    }),
  ]);
}
