// SPDX-License-Identifier: AGPL-3.0-or-later

export interface HistoricalSongDedupeGroup {
  storageUris: string[];
  survivorMasterId: string;
  duplicateMasterIds: string[];
  duplicateInstanceIds: string[];
}

export interface HistoricalSongDedupePreview {
  groups: HistoricalSongDedupeGroup[];
  duplicateMasters: number;
  duplicateInstances: number;
}

interface MasterRow {
  id: string;
  title: string | null;
  artist_id: string | null;
  album_id: string | null;
  album_artist_id: string | null;
  cover_r2_key: string | null;
  sort_title: string | null;
  track: number | null;
  disc: number | null;
  duration: number | null;
  genre: string | null;
  participants: string | null;
  lyrics: string | null;
  lyrics_rich: string | null;
  created_at: number | null;
}

interface InstanceRow {
  id: string;
  master_id: string;
  storage_uri: string;
  source_type: string | null;
  created_at: number | null;
}

interface DedupeComponent {
  masters: MasterRow[];
  storageUris: string[];
  instances: InstanceRow[];
}

function present(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

function metadataScore(master: MasterRow): number {
  let score = 0;
  if (present(master.title)) score++;
  if (present(master.artist_id) && master.artist_id !== "unknown-artist") score++;
  if (present(master.album_id) && master.album_id !== "pending-uploads") score++;
  if (present(master.album_artist_id)) score++;
  if (present(master.cover_r2_key)) score++;
  if (present(master.sort_title)) score++;
  if (master.track !== null) score++;
  if (master.disc !== null) score++;
  if (master.duration !== null && master.duration > 0) score++;
  if (present(master.genre)) score++;
  if (present(master.participants)) score++;
  if (present(master.lyrics)) score += 2;
  if (present(master.lyrics_rich)) score += 2;
  return score;
}

function chooseSurvivor(masters: MasterRow[]): MasterRow {
  return [...masters].sort((a, b) => {
    const scoreDiff = metadataScore(b) - metadataScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    const createdDiff = (a.created_at ?? Number.MAX_SAFE_INTEGER) - (b.created_at ?? Number.MAX_SAFE_INTEGER);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  })[0];
}

function chooseInstance(instances: InstanceRow[], survivorMasterId: string): InstanceRow {
  return [...instances].sort((a, b) => {
    const survivorDiff = Number(b.master_id === survivorMasterId) - Number(a.master_id === survivorMasterId);
    if (survivorDiff !== 0) return survivorDiff;
    const originalDiff = Number(b.source_type === "original") - Number(a.source_type === "original");
    if (originalDiff !== 0) return originalDiff;
    const createdDiff = (a.created_at ?? Number.MAX_SAFE_INTEGER) - (b.created_at ?? Number.MAX_SAFE_INTEGER);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  })[0];
}

async function loadComponents(db: D1Database): Promise<DedupeComponent[]> {
  const rows = (await db.prepare(
    `SELECT sm.id, sm.title, sm.artist_id, sm.album_id, sm.album_artist_id,
            sm.cover_r2_key, sm.sort_title, sm.track, sm.disc, sm.duration,
            sm.genre, sm.participants, sm.lyrics, sm.lyrics_rich, sm.created_at,
            si.id AS instance_id, si.master_id, si.storage_uri, si.source_type,
            si.created_at AS instance_created_at
     FROM song_instances si
     JOIN song_masters sm ON sm.id = si.master_id
     WHERE si.storage_uri IS NOT NULL AND si.storage_uri != ''
       AND si.storage_uri IN (
         SELECT storage_uri
         FROM song_instances
         WHERE storage_uri IS NOT NULL AND storage_uri != ''
         GROUP BY storage_uri
         HAVING COUNT(DISTINCT master_id) > 1
       )
     ORDER BY si.storage_uri, sm.id, si.id`,
  ).all<MasterRow & { instance_id: string; master_id: string; storage_uri: string; source_type: string | null; instance_created_at: number | null }>()).results;

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const root = parent.get(id) ?? id;
    if (root === id) return id;
    const resolved = find(root);
    parent.set(id, resolved);
    return resolved;
  };
  const join = (a: string, b: string) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };
  const byUri = new Map<string, typeof rows>();
  for (const row of rows) {
    parent.set(row.id, row.id);
    const uriRows = byUri.get(row.storage_uri) ?? [];
    uriRows.push(row);
    byUri.set(row.storage_uri, uriRows);
  }
  for (const uriRows of byUri.values()) {
    for (let i = 1; i < uriRows.length; i++) join(uriRows[0].id, uriRows[i].id);
  }

  const byComponent = new Map<string, typeof rows>();
  for (const row of rows) {
    const members = byComponent.get(find(row.id)) ?? [];
    members.push(row);
    byComponent.set(find(row.id), members);
  }

  return [...byComponent.values()].map((componentRows) => {
    const masters = new Map<string, MasterRow>();
    const instances: InstanceRow[] = [];
    for (const row of componentRows) {
      if (!masters.has(row.id)) {
        const { instance_id: _instanceId, master_id: _masterId, storage_uri: _storageUri, source_type: _sourceType, instance_created_at: _instanceCreatedAt, ...master } = row;
        masters.set(master.id, master);
      }
      instances.push({
        id: row.instance_id,
        master_id: row.master_id,
        storage_uri: row.storage_uri,
        source_type: row.source_type,
        created_at: row.instance_created_at,
      });
    }
    return {
      masters: [...masters.values()],
      storageUris: [...new Set(componentRows.map((row) => row.storage_uri))].sort(),
      instances,
    };
  });
}

