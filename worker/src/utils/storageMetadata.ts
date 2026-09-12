export interface StorageMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
}

export function recoverMetadataFromStoragePath<T extends StorageMetadata>(
  storageUri: string,
  metadata: T,
): T {
  const result = { ...metadata } as T;
  const path = storagePath(storageUri);
  if (!path) return result;

  const segments = path.split("/").map(decodeSegment);
  const filename = segments.at(-1) || "";
  const albumAt = segments.indexOf("专辑");
  const album = albumAt >= 0 ? cleanAlbumName(segments[albumAt + 1] || "") : "";
  const title = cleanTrackName(filename);

  if (looksLossy(result.title) && title) result.title = title;
  if (looksLossy(result.album) && album) result.album = album;
  if (looksLossy(result.artist)) {
    result.artist = "Unknown Artist";
    result.albumArtist = "Unknown Artist";
  }
  return result;
}

function storagePath(uri: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(.+)$/i.exec(uri);
  return match?.[1] || null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function cleanAlbumName(value: string): string {
  return value
    .replace(/\s*[（(［\[]\s*(?:wav|flac|mp3|m4a|aac|ape|ogg|opus)\s*[）)］\]]$/i, "")
    .trim();
}

function cleanTrackName(filename: string): string {
  return filename
    .replace(/\.[^./]+$/, "")
    .replace(/^\s*\d{1,3}(?:\s*[._、-]\s*|\s+)/, "")
    .trim();
}

function looksLossy(value: string | undefined): boolean {
  return !!value && (value.includes("\uFFFD") || /[?？]{2,}/.test(value) || (value.includes("?") && /[^\x00-\x7f]/.test(value)));
}
