import type { SongTags } from "./tags";
import type { TagWriteCover } from "./tagwrite";

export type Mp4Part = Uint8Array | { offset: number; length: number };
export interface Mp4Rewrite { parts: Mp4Part[]; size: number }
type Box = { type: string; start: number; end: number; header: number };
const MAX_MOOV = 16 * 1024 * 1024;
const encoder = new TextEncoder();

function u32(b: Uint8Array, p: number): number { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(p); }
function u64(b: Uint8Array, p: number): number {
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(p);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid size");
  return Number(n);
}
function name(b: Uint8Array, p: number): string { return String.fromCharCode(...b.subarray(p, p + 4)); }
function boxAt(b: Uint8Array, p: number, end: number): Box {
  if (p + 8 > end) throw new Error("truncated box");
  const n = u32(b, p), type = name(b, p + 4);
  const header = n === 1 ? 16 : 8;
  if (p + header > end) throw new Error("truncated box");
  const size = n === 1 ? u64(b, p + 8) : n === 0 ? end - p : n;
  if (size < header || p + size > end) throw new Error("invalid box size");
  return { type, start: p, end: p + size, header };
}
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  while (start < end) { const box = boxAt(b, start, end); out.push(box); start = box.end; }
  return out;
}
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let p = 0; for (const part of parts) { out.set(part, p); p += part.length; } return out;
}
function makeBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = join(parts), out = new Uint8Array(body.length + 8);
  if (out.length > 0xffffffff) throw new Error("box too large");
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8); return out;
}
function raw(b: Uint8Array, box: Box): Uint8Array { return b.slice(box.start, box.end); }
function one(list: Box[], type: string): Box | undefined {
  const matches = list.filter(x => x.type === type);
  if (matches.length > 1) throw new Error("duplicate box");
  return matches[0];
}
function dataBox(type: number, value: Uint8Array): Uint8Array {
  const head = new Uint8Array(8); new DataView(head.buffer).setUint32(0, type);
  return makeBox("data", head, value);
}

function editIlst(old: Uint8Array | undefined, tags: SongTags, cover?: TagWriteCover): Uint8Array {
  const fields: Array<[string, string | number | undefined]> = [
    ["\xa9nam", tags.title], ["\xa9ART", tags.artist], ["aART", tags.albumArtist],
    ["\xa9alb", tags.album], ["\xa9gen", tags.genre], ["\xa9day", tags.year],
    ["\xa9lyr", tags.lyrics], ["trkn", tags.track], ["disk", tags.disc],
  ];
  const previous = old ? boxes(old, boxAt(old, 0, old.length).header, old.length) : [];
  const updates = new Map(fields.filter(([, v]) => v !== undefined));
  if (cover) updates.set("covr", "cover");
  const output: Uint8Array[] = [];
  for (const entry of previous) if (!updates.has(entry.type)) output.push(raw(old!, entry));
  for (const [type, value] of updates) {
    if (value === "{null}" || value === "" || value === undefined) continue;
    if (type === "trkn" || type === "disk") {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("invalid track number");
      const number = new Uint8Array(8);
      const entry = previous.find(x => x.type === type);
      if (entry) {
        const children = boxes(old!, entry.start + entry.header, entry.end);
        const data = one(children, "data");
        if (!data || data.end - data.start < data.header + 16) throw new Error("invalid track metadata");
        number.set(old!.subarray(data.start + data.header + 8, data.start + data.header + 16));
      }
      new DataView(number.buffer).setUint16(2, Number(value));
      output.push(makeBox(type, dataBox(0, number)));
    } else if (type === "covr") {
      if (!cover || (cover.mime !== "image/jpeg" && cover.mime !== "image/png")) throw new Error("invalid cover");
      output.push(makeBox(type, dataBox(cover.mime === "image/png" ? 14 : 13, cover.data)));
    } else output.push(makeBox(type, dataBox(1, encoder.encode(String(value)))));
  }
  return makeBox("ilst", ...output);
}

