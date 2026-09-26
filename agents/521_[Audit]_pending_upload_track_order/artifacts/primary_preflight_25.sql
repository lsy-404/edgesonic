WITH expected(master_id, target_album_id, filename_track, instance_id, entry_id, source_id, parent_id, path, display_name, storage_object_id) AS (VALUES
  ('sm-upload-5d8c3e73-3b9', 'al-fe774f1b1c6a6738d25d732bcf66a64d', 8, 'si-upload-57b3d3e3-9af', 'se-0ff797041064463b96f4c958aa030db8', 'r2-local', 'se-448dfe2a3340435dbe7442e2d0ee60bb', 'SE＞EN(Sya)SEVEN/音频WAV/08-不要在这种时候才想起我.wav', '08-不要在这种时候才想起我.wav', 'obj_451faeb13a9c0df5'),
  ('sm-upload-0f2858ab-23e', 'al-fe774f1b1c6a6738d25d732bcf66a64d', 9, 'si-upload-d500860f-6a1', 'se-b98689c16e15415ab37a4f7cb88acdba', 'r2-local', 'se-448dfe2a3340435dbe7442e2d0ee60bb', 'SE＞EN(Sya)SEVEN/音频WAV/09-我是如此地.wav', '09-我是如此地.wav', 'obj_f69c59bd4666ea24'),
  ('sm-upload-5c324864-c88', 'al-fe774f1b1c6a6738d25d732bcf66a64d', 10, 'si-upload-c7e84481-4ac', 'se-79e1116dba7846898e4f4221755a0ab9', 'r2-local', 'se-448dfe2a3340435dbe7442e2d0ee60bb', 'SE＞EN(Sya)SEVEN/音频WAV/10-深夜电台.wav', '10-深夜电台.wav', 'obj_6a67bb57c292ef97')
)
SELECT e.master_id, e.target_album_id AS expected_album_id, e.filename_track, e.instance_id, e.entry_id, e.source_id, e.parent_id, e.path AS expected_path, e.display_name AS expected_display_name, e.storage_object_id AS expected_storage_object_id, sm.id AS actual_master_id, sm.album_id AS actual_album_id, sm.track, sm.disc, sm.album_id=e.target_album_id AND sm.track IS NULL AND sm.disc IS NULL
AND EXISTS (SELECT 1 FROM song_instances si JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file'
            WHERE si.id=e.instance_id AND si.master_id=sm.id AND si.source_id=e.source_id
              AND si.storage_object_id=e.storage_object_id AND se.id=e.entry_id AND se.source_id=e.source_id
              AND se.parent_id=e.parent_id AND se.path=e.path AND se.display_name=e.display_name) AS exact_source_match FROM expected e LEFT JOIN song_masters sm ON sm.id=e.master_id ORDER BY e.target_album_id, e.filename_track, e.master_id;
