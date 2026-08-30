// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

export type UploadKind = "audio" | "lyrics" | "variant" | "sidecar" | "encrypted";

export interface UploadFileLike {
  name: string;
  webkitRelativePath?: string;
}

export interface UploadItem<T extends UploadFileLike = UploadFileLike> {
  file: T;
  kind: UploadKind;
  stem: string;
  relativeDir: string;
  selected: boolean;
}

const AUDIO_EXTENSIONS = new Set(["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "aiff", "alac", "ape", "wma"]);
const LYRIC_EXTENSIONS = new Set(["lrc", "ttml", "krc", "klrc"]);
export const ENCRYPTED_AUDIO_EXTENSIONS = new Set([
  "ncm", "uc", "mg3d", "kwm", "xm", "x2m", "x3m", "tm0", "tm2", "tm3", "tm6", "cache",
  "qmc0", "qmc2", "qmc3", "qmc4", "qmc6", "qmc8", "qmcflac", "qmcogg", "tkm",
  "bkcmp3", "bkcm4a", "bkcflac", "bkcwav", "bkcape", "bkcogg", "bkcwma",
  "mggl", "mflac", "mflac0", "mflach", "mgg", "mgg0", "mgg1", "mmp4",
  "666c6163", "6d7033", "6f6767", "6d3461", "776176", "kgm", "kgma", "vpr",
]);

export function suffixOf(name: string) { return name.split(".").pop()?.toLowerCase() || ""; }
export function stemOf(name: string) { return name.replace(/\.[^.]+$/, "").toLocaleLowerCase(); }
export function relativeDirOf(file: UploadFileLike) {
  const relative = file.webkitRelativePath || "";
  const slash = relative.lastIndexOf("/");
  return slash > -1 ? relative.slice(0, slash) : "";
}

export function classifyUploadItems<T extends UploadFileLike>(files: T[]): UploadItem<T>[] {
  const audioKeys = new Map<string, number>();
  return files.map((file) => {
    const suffix = suffixOf(file.name);
    const stem = stemOf(file.name);
    const relativeDir = relativeDirOf(file);
    let kind: UploadKind = "sidecar";
    if (LYRIC_EXTENSIONS.has(suffix)) kind = "lyrics";
    else if (ENCRYPTED_AUDIO_EXTENSIONS.has(suffix)) kind = "encrypted";
    else if (AUDIO_EXTENSIONS.has(suffix)) {
      const key = `${relativeDir}\u0000${stem}`;
      const count = audioKeys.get(key) || 0;
      audioKeys.set(key, count + 1);
      kind = count === 0 ? "audio" : "variant";
    }
    return { file, kind, stem, relativeDir, selected: kind !== "encrypted" };
  });
}

export function normalizeAudioVariants<T extends UploadFileLike>(items: UploadItem<T>[]) {
  const audioKeys = new Set<string>();
  for (const item of items) {
    if (item.kind !== "audio" && item.kind !== "variant") continue;
    const key = `${item.relativeDir}\u0000${item.stem}`;
    item.kind = audioKeys.has(key) ? "variant" : "audio";
    audioKeys.add(key);
  }
  return items;
}

export function audioKindAtIndex<T extends UploadFileLike>(items: UploadItem<T>[], index: number): "audio" | "variant" {
  const item = items[index];
  const key = `${item.relativeDir}\u0000${item.stem}`;
  for (let current = 0; current < index; current++) {
    const candidate = items[current];
    if ((candidate.kind === "audio" || candidate.kind === "variant" || candidate.kind === "encrypted") &&
      `${candidate.relativeDir}\u0000${candidate.stem}` === key) return "variant";
  }
  return "audio";
}

export function normalizeAudioOrder<T extends UploadFileLike>(items: UploadItem<T>[]) {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind !== "audio" && item.kind !== "variant") continue;
    item.kind = audioKindAtIndex(items, index);
  }
  return items;
}

export function isUploadIncluded(item: UploadItem, options: { includeLyrics: boolean; includeVariants: boolean }) {
  return item.selected && item.kind !== "encrypted" &&
    (item.kind !== "lyrics" || options.includeLyrics) &&
    (item.kind !== "variant" || options.includeVariants);
}

export function uploadPathFor(basePath: string, item: UploadItem) {
  const base = basePath.replace(/\/+$/, "");
  return item.relativeDir ? (base ? `${base}/${item.relativeDir}` : item.relativeDir) : base || undefined;
}
