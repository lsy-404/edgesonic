-- Retire only two verified AppleDouble resource-fork sidecars from the library.
-- R2 objects and storage_objects intentionally remain for recovery evidence.

DELETE FROM storage_entries
WHERE id IN ('se-90c99a8efdcb4a8d8f98dae14c0b54f6', 'se-5f1eae6efc5c4b7da336d0c499c780f3')
  AND (
    (id = 'se-90c99a8efdcb4a8d8f98dae14c0b54f6'
      AND source_id = 'r2-local'
      AND parent_id = 'se-43ce6cb7239645558c5e9acd48ff2b30'
      AND path = '遇依 成曲/__MACOSX/成曲/成曲/._12 另一世界的你.wav'
      AND display_name = '._12 另一世界的你.wav'
      AND kind = 'file'
      AND object_id = 'obj_46853707a4374e3f'
      AND instance_id = 'si-upload-3d42deba-be4'
      AND companion_of IS NULL)
    OR
    (id = 'se-5f1eae6efc5c4b7da336d0c499c780f3'
      AND source_id = 'r2-local'
      AND parent_id = 'se-43ce6cb7239645558c5e9acd48ff2b30'
      AND path = '遇依 成曲/__MACOSX/成曲/成曲/._4 南风.wav'
      AND display_name = '._4 南风.wav'
      AND kind = 'file'
      AND object_id = 'obj_9cd17677e37b57ae'
      AND instance_id = 'si-upload-41afe0be-b8a'
      AND companion_of IS NULL)
  )
  AND 2 = (
    SELECT COUNT(*) FROM storage_entries
    WHERE (id = 'se-90c99a8efdcb4a8d8f98dae14c0b54f6'
           AND source_id = 'r2-local' AND parent_id = 'se-43ce6cb7239645558c5e9acd48ff2b30'
           AND path = '遇依 成曲/__MACOSX/成曲/成曲/._12 另一世界的你.wav'
           AND display_name = '._12 另一世界的你.wav' AND kind = 'file'
           AND object_id = 'obj_46853707a4374e3f' AND instance_id = 'si-upload-3d42deba-be4'
           AND companion_of IS NULL)
       OR (id = 'se-5f1eae6efc5c4b7da336d0c499c780f3'
           AND source_id = 'r2-local' AND parent_id = 'se-43ce6cb7239645558c5e9acd48ff2b30'
           AND path = '遇依 成曲/__MACOSX/成曲/成曲/._4 南风.wav'
           AND display_name = '._4 南风.wav' AND kind = 'file'
           AND object_id = 'obj_9cd17677e37b57ae' AND instance_id = 'si-upload-41afe0be-b8a'
           AND companion_of IS NULL)
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM song_instances si
    JOIN song_masters sm ON sm.id = si.master_id
    JOIN storage_objects so ON so.id = si.storage_object_id
    WHERE (sm.id = 'sm-upload-1dad3581-327'
           AND sm.album_id = 'pending-uploads' AND sm.artist_id = 'unknown-artist'
           AND sm.title = '._12 另一世界的你'
           AND si.id = 'si-upload-3d42deba-be4' AND si.source_id = 'r2-local'
           AND si.source_type = 'original' AND si.storage_uri = 'r2://objects/obj_46853707a4374e3f.wav'
           AND si.storage_object_id = 'obj_46853707a4374e3f' AND si.suffix = 'wav'
           AND si.content_type = 'audio/wav' AND si.size = 176 AND si.missing = 0 AND si.tag_scanned = 1
           AND so.physical_key = 'objects/obj_46853707a4374e3f.wav' AND so.size = 176
           AND so.etag = 'b954c440f766c22dc1ee864ce123a552')
       OR (sm.id = 'sm-upload-bc490030-464'
           AND sm.album_id = 'pending-uploads' AND sm.artist_id = 'unknown-artist'
           AND sm.title = '._4 南风'
           AND si.id = 'si-upload-41afe0be-b8a' AND si.source_id = 'r2-local'
           AND si.source_type = 'original' AND si.storage_uri = 'r2://objects/obj_9cd17677e37b57ae.wav'
           AND si.storage_object_id = 'obj_9cd17677e37b57ae' AND si.suffix = 'wav'
           AND si.content_type = 'audio/wav' AND si.size = 176 AND si.missing = 0 AND si.tag_scanned = 1
           AND so.physical_key = 'objects/obj_9cd17677e37b57ae.wav' AND so.size = 176
           AND so.etag = 'aaca93a9fd581611ac1fb2a7eb22a783')
  )
  AND 2 = (
    SELECT COUNT(*) FROM work_queue
    WHERE (id = 'wt-metadata-si-upload-3d42deba-be4'
           AND task_type = 'metadata' AND status = 'completed' AND attempts = 1
           AND payload = '{"instanceId":"si-upload-3d42deba-be4","sourceUri":"r2://objects/obj_46853707a4374e3f.wav","suffix":"wav","size":176}')
       OR (id = 'wt-metadata-si-upload-41afe0be-b8a'
           AND task_type = 'metadata' AND status = 'completed' AND attempts = 1
           AND payload = '{"instanceId":"si-upload-41afe0be-b8a","sourceUri":"r2://objects/obj_9cd17677e37b57ae.wav","suffix":"wav","size":176}')
  );

