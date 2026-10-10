// SPDX-License-Identifier: AGPL-3.0-or-later

const UNKNOWN_VALUES = new Set([
  "unknown",
  "unknown artist",
  "unknownartist",
  "unknown album",
  "unknownalbum",
  "pending uploads",
  "pendinguploads",
]);

export function normalizeMetadataIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, " ")
    .trim();
}

export function isKnownMetadataIdentity(value: unknown): boolean {
  if (typeof value === "string" && /^obj_[0-9a-f]{16,64}(?:\.[^.]+)?$/i.test(value.trim())) return false;
  const normalized = normalizeMetadataIdentity(value);
  return normalized.length > 0 && !UNKNOWN_VALUES.has(normalized);
}

export function isCredibleMetadataMatch(
  candidate: { title?: unknown; artist?: unknown; album?: unknown },
  snapshot: { title?: unknown; artist?: unknown; album?: unknown },
): boolean {
  const candidateTitle = normalizeMetadataIdentity(candidate.title);
  const snapshotTitle = normalizeMetadataIdentity(snapshot.title);
  if (!candidateTitle || !snapshotTitle || candidateTitle !== snapshotTitle) return false;

  const artistKnown = isKnownMetadataIdentity(snapshot.artist);
  const albumKnown = isKnownMetadataIdentity(snapshot.album);
  if (!artistKnown && !albumKnown) return false;
  if (artistKnown && (!isKnownMetadataIdentity(candidate.artist) ||
      normalizeMetadataIdentity(candidate.artist) !== normalizeMetadataIdentity(snapshot.artist))) return false;
  if (albumKnown && (!isKnownMetadataIdentity(candidate.album) ||
      normalizeMetadataIdentity(candidate.album) !== normalizeMetadataIdentity(snapshot.album))) return false;
  return true;
}

export function isSelectableMetadataMatch(
  candidate: { title?: unknown; artist?: unknown; album?: unknown },
  payload: {
    identity?: { title?: unknown; artist?: unknown; album?: unknown };
    snapshot?: { title?: unknown; artist?: unknown; album?: unknown };
  },
): boolean {
  for (const field of ["title", "artist", "album"] as const) {
    for (const expected of [payload.identity?.[field], payload.snapshot?.[field]]) {
      if (!isKnownMetadataIdentity(expected)) continue;
      const actual = candidate[field];
      if (!isKnownMetadataIdentity(actual) ||
          normalizeMetadataIdentity(expected) !== normalizeMetadataIdentity(actual)) return false;
    }
  }
  return isKnownMetadataIdentity(candidate.title);
}
