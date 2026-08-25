// SPDX-License-Identifier: AGPL-3.0-or-later

import { convertedFileName, type LocalAudioConversionErrorCode } from "./localAudioConvertTypes";

export interface ConvertedLocalFile {
  file: File;
  cipher: string;
}

export class LocalFileConversionError extends Error {
  constructor(public readonly code: LocalAudioConversionErrorCode, message: string) {
    super(message);
    this.name = "LocalFileConversionError";
  }
}

export function convertEncryptedFile(file: File, extension: string, onProgress?: (percent: number) => void): Promise<ConvertedLocalFile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./localAudioConvert.worker.ts", import.meta.url), { type: "module" });
    const stop = () => worker.terminate();
    worker.onerror = (event) => {
      stop();
      reject(new LocalFileConversionError("invalid_file", event.message || "local conversion worker failed"));
    };
    worker.onmessage = (event: MessageEvent<{
      type: "progress" | "done" | "error";
      percent?: number;
      buffer?: ArrayBuffer;
      extension?: string;
      mimeType?: string;
      cipher?: string;
      code?: LocalAudioConversionErrorCode;
      detail?: string;
    }>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.percent || 0);
        return;
      }
      stop();
      if (message.type === "error" || !message.buffer || !message.extension) {
        reject(new LocalFileConversionError(message.code || "invalid_file", message.detail || "local conversion failed"));
        return;
      }
      const output = new File([message.buffer], convertedFileName(file.name, message.extension), {
        type: message.mimeType || "application/octet-stream",
        lastModified: file.lastModified,
      });
      resolve({ file: output, cipher: message.cipher || "local" });
    };
    file.arrayBuffer().then((buffer) => {
      worker.postMessage({ extension, buffer }, [buffer]);
    }).catch((error) => {
      stop();
      reject(new LocalFileConversionError("invalid_file", error instanceof Error ? error.message : String(error)));
    });
  });
}
