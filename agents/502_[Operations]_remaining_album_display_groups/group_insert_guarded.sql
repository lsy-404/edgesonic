INSERT INTO album_display_groups(id, display_name, sort_name)
VALUES ('ag-lost-in-tianyi', 'Lost In Tianyi', 'Lost In Tianyi');
WITH expected(id, name, year, song_count, cover_r2_key, sort_order) AS (
  VALUES
    ('al-6e9d098041', 'Lost in Tianyi', NULL, 9, 'covers/al-6e9d098041', 0),
    ('al-da4b6cd40d', 'Lost In Tianyi', 2018, 9, NULL, 1)
)
INSERT INTO album_display_group_members(group_id, album_id, sort_order)
SELECT 'ag-lost-in-tianyi', a.id, e.sort_order
FROM expected e JOIN albums a ON a.id = e.id
WHERE a.name = e.name AND a.year IS e.year AND a.song_count = e.song_count
  AND a.cover_r2_key IS e.cover_r2_key
  AND (SELECT COUNT(*) FROM song_masters m WHERE m.album_id = a.id) = e.song_count
  AND (SELECT COUNT(*) FROM song_masters m JOIN song_instances si ON si.master_id = m.id WHERE m.album_id = a.id AND si.missing = 0) = e.song_count;
INSERT INTO album_display_groups(id, display_name)
SELECT 'ag-lost-in-tianyi', 'guard' WHERE changes() != 2;

INSERT INTO album_display_groups(id, display_name, sort_name)
VALUES ('ag-huazai-youxia-2', '华哉有夏·贰', '华哉有夏·贰');
WITH expected(id, name, year, song_count, cover_r2_key, sort_order) AS (
  VALUES
    ('al-2dd78c6e22', '华哉有夏·贰', 2021, 8, NULL, 0),
    ('al-00997a7da1', '华哉有夏·贰', NULL, 8, NULL, 1)
)
INSERT INTO album_display_group_members(group_id, album_id, sort_order)
SELECT 'ag-huazai-youxia-2', a.id, e.sort_order
FROM expected e JOIN albums a ON a.id = e.id
WHERE a.name = e.name AND a.year IS e.year AND a.song_count = e.song_count
  AND a.cover_r2_key IS e.cover_r2_key
  AND (SELECT COUNT(*) FROM song_masters m WHERE m.album_id = a.id) = e.song_count
  AND (SELECT COUNT(*) FROM song_masters m JOIN song_instances si ON si.master_id = m.id WHERE m.album_id = a.id AND si.missing = 0) = e.song_count;
INSERT INTO album_display_groups(id, display_name)
SELECT 'ag-huazai-youxia-2', 'guard' WHERE changes() != 2;

INSERT INTO album_display_groups(id, display_name, sort_name)
VALUES ('ag-luo-2023', '洛 LUO', '洛 LUO');
WITH expected(id, name, year, song_count, cover_r2_key, sort_order) AS (
  VALUES
    ('al-2ea8eb469a', '洛 LUO', NULL, 5, 'covers/al-2ea8eb469a', 0),
    ('al-9180eaf495', '洛 LUO', 2023, 5, NULL, 1)
)
INSERT INTO album_display_group_members(group_id, album_id, sort_order)
SELECT 'ag-luo-2023', a.id, e.sort_order
FROM expected e JOIN albums a ON a.id = e.id
WHERE a.name = e.name AND a.year IS e.year AND a.song_count = e.song_count
  AND a.cover_r2_key IS e.cover_r2_key
  AND (SELECT COUNT(*) FROM song_masters m WHERE m.album_id = a.id) = e.song_count
  AND (SELECT COUNT(*) FROM song_masters m JOIN song_instances si ON si.master_id = m.id WHERE m.album_id = a.id AND si.missing = 0) = e.song_count;
INSERT INTO album_display_groups(id, display_name)
SELECT 'ag-luo-2023', 'guard' WHERE changes() != 2;

INSERT INTO album_display_groups(id, display_name, sort_name)
VALUES ('ag-nothing-happened', '无事发生', '无事发生');
WITH expected(id, name, year, song_count, cover_r2_key, sort_order) AS (
  VALUES
    ('al-8a0bee80b4', '无事发生', NULL, 22, 'covers/al-8a0bee80b4', 0),
    ('al-4c6df4d0bc', '无事发生', 2021, 11, 'covers/al-4c6df4d0bc', 1)
)
INSERT INTO album_display_group_members(group_id, album_id, sort_order)
SELECT 'ag-nothing-happened', a.id, e.sort_order
FROM expected e JOIN albums a ON a.id = e.id
WHERE a.name = e.name AND a.year IS e.year AND a.song_count = e.song_count
  AND a.cover_r2_key IS e.cover_r2_key
  AND (SELECT COUNT(*) FROM song_masters m WHERE m.album_id = a.id) = e.song_count
  AND (SELECT COUNT(*) FROM song_masters m JOIN song_instances si ON si.master_id = m.id WHERE m.album_id = a.id AND si.missing = 0) = e.song_count;
INSERT INTO album_display_groups(id, display_name)
SELECT 'ag-nothing-happened', 'guard' WHERE changes() != 2;
