// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  chooseSurvivorMaster as chooseSurvivor,
  masterMergeStatements,
  rewritePlayQueues,
  type MergeableMaster,
} from "./catalogMerge";

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

type MasterRow = MergeableMaster;

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
      const duplicateMaster = component.masters.find((master) => master.id === duplicateMasterId)!;
      statements.push(...masterMergeStatements(db, survivor.id, duplicateMaster, now));
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
          db.prepare(
            `UPDATE work_queue
             SET status = 'canceled',
                 claimed_by = NULL,
                 claimed_at = NULL,
                 heartbeat_at = NULL,
                 error_message = 'canceled: duplicate instance merged'
             WHERE task_type = 'metadata'
               AND status IN ('queued', 'claimed')
               AND json_extract(payload, '$.instanceId') = ?`,
          ).bind(duplicate.id),
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