export async function previewHistoricalSongDedupe(db: D1Database): Promise<HistoricalSongDedupePreview> {
  const components = await loadComponents(db);
  const groups = components.map((component) => {
    const survivor = chooseSurvivor(component.masters);
    const duplicateInstanceIds: string[] = [];
    for (const uri of component.storageUris) {
      const uriInstances = component.instances.filter((instance) => instance.storage_uri === uri);
      const canonical = chooseInstance(uriInstances, survivor.id);
      duplicateInstanceIds.push(...uriInstances.filter((instance) => instance.id !== canonical.id).map((instance) => instance.id));
    }
    return {
      storageUris: component.storageUris,
      survivorMasterId: survivor.id,
      duplicateMasterIds: component.masters.filter((master) => master.id !== survivor.id).map((master) => master.id).sort(),
      duplicateInstanceIds: duplicateInstanceIds.sort(),
    };
  }).sort((a, b) => a.survivorMasterId.localeCompare(b.survivorMasterId));
  return {
    groups,
    duplicateMasters: groups.reduce((total, group) => total + group.duplicateMasterIds.length, 0),
    duplicateInstances: groups.reduce((total, group) => total + group.duplicateInstanceIds.length, 0),
  };
}

interface QueueRow { user_id: string; song_ids: string; current_id: string | null }

async function rewritePlayQueues(db: D1Database, duplicateMasterIds: string[], survivorMasterId: string, now: number) {
  const queues = (await db.prepare("SELECT user_id, song_ids, current_id FROM play_queues").all<QueueRow>()).results;
  const duplicates = new Set(duplicateMasterIds);
  const writes: D1PreparedStatement[] = [];
  for (const queue of queues) {
    let ids: unknown;
    try { ids = JSON.parse(queue.song_ids); } catch { continue; }
    if (!Array.isArray(ids) || !ids.some((id) => typeof id === "string" && duplicates.has(id))) continue;
    const nextIds = ids.map((id) => typeof id === "string" && duplicates.has(id) ? survivorMasterId : id);
    const nextCurrent = queue.current_id && duplicates.has(queue.current_id) ? survivorMasterId : queue.current_id;
    writes.push(db.prepare(
      "UPDATE play_queues SET song_ids = ?, current_id = ?, updated_at = ? WHERE user_id = ?",
    ).bind(JSON.stringify(nextIds), nextCurrent, now, queue.user_id));
  }
  if (writes.length > 0) await db.batch(writes);
}

