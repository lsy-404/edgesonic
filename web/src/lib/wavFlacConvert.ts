// SPDX-License-Identifier: AGPL-3.0-or-later

import { convertedFileName } from "./localAudioConvertTypes";
import type { WavFlacConversionError } from "./wavFlacConvertCore";

export interface ConvertedWavFile {
  file: File;
  sourceBytes: number;
  outputBytes: number;
}

export function convertWavFile(file: File, onProgress?: (percent: number) => void): Promise<ConvertedWavFile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./wavFlacConvert.worker.ts", import.meta.url), { type: "module" });
    const stop = () => worker.terminate();
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "WAV conversion worker failed."));
    };
    worker.onmessage = (event: MessageEvent<{
      type: "progress" | "done" | "error";
      percent?: number;
      buffer?: ArrayBuffer;
      code?: string;
      detail?: string;
    }>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.percent || 0);
        return;
      }
      stop();
      if (message.type === "error" || !message.buffer) {
        const error = new Error(message.detail || "WAV conversion failed.") as WavFlacConversionError;
        Object.defineProperty(error, "code", { value: message.code || "conversion_failed" });
        reject(error);
        return;
      }
      const output = new File([message.buffer], convertedFileName(file.name, "flac"), {
        type: "audio/flac",
        lastModified: file.lastModified,
      });
      resolve({ file: output, sourceBytes: file.size, outputBytes: output.size });
    };
    file.arrayBuffer().then((buffer) => worker.postMessage({ buffer }, [buffer])).catch((error) => {
      stop();
      reject(error);
    });
  });
}
