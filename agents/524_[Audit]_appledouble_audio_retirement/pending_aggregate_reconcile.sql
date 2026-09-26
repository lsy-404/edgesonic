UPDATE albums
SET song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = 'pending-uploads'),
    duration = (SELECT COALESCE(SUM(duration), 0) FROM song_masters WHERE album_id = 'pending-uploads'),
    size = (SELECT COALESCE(SUM(si.size), 0) FROM song_masters sm JOIN song_instances si ON si.master_id = sm.id WHERE sm.album_id = 'pending-uploads'),
    updated_at = unixepoch()
WHERE id = 'pending-uploads'
  AND song_count = 694
  AND duration = 153488
  AND size = 27080297985
  AND (SELECT COUNT(*) FROM song_masters WHERE album_id = 'pending-uploads') = 692
  AND (SELECT COALESCE(SUM(duration), 0) FROM song_masters WHERE album_id = 'pending-uploads') = 153488
  AND (SELECT COALESCE(SUM(si.size), 0) FROM song_masters sm JOIN song_instances si ON si.master_id = sm.id WHERE sm.album_id = 'pending-uploads') = 27080297633
  AND NOT EXISTS (SELECT 1 FROM song_masters WHERE id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464'));
