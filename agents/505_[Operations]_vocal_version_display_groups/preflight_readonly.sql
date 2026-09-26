WITH expected(group_id, id, name, year, song_count, cover_r2_key) AS (
  VALUES
    ('ag-yilai-vocal-instrumental', 'al-a6759776f5', '依睐', 2020, 9, 'covers/al-a6759776f5'),
    ('ag-yilai-vocal-instrumental', 'al-1e31c9f076', '依睐', 2020, 9, 'covers/al-1e31c9f076'),
    ('ag-dream-forest-2016', 'al-0bf1d619c1', '夢境之森', 2016, 8, NULL),
    ('ag-dream-forest-2016', 'al-58fb8df24d', '夢境之森', 2016, 8, NULL)
)
SELECT e.group_id, e.id,
  CASE WHEN a.id IS NOT NULL AND a.name IS e.name AND a.year IS e.year
    AND a.song_count = e.song_count AND a.cover_r2_key IS e.cover_r2_key
    AND (SELECT COUNT(*) FROM song_masters m WHERE m.album_id = e.id) = e.song_count
    AND (SELECT COUNT(*) FROM song_masters m JOIN song_instances si ON si.master_id = m.id
         WHERE m.album_id = e.id AND si.missing = 0) = e.song_count
    AND NOT EXISTS (SELECT 1 FROM album_display_group_members gm WHERE gm.album_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM album_display_groups g WHERE g.id = e.group_id)
  THEN 1 ELSE 0 END AS ready
FROM expected e LEFT JOIN albums a ON a.id = e.id
ORDER BY e.group_id, e.id;