DELETE FROM storage_entries
WHERE id = 'se-43ce6cb7239645558c5e9acd48ff2b30'
  AND source_id = 'r2-local'
  AND parent_id = 'se-19c7b239036f4af085368d01c0f5ba0c'
  AND path = '遇依 成曲/__MACOSX/成曲/成曲'
  AND display_name = '成曲'
  AND kind = 'folder'
  AND object_id IS NULL AND instance_id IS NULL AND companion_of IS NULL
  AND NOT EXISTS (SELECT 1 FROM storage_entries WHERE parent_id = 'se-43ce6cb7239645558c5e9acd48ff2b30');

DELETE FROM storage_entries
WHERE id = 'se-19c7b239036f4af085368d01c0f5ba0c'
  AND source_id = 'r2-local'
  AND parent_id = 'se-76a936f017574c6e8019bb6bab14437d'
  AND path = '遇依 成曲/__MACOSX/成曲'
  AND display_name = '成曲'
  AND kind = 'folder'
  AND object_id IS NULL AND instance_id IS NULL AND companion_of IS NULL
  AND NOT EXISTS (SELECT 1 FROM storage_entries WHERE parent_id = 'se-19c7b239036f4af085368d01c0f5ba0c');

DELETE FROM storage_entries
WHERE id = 'se-76a936f017574c6e8019bb6bab14437d'
  AND source_id = 'r2-local'
  AND parent_id = 'se-affca85b8070429b9f6c18268697ef60'
  AND path = '遇依 成曲/__MACOSX'
  AND display_name = '__MACOSX'
  AND kind = 'folder'
  AND object_id IS NULL AND instance_id IS NULL AND companion_of IS NULL
  AND NOT EXISTS (SELECT 1 FROM storage_entries WHERE parent_id = 'se-76a936f017574c6e8019bb6bab14437d');

DELETE FROM song_instances
WHERE id IN ('si-upload-3d42deba-be4', 'si-upload-41afe0be-b8a')
  AND (
    (id = 'si-upload-3d42deba-be4' AND master_id = 'sm-upload-1dad3581-327'
      AND source_id = 'r2-local' AND source_type = 'original'
      AND storage_uri = 'r2://objects/obj_46853707a4374e3f.wav'
      AND storage_object_id = 'obj_46853707a4374e3f' AND suffix = 'wav'
      AND content_type = 'audio/wav' AND size = 176 AND missing = 0 AND tag_scanned = 1)
    OR
    (id = 'si-upload-41afe0be-b8a' AND master_id = 'sm-upload-bc490030-464'
      AND source_id = 'r2-local' AND source_type = 'original'
      AND storage_uri = 'r2://objects/obj_9cd17677e37b57ae.wav'
      AND storage_object_id = 'obj_9cd17677e37b57ae' AND suffix = 'wav'
      AND content_type = 'audio/wav' AND size = 176 AND missing = 0 AND tag_scanned = 1)
  )
  AND 2 = (SELECT COUNT(*) FROM song_instances WHERE id IN ('si-upload-3d42deba-be4', 'si-upload-41afe0be-b8a'))
  AND NOT EXISTS (SELECT 1 FROM storage_entries WHERE instance_id IN ('si-upload-3d42deba-be4', 'si-upload-41afe0be-b8a'))
  AND NOT EXISTS (SELECT 1 FROM song_instances WHERE parent_instance_id IN ('si-upload-3d42deba-be4', 'si-upload-41afe0be-b8a'))
  AND NOT EXISTS (SELECT 1 FROM transcode_jobs WHERE instance_id IN ('si-upload-3d42deba-be4', 'si-upload-41afe0be-b8a') OR output_instance_id IN ('si-upload-3d42deba-be4', 'si-upload-41afe0be-b8a'));

DELETE FROM song_masters
WHERE id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464')
  AND ((id = 'sm-upload-1dad3581-327' AND album_id = 'pending-uploads' AND artist_id = 'unknown-artist' AND title = '._12 另一世界的你')
    OR (id = 'sm-upload-bc490030-464' AND album_id = 'pending-uploads' AND artist_id = 'unknown-artist' AND title = '._4 南风'))
  AND 2 = (SELECT COUNT(*) FROM song_masters WHERE id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464'))
  AND NOT EXISTS (SELECT 1 FROM song_instances WHERE master_id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464'))
  AND NOT EXISTS (SELECT 1 FROM playlist_songs WHERE song_master_id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464'))
  AND NOT EXISTS (SELECT 1 FROM annotations WHERE item_type = 'song' AND item_id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464'))
  AND NOT EXISTS (SELECT 1 FROM song_artists WHERE song_id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464'));

SELECT
  (SELECT COUNT(*) FROM song_masters WHERE id IN ('sm-upload-1dad3581-327', 'sm-upload-bc490030-464')) AS masters_remaining,
  (SELECT COUNT(*) FROM song_instances WHERE id IN ('si-upload-3d42deba-be4', 'si-upload-41afe0be-b8a')) AS instances_remaining,
  (SELECT COUNT(*) FROM storage_entries WHERE id IN ('se-76a936f017574c6e8019bb6bab14437d','se-19c7b239036f4af085368d01c0f5ba0c','se-43ce6cb7239645558c5e9acd48ff2b30','se-90c99a8efdcb4a8d8f98dae14c0b54f6','se-5f1eae6efc5c4b7da336d0c499c780f3')) AS tree_remaining,
  (SELECT COUNT(*) FROM storage_objects WHERE id IN ('obj_46853707a4374e3f','obj_9cd17677e37b57ae')) AS recovery_objects_remaining,
  (SELECT COUNT(*) FROM work_queue WHERE id IN ('wt-metadata-si-upload-3d42deba-be4','wt-metadata-si-upload-41afe0be-b8a') AND status = 'completed') AS completed_queue_evidence;
