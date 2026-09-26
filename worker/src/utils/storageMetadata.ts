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
  const album = albumAt >= 0
    ? cleanAlbumName(segments[albumAt + 1] || "")
    : rootAlbumName(segments);
  const title = cleanTrackName(filename);

  if (looksLossy(result.title) && title) result.title = title;
  if (looksLossy(result.album) && album) result.album = album;
  if (looksLossy(result.artist)) {
    result.artist = "Unknown Artist";
    result.albumArtist = "Unknown Artist";
  }
  return result;
}

export function albumNameFromSourcePath(path: string): string | null {
  const folders = path.replaceAll("\\", "/").split("/").filter(Boolean).slice(0, -1);
  if (folders.length === 0 || folders.some((part) => part === "__MACOSX")) return null;

  while (folders.length > 1 && isQualityFolder(folders.at(-1)!)) {
    folders.pop();
  }
  const name = folders.at(-1)!;
  if (/^(?:music|专辑|downloads|objects)$/i.test(name) || isQualityFolder(name)) return null;
  const variant = /^(?:cd\s*\d+.*|disc\s*\d+.*|cd_mastered_cn|[ab]盘|side\s*[ab]|伴奏|人声版|言和版|bonus tracks?|特典)$/i.test(name);
  const label = variant && folders.length > 1 ? `${folders.at(-2)} (${name})` : name;
  return cleanAlbumName(label) || null;
}

function isQualityFolder(name: string): boolean {
  return /^(?:wav|flac|mp3|m4a|aac|ogg|opus|ape|音频|歌词|lyrics|歌曲|歌曲本体|cd级无损wav|母带(?:版|级)无损(?:音乐|wav|flac|伴奏)|音频(?:wav|flac|mp3)|(?:【[^】]+】)?cd音频|(?:wav|mp3)[（(](?:无损|有损)[）)])$/i.test(name);
}

export async function sourceFolderAlbumName(db: D1Database, instanceId: string): Promise<string | null> {
  const entries = (await db.prepare(
    "SELECT path FROM storage_entries WHERE instance_id = ? AND kind = 'file' LIMIT 2",
  ).bind(instanceId).all<{ path: string }>()).results;
  return entries.length === 1 ? albumNameFromSourcePath(entries[0].path) : null;
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

function rootAlbumName(segments: string[]): string {
  const root = segments[0] || "";
  if (!root || ["music", "covers", "cache", "transcoded"].includes(root.toLowerCase())) return "";
  return cleanAlbumName(root);
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
