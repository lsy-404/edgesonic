WITH expected(group_id, id, name, year, song_count, cover_r2_key) AS (
  VALUES
    ('ag-lost-in-tianyi', 'al-6e9d098041', 'Lost in Tianyi', NULL, 9, 'covers/al-6e9d098041'),
    ('ag-lost-in-tianyi', 'al-da4b6cd40d', 'Lost In Tianyi', 2018, 9, NULL),
    ('ag-huazai-youxia-2', 'al-2dd78c6e22', '华哉有夏·贰', 2021, 8, NULL),
    ('ag-huazai-youxia-2', 'al-00997a7da1', '华哉有夏·贰', NULL, 8, NULL),
    ('ag-luo-2023', 'al-2ea8eb469a', '洛 LUO', NULL, 5, 'covers/al-2ea8eb469a'),
    ('ag-luo-2023', 'al-9180eaf495', '洛 LUO', 2023, 5, NULL),
    ('ag-nothing-happened', 'al-8a0bee80b4', '无事发生', NULL, 22, 'covers/al-8a0bee80b4'),
    ('ag-nothing-happened', 'al-4c6df4d0bc', '无事发生', 2021, 11, 'covers/al-4c6df4d0bc')
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
