// SPDX-License-Identifier: AGPL-3.0-or-later

import { convertIntegerPcmWav } from "./wavFlacConvertEngine";
import { WavFlacConversionError } from "./wavFlacConvertCore";

interface ConvertRequest { buffer: ArrayBuffer }
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ConvertRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

workerScope.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  try {
    const converted = await convertIntegerPcmWav(new Uint8Array(event.data.buffer), (percent) => {
      workerScope.postMessage({ type: "progress", percent });
    });
    const buffer = converted.flac.slice().buffer;
    workerScope.postMessage({ type: "done", buffer, evidence: converted.evidence }, [buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      code: error instanceof WavFlacConversionError ? error.code : "conversion_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