function rewriteMetadata(moov: Uint8Array, tags: SongTags, cover?: TagWriteCover): Uint8Array {
  const root = boxAt(moov, 0, moov.length), children = boxes(moov, root.header, root.end);
  if (children.some(x => x.type === "meta")) throw new Error("unsupported metadata layout");
  const udta = one(children, "udta");
  const udtaChildren = udta ? boxes(moov, udta.start + udta.header, udta.end) : [];
  const meta = one(udtaChildren, "meta");
  if (meta && meta.start + meta.header + 4 > meta.end) throw new Error("invalid meta");
  const metaChildren = meta ? boxes(moov, meta.start + meta.header + 4, meta.end) : [];
  const oldHandler = one(metaChildren, "hdlr");
  if (oldHandler && (oldHandler.start + oldHandler.header + 12 > oldHandler.end || name(moov, oldHandler.start + oldHandler.header + 8) !== "mdir")) throw new Error("unsupported metadata handler");
  const ilst = one(metaChildren, "ilst");
  const newIlst = editIlst(ilst ? raw(moov, ilst) : undefined, tags, cover);
  const handler = makeBox("hdlr", new Uint8Array(8), new Uint8Array([109,100,105,114]), new Uint8Array(12), new Uint8Array(1));
  const newMeta = makeBox("meta", meta ? moov.slice(meta.start + meta.header, meta.start + meta.header + 4) : new Uint8Array(4),
    ...metaChildren.filter(x => x !== ilst).map(x => raw(moov, x)), ...(metaChildren.some(x => x.type === "hdlr") ? [] : [handler]), newIlst);
  const newUdta = makeBox("udta", ...udtaChildren.filter(x => x !== meta).map(x => raw(moov, x)), newMeta);
  return makeBox("moov", ...children.filter(x => x !== udta).map(x => raw(moov, x)), newUdta);
}

function adjustOffsets(moov: Uint8Array, oldStart: number, oldEnd: number, delta: number, media: Array<{start: number; end: number}>): void {
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);
  const forbidden = new Set(["mvex", "cmov", "saio", "iloc"]);
  const visit = (box: Box) => {
    if (forbidden.has(box.type)) throw new Error("unsupported layout");
    if (box.type === "stco" || box.type === "co64") {
      const width = box.type === "stco" ? 4 : 8, begin = box.start + box.header;
      if (begin + 8 > box.end) throw new Error("truncated offsets");
      const count = u32(moov, begin + 4);
      if (begin + 8 + count * width !== box.end) throw new Error("invalid offsets");
      const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
      for (let i = 0; i < count; i++) {
        const at = begin + 8 + i * width, offset = width === 4 ? u32(moov, at) : u64(moov, at);
        if (!media.some(x => offset >= x.start && offset < x.end)) throw new Error("external media offset");
        const updated = offset >= oldEnd ? offset + delta : offset;
        if (offset >= oldStart && offset < oldEnd || updated < 0 || !Number.isSafeInteger(updated) || width === 4 && updated > 0xffffffff) throw new Error("invalid media offset");
        if (width === 4) view.setUint32(at, updated); else view.setBigUint64(at, BigInt(updated));
      }
    } else if (containers.has(box.type)) {
      for (const child of boxes(moov, box.start + box.header, box.end)) visit(child);
    }
  };
  visit(boxAt(moov, 0, moov.length));
}

export async function planMp4Rewrite(size: number, read: (offset: number, length: number) => Promise<Uint8Array>, tags: SongTags, cover?: TagWriteCover): Promise<Mp4Rewrite | null> {
  try {
    if (!Number.isSafeInteger(size) || size < 8) return null;
    const top: Array<{type: string; start: number; end: number; header: number}> = [];
    for (let pos = 0; pos < size;) {
      const h = await read(pos, Math.min(16, size - pos));
      if (h.length < 8) return null;
      const n = u32(h, 0), header = n === 1 ? 16 : 8;
      if (h.length < header) return null;
      const length = n === 1 ? u64(h, 8) : n === 0 ? size - pos : n;
      if (length < header || pos + length > size) return null;
      top.push({ type: name(h, 4), start: pos, end: pos + length, header });
      pos += length;
    }
    if (!one(top, "ftyp") || top.some(x => ["moof", "mfra", "sidx", "meta"].includes(x.type))) return null;
    const moov = one(top, "moov"), media = top.filter(x => x.type === "mdat").map(x => ({ start: x.start + x.header, end: x.end }));
    if (!moov || !media.length || moov.end - moov.start > MAX_MOOV) return null;
    const old = await read(moov.start, moov.end - moov.start);
    if (old.length !== moov.end - moov.start) return null;
    const replacement = rewriteMetadata(old, tags, cover), delta = replacement.length - old.length;
    adjustOffsets(replacement, moov.start, moov.end, delta, media);
    const parts: Mp4Part[] = [];
    if (moov.start) parts.push({ offset: 0, length: moov.start });
    parts.push(replacement);
    if (moov.end < size) parts.push({ offset: moov.end, length: size - moov.end });
    return { parts, size: size + delta };
  } catch { return null; }
}
