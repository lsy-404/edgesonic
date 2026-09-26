INSERT INTO album_display_groups(id, display_name, sort_name)
VALUES ('ag-yilai-vocal-instrumental', '依睐', '依睐');
WITH expected(id, name, year, song_count, cover_r2_key, sort_order) AS (
  VALUES
    ('al-a6759776f5', '依睐', 2020, 9, 'covers/al-a6759776f5', 0),
    ('al-1e31c9f076', '依睐', 2020, 9, 'covers/al-1e31c9f076', 1)
)
INSERT INTO album_display_group_members(group_id, album_id, sort_order)
SELECT 'ag-yilai-vocal-instrumental', a.id, e.sort_order
FROM expected e JOIN albums a ON a.id = e.id
WHERE a.name = e.name AND a.year IS e.year AND a.song_count = e.song_count
  AND a.cover_r2_key IS e.cover_r2_key
  AND (SELECT COUNT(*) FROM song_masters m WHERE m.album_id = a.id) = e.song_count
  AND (SELECT COUNT(*) FROM song_masters m JOIN song_instances si ON si.master_id = m.id WHERE m.album_id = a.id AND si.missing = 0) = e.song_count;
INSERT INTO album_display_groups(id, display_name)
SELECT 'ag-yilai-vocal-instrumental', 'guard' WHERE changes() != 2;

INSERT INTO album_display_groups(id, display_name, sort_name)
VALUES ('ag-dream-forest-2016', '夢境之森', '夢境之森');
WITH expected(id, name, year, song_count, cover_r2_key, sort_order) AS (
  VALUES
    ('al-0bf1d619c1', '夢境之森', 2016, 8, NULL, 0),
    ('al-58fb8df24d', '夢境之森', 2016, 8, NULL, 1)
)
INSERT INTO album_display_group_members(group_id, album_id, sort_order)
SELECT 'ag-dream-forest-2016', a.id, e.sort_order
FROM expected e JOIN albums a ON a.id = e.id
WHERE a.name = e.name AND a.year IS e.year AND a.song_count = e.song_count
  AND a.cover_r2_key IS e.cover_r2_key
  AND (SELECT COUNT(*) FROM song_masters m WHERE m.album_id = a.id) = e.song_count
  AND (SELECT COUNT(*) FROM song_masters m JOIN song_instances si ON si.master_id = m.id WHERE m.album_id = a.id AND si.missing = 0) = e.song_count;
INSERT INTO album_display_groups(id, display_name)
SELECT 'ag-dream-forest-2016', 'guard' WHERE changes() != 2;
