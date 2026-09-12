const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64 = 0xffffffffffffffffn;

export function normalizeSuffix(value: string): string {
  const suffix = value.trim().replace(/^\.+/, '').toLowerCase();
  if (!suffix || suffix.includes('/') || suffix.includes('\\') || suffix.includes('.')) {
    throw new Error('Invalid storage object suffix');
  }
  return suffix;
}

export function createStableObjectId(seed: string): string {
  const normalizedSeed = seed.normalize('NFC');
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(normalizedSeed)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64;
  }
  return `obj_${hash.toString(16).padStart(16, '0')}`;
}

export function createStableObjectKey(objectId: string, suffix: string): string {
  const normalizedId = objectId.trim();
  if (!/^obj_[0-9a-f]{16}$/.test(normalizedId)) {
    throw new Error('Invalid stable storage object id');
  }
  return `objects/${normalizedId}.${normalizeSuffix(suffix)}`;
}

export function normalizeEntryPath(path: string): string {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (normalized.length === 0) throw new Error('Entry path escapes its root');
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join('/');
}

export function splitEntryPath(path: string): { parentPath: string; displayName: string } {
  const normalizedPath = normalizeEntryPath(path);
  if (!normalizedPath) throw new Error('Entry path must not be empty');
  const separator = normalizedPath.lastIndexOf('/');
  if (separator < 0) return { parentPath: '', displayName: normalizedPath };
  return {
    parentPath: normalizedPath.slice(0, separator),
    displayName: normalizedPath.slice(separator + 1),
  };
}
