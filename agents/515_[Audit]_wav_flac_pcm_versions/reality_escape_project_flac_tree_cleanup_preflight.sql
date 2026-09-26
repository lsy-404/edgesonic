-- Candidate SHA-256: 7e776c0e8bc3dfc7c59196e147251c1badb9dda2e454fc6d90bc0123bcf813b6
WITH expected(entry_id,source_id,parent_id,path,display_name,kind,object_id,instance_id,companion_of,physical_key,etag,object_size,suffix,content_type) AS (VALUES
  ('se-93d282bed0ef437d946745205373a49f','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/01.渺小的Producer.flac','01.渺小的Producer.flac','file','obj_0718612234f6a736',NULL,NULL,'objects/obj_0718612234f6a736.flac','35f78c2c65b15d37876b2eadd379875d',40681847,'flac','audio/flac'),
  ('se-a3d57e22ee164ede87a934eeaa80ce8b','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/02.抄袭Paranoia.flac','02.抄袭Paranoia.flac','file','obj_25ef5ea9099fbab6',NULL,NULL,'objects/obj_25ef5ea9099fbab6.flac','bc83dbb83616b0b970f7181904a8e642',25616960,'flac','audio/flac'),
  ('se-ddaee8e0624a498f94132881d4a43850','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/03.偶像Priority.flac','03.偶像Priority.flac','file','obj_d6c7eec474ae5f18',NULL,NULL,'objects/obj_d6c7eec474ae5f18.flac','7f3dda8246e3dae7b1d1107c3f2d0e22',47246694,'flac','audio/flac'),
  ('se-14242e168fbb4118873dfb526a35edfc','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/04.虚拟Paradise.flac','04.虚拟Paradise.flac','file','obj_e968d58a57ed0d4a',NULL,NULL,'objects/obj_e968d58a57ed0d4a.flac','8a91984cec631756e3e82d651bd01db2',31575909,'flac','audio/flac'),
  ('se-e6467290f5734f5496791a95a2d4dd4a','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/05.暧昧Philosopher.flac','05.暧昧Philosopher.flac','file','obj_67ef883ef5348e7e',NULL,NULL,'objects/obj_67ef883ef5348e7e.flac','dc59e4d62f75fea9b5145f970ebe78fd',26197903,'flac','audio/flac'),
  ('se-61ad923ce7914197ad7a1a34aff920e7','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/06.告别Performance.flac','06.告别Performance.flac','file','obj_b575d1145ee34e20',NULL,NULL,'objects/obj_b575d1145ee34e20.flac','7881bb2ec315ca8cf6e0879b04c590ac',34428744,'flac','audio/flac'),
  ('se-b19e0c5023cf45d4b30cb0adfa818a2e','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/07.所以我选择被人讨厌.flac','07.所以我选择被人讨厌.flac','file','obj_23872c1fb03925b3',NULL,NULL,'objects/obj_23872c1fb03925b3.flac','39b780236a0dafbcb8f2a9577d07522f',30526932,'flac','audio/flac'),
  ('se-871d1af68e1c41d68116c88c07838894','r2-local','se-45ab36e1985c46688853454f23fa0d5b','现实逃避 Project[flac]/flac/08.Political不正确.flac','08.Political不正确.flac','file','obj_7d24a124759db7f0',NULL,NULL,'objects/obj_7d24a124759db7f0.flac','345099d1f2fba7dfaae5b1676daee12f',36155466,'flac','audio/flac')
), bad AS (
  SELECT 1 WHERE NOT (
    (SELECT count(*) FROM albums WHERE id='al-2970d648d9' AND song_count=8 AND duration=2126 AND size=379557136 AND compilation=0)=1
    AND (SELECT count(*) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id='al-2970d648d9' AND si.suffix='wav')=8
    AND (SELECT count(*) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-2970d648d9' AND si.suffix='flac')=0
    AND (SELECT count(*) FROM expected)=8
    AND (SELECT count(*) FROM expected e JOIN storage_entries se ON se.id=e.entry_id AND se.source_id=e.source_id AND se.parent_id=e.parent_id AND se.path=e.path AND se.display_name=e.display_name AND se.kind=e.kind AND se.object_id=e.object_id AND se.instance_id IS NULL AND se.companion_of IS e.companion_of JOIN storage_objects so ON so.id=e.object_id AND so.physical_key=e.physical_key AND so.etag=e.etag AND so.size=e.object_size AND so.suffix=e.suffix AND so.content_type=e.content_type)=8
    AND (SELECT count(*) FROM storage_objects WHERE id IN ('obj_0718612234f6a736','obj_25ef5ea9099fbab6','obj_d6c7eec474ae5f18','obj_e968d58a57ed0d4a','obj_67ef883ef5348e7e','obj_b575d1145ee34e20','obj_23872c1fb03925b3','obj_7d24a124759db7f0'))=8
    AND (SELECT count(*) FROM storage_entries WHERE parent_id IN ('se-93d282bed0ef437d946745205373a49f','se-a3d57e22ee164ede87a934eeaa80ce8b','se-ddaee8e0624a498f94132881d4a43850','se-14242e168fbb4118873dfb526a35edfc','se-e6467290f5734f5496791a95a2d4dd4a','se-61ad923ce7914197ad7a1a34aff920e7','se-b19e0c5023cf45d4b30cb0adfa818a2e','se-871d1af68e1c41d68116c88c07838894'))=0
    AND NOT EXISTS (SELECT 1 FROM work_queue WHERE id IN ('guard:reality-tree-cleanup-pre','guard:reality-tree-cleanup-post'))
  )
)
SELECT count(*) AS guard_failed FROM bad;