export async function applyHistoricalSongDedupe(db: D1Database): Promise<HistoricalSongDedupePreview> {
  const preview = await previewHistoricalSongDedupe(db);
  const components = await loadComponents(db);
  const now = Math.floor(Date.now() / 1000);
  for (const component of components) {
    const survivor = chooseSurvivor(component.masters);
    const duplicateMasterIds = component.masters.filter((master) => master.id !== survivor.id).map((master) => master.id);
    if (duplicateMasterIds.length === 0) continue;
    await rewritePlayQueues(db, duplicateMasterIds, survivor.id, now);

    const statements: D1PreparedStatement[] = [];
    for (const duplicateMasterId of duplicateMasterIds) {
      statements.push(
        db.prepare("INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT ?, artist_id, position FROM song_artists WHERE song_id = ?").bind(survivor.id, duplicateMasterId),
        db.prepare("DELETE FROM song_artists WHERE song_id = ?").bind(duplicateMasterId),
        db.prepare(
          `INSERT INTO annotations (user_id, item_id, item_type, play_count, play_date, rating, starred, starred_at)
           SELECT user_id, ?, item_type, play_count, play_date, rating, starred, starred_at
           FROM annotations WHERE item_id = ? AND item_type = 'song'
           ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
             play_count = annotations.play_count + excluded.play_count,
             play_date = MAX(annotations.play_date, excluded.play_date),
             rating = COALESCE(annotations.rating, excluded.rating),
             starred = MAX(annotations.starred, excluded.starred),
             starred_at = CASE
               WHEN annotations.starred_at IS NULL THEN excluded.starred_at
               WHEN excluded.starred_at IS NULL THEN annotations.starred_at
               ELSE MIN(annotations.starred_at, excluded.starred_at)
             END`,
        ).bind(survivor.id, duplicateMasterId),
        db.prepare("DELETE FROM annotations WHERE item_id = ? AND item_type = 'song'").bind(duplicateMasterId),
        db.prepare(
          `INSERT INTO bookmarks (user_id, song_master_id, position_ms, comment, created_at, updated_at)
           SELECT user_id, ?, position_ms, comment, created_at, updated_at FROM bookmarks WHERE song_master_id = ?
           ON CONFLICT(user_id, song_master_id) DO UPDATE SET
             position_ms = CASE WHEN excluded.updated_at > bookmarks.updated_at THEN excluded.position_ms ELSE bookmarks.position_ms END,
             comment = CASE WHEN excluded.updated_at > bookmarks.updated_at THEN excluded.comment ELSE bookmarks.comment END,
             created_at = MIN(bookmarks.created_at, excluded.created_at),
             updated_at = MAX(bookmarks.updated_at, excluded.updated_at)`,
        ).bind(survivor.id, duplicateMasterId),
        db.prepare("DELETE FROM bookmarks WHERE song_master_id = ?").bind(duplicateMasterId),
        db.prepare("UPDATE playlist_songs SET song_master_id = ? WHERE song_master_id = ?").bind(survivor.id, duplicateMasterId),
        db.prepare("UPDATE share_entries SET song_master_id = ? WHERE song_master_id = ?").bind(survivor.id, duplicateMasterId),
        db.prepare("UPDATE scrape_jobs SET song_master_id = ? WHERE song_master_id = ?").bind(survivor.id, duplicateMasterId),
        db.prepare("UPDATE clone_id_map SET local_id = ?, updated_at = ? WHERE item_type = 'song' AND local_id = ?").bind(survivor.id, now, duplicateMasterId),
        db.prepare("UPDATE song_instances SET master_id = ?, updated_at = ? WHERE master_id = ?").bind(survivor.id, now, duplicateMasterId),
      );
    }

    for (const uri of component.storageUris) {
      const uriInstances = component.instances.filter((instance) => instance.storage_uri === uri);
      const canonical = chooseInstance(uriInstances, survivor.id);
      for (const duplicate of uriInstances) {
        if (duplicate.id === canonical.id) continue;
        statements.push(
          db.prepare("UPDATE song_instances SET parent_instance_id = NULL WHERE id = ? AND parent_instance_id = ?").bind(canonical.id, duplicate.id),
          db.prepare("UPDATE song_instances SET parent_instance_id = ? WHERE parent_instance_id = ? AND id != ?").bind(canonical.id, duplicate.id, canonical.id),
          db.prepare("UPDATE transcode_jobs SET instance_id = ? WHERE instance_id = ?").bind(canonical.id, duplicate.id),
          db.prepare("UPDATE transcode_jobs SET output_instance_id = ? WHERE output_instance_id = ?").bind(canonical.id, duplicate.id),
          db.prepare("DELETE FROM song_instances WHERE id = ?").bind(duplicate.id),
        );
      }
    }
    for (const duplicateMasterId of duplicateMasterIds) {
      statements.push(db.prepare("DELETE FROM song_masters WHERE id = ?").bind(duplicateMasterId));
    }
    await db.batch(statements);
  }
  return preview;
}
