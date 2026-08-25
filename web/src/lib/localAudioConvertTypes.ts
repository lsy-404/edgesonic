// SPDX-License-Identifier: AGPL-3.0-or-later

export type LocalAudioConversionErrorCode = "invalid_file" | "missing_key" | "unsupported_format";

export function convertedFileName(sourceName: string, extension: string) {
  const stem = sourceName.replace(/\.[^.]+$/, "");
  return `${stem}.${extension.replace(/^\./, "").toLowerCase()}`;
}
