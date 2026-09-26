// SPDX-License-Identifier: AGPL-3.0-or-later

export interface EmbeddedCover {
  data: string;
  mime?: string;
}

export interface EmbeddedCoverLeaseGuard {
  markerId: string;
  payload: string;
}

export type EmbeddedCoverWriteStatus = "saved" | "preserved" | "invalid";

export async function writeEmbeddedCover(
  db: D1Database,
  bucket: R2Bucket,
  masterId: string,
  cover: EmbeddedCover,
  leaseGuard?: EmbeddedCoverLeaseGuard,
): Promise<EmbeddedCoverWriteStatus> {
  if (!cover.data || cover.data.length > 266_668) return "invalid";

  let bin: string;
  try { bin = atob(cover.data); } catch { return "invalid"; }
  if (bin.length === 0 || bin.length > 200_000) return "invalid";

  const mime = typeof cover.mime === "string" && /^image\/[a-z0-9.+-]+$/i.test(cover.mime)
    ? cover.mime
    : "image/jpeg";
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const master = await db.prepare(
    "SELECT a.id AS album_id, a.cover_r2_key FROM song_masters sm JOIN albums a ON a.id = sm.album_id WHERE sm.id = ?",
  ).bind(masterId).first<{ album_id: string; cover_r2_key: string | null }>();
  if (!master?.album_id) return "invalid";
  if (master.cover_r2_key) return "preserved";

  const coverKey = `covers/${master.album_id}/${crypto.randomUUID()}`;
  await bucket.put(coverKey, bytes, { httpMetadata: { contentType: mime } });
  try {
    const updateSql = leaseGuard
      ? "UPDATE albums SET cover_r2_key = ?, updated_at = ? WHERE id = ? AND cover_r2_key IS NULL AND EXISTS (SELECT 1 FROM work_queue WHERE id = ? AND status = 'claimed' AND payload = ?)"
      : "UPDATE albums SET cover_r2_key = ?, updated_at = ? WHERE id = ? AND cover_r2_key IS NULL";
    const updateBinds = leaseGuard
      ? [coverKey, Math.floor(Date.now() / 1000), master.album_id, leaseGuard.markerId, leaseGuard.payload]
      : [coverKey, Math.floor(Date.now() / 1000), master.album_id];
    const updated = await db.prepare(updateSql).bind(...updateBinds).run();
    if (updated.meta?.changes === 1) return "saved";
  } catch (error) {
    const current = await db.prepare("SELECT cover_r2_key FROM albums WHERE id = ?")
      .bind(master.album_id).first<{ cover_r2_key: string | null }>();
    if (current?.cover_r2_key === coverKey) return "saved";
    try { await bucket.delete(coverKey); } catch { /* cleanup best effort */ }
    throw error;
  }

  const current = await db.prepare("SELECT cover_r2_key FROM albums WHERE id = ?")
    .bind(master.album_id).first<{ cover_r2_key: string | null }>();
  if (current?.cover_r2_key === coverKey) return "saved";
  await bucket.delete(coverKey);
  return current?.cover_r2_key ? "preserved" : "invalid";
}
