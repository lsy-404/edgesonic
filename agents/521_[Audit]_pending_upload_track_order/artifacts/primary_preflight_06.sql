WITH expected(master_id, album_id, filename_track) AS (VALUES
  ('sm-upload-5d8c3e73-3b9', 'al-fe774f1b1c6a6738d25d732bcf66a64d', 8),
  ('sm-upload-0f2858ab-23e', 'al-fe774f1b1c6a6738d25d732bcf66a64d', 9),
  ('sm-upload-5c324864-c88', 'al-fe774f1b1c6a6738d25d732bcf66a64d', 10)
)
SELECT e.master_id, e.album_id AS expected_album_id, e.filename_track,
       sm.id AS actual_master_id, sm.album_id AS actual_album_id, sm.track, sm.disc
FROM expected e LEFT JOIN song_masters sm ON sm.id=e.master_id
ORDER BY e.album_id, e.filename_track, e.master_id;
