SELECT
  sm.id AS master_id,
  sm.album_id,
  sm.title,
  sm.track,
  sm.disc,
  sm.duration,
  si.id AS instance_id,
  si.suffix,
  si.size,
  si.storage_uri,
  so.id AS object_id,
  so.physical_key,
  se.id AS entry_id,
  se.path
FROM song_masters sm
JOIN song_instances si ON si.master_id = sm.id
JOIN storage_objects so ON so.id = si.storage_object_id
JOIN storage_entries se ON se.instance_id = si.id
WHERE sm.album_id = 'pending-uploads'
  AND si.missing = 0
  AND (
    instr(se.path, '异色合鸣Chromatic Harmony（wav）/A盘/') = 1
    OR instr(se.path, '异色合鸣Chromatic Harmony（wav）/B盘/') = 1
    OR instr(se.path, '夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE A/') = 1
    OR instr(se.path, '夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE B/') = 1
  )
ORDER BY se.path;

SELECT id, name, sort_name, year, song_count, duration, size, cover_r2_key
FROM albums
WHERE instr(name, '异色合鸣') > 0
   OR instr(name, 'Chromatic Harmony') > 0
   OR instr(name, '夏日应时而至') > 0
ORDER BY name, id;

SELECT sm.id, a.id AS album_id, a.name AS album_name, sm.title, sm.track, sm.disc, sm.duration,
       si.id AS instance_id, si.suffix, si.size, se.path
FROM song_masters sm
JOIN albums a ON a.id = sm.album_id
JOIN song_instances si ON si.master_id = sm.id AND si.missing = 0
JOIN storage_entries se ON se.instance_id = si.id
WHERE sm.album_id <> 'pending-uploads'
  AND (instr(se.path, '异色合鸣') > 0 OR instr(se.path, 'Chromatic Harmony') > 0 OR instr(se.path, '夏日应时而至') > 0)
ORDER BY a.name, sm.disc, sm.track, se.path;
