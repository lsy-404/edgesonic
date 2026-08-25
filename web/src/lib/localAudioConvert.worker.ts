// SPDX-License-Identifier: AGPL-3.0-or-later

import { convertEncryptedBytes, LocalAudioConversionError } from "./localAudioConvertCore";

interface ConvertRequest { extension: string; buffer: ArrayBuffer }

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ConvertRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

workerScope.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  try {
    const result = await convertEncryptedBytes(event.data.extension, new Uint8Array(event.data.buffer), (percent) => {
      workerScope.postMessage({ type: "progress", percent });
    });
    const buffer = result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength) as ArrayBuffer;
    workerScope.postMessage({ type: "done", buffer, extension: result.extension, mimeType: result.mimeType, cipher: result.cipher }, [buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      code: error instanceof LocalAudioConversionError ? error.code : "invalid_file",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
