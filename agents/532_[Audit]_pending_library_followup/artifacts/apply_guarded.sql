WITH candidate AS (
  SELECT sm.id,se.display_name FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' JOIN storage_objects so ON so.id=si.storage_object_id
  WHERE instr(se.path,'你的灵魂长出一支玫瑰（人声版）')>0 AND sm.album_id='pending-uploads' AND sm.track IS NULL AND sm.disc IS NULL AND si.suffix='wav' AND si.missing=0 AND si.tag_scanned=1 AND so.physical_key='objects/' || so.id || '.wav'
), guard(ok) AS (SELECT COUNT(*)=13 AND COUNT(DISTINCT id)=13 AND COUNT(DISTINCT CAST(substr(display_name,1,2) AS INTEGER))=13 AND MIN(CAST(substr(display_name,1,2) AS INTEGER))=1 AND MAX(CAST(substr(display_name,1,2) AS INTEGER))=13 FROM candidate)
INSERT INTO albums(id,name,sort_name,song_count,duration,size,compilation,created_at,updated_at)
SELECT 'al-rose-2025-vocal-20260926','你的灵魂长出一支玫瑰（人声版）','你的灵魂长出一支玫瑰 人声版',13,0,0,0,unixepoch(),unixepoch()
WHERE (SELECT ok FROM guard) AND (SELECT song_count FROM albums WHERE id='pending-uploads')=605 AND NOT EXISTS(SELECT 1 FROM albums WHERE id='al-rose-2025-vocal-20260926');
SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END;

WITH candidate AS (SELECT sm.id,se.display_name FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' JOIN storage_objects so ON so.id=si.storage_object_id WHERE instr(se.path,'你的灵魂长出一支玫瑰（人声版）')>0 AND sm.album_id='pending-uploads' AND sm.track IS NULL AND sm.disc IS NULL AND si.suffix='wav' AND si.missing=0 AND si.tag_scanned=1 AND so.physical_key='objects/' || so.id || '.wav')
UPDATE song_masters SET album_id='al-rose-2025-vocal-20260926',disc=1,track=(SELECT CAST(substr(display_name,1,2) AS INTEGER) FROM candidate WHERE candidate.id=song_masters.id),updated_at=unixepoch() WHERE id IN(SELECT id FROM candidate) AND EXISTS(SELECT 1 FROM albums WHERE id='al-rose-2025-vocal-20260926');
SELECT CASE WHEN changes()=13 THEN 1 ELSE abs(-9223372036854775808) END;

UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN('pending-uploads','al-rose-2025-vocal-20260926');
SELECT CASE WHEN changes()=2 THEN 1 ELSE abs(-9223372036854775808) END;
SELECT CASE WHEN (SELECT song_count FROM albums WHERE id='al-rose-2025-vocal-20260926')=13 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-rose-2025-vocal-20260926' AND disc=1 AND track BETWEEN 1 AND 13)=13 THEN 1 ELSE abs(-9223372036854775808) END;
