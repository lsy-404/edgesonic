CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, cover_r2_key TEXT, song_count INTEGER, duration INTEGER, size INTEGER, compilation INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER, participants TEXT, created_at INTEGER, updated_at INTEGER, lyrics TEXT, lyrics_rich TEXT, cover_r2_key TEXT);
CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_object_id TEXT, suffix TEXT NOT NULL, size INTEGER);
CREATE TABLE storage_objects (id TEXT PRIMARY KEY);
CREATE TABLE storage_entries (id TEXT PRIMARY KEY, instance_id TEXT, object_id TEXT, path TEXT NOT NULL);
CREATE TABLE song_artists (song_id TEXT NOT NULL, artist_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (song_id, artist_id));
CREATE TABLE album_display_groups (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, sort_name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE album_display_group_members (group_id TEXT NOT NULL, album_id TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, album_id));

INSERT INTO albums VALUES ('al-1a27548730','平行四界Quadimension 3','平行四界quadimension 3',2015,'Vocaloid','covers/al-1a27548730',9,2334,0,0,0,0);
INSERT INTO albums VALUES ('pending-uploads','Pending Uploads','pending uploads',2012,'Abstract','covers/pending-uploads',0,0,0,0,0,0);

INSERT INTO song_masters VALUES
('495','al-1a27548730','ar-2b4aeae2d9','ar-0486c50bd5','粉色柠檬','粉色柠檬',1,1,263,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('497','al-1a27548730','ar-2b4aeae2d9','ar-0486c50bd5','Princess Syndrome','princess syndrome',2,1,264,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('496','al-1a27548730','ar-b86d3071fc','ar-0486c50bd5','Scarlet Drop','scarlet drop',3,1,263,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('494','al-1a27548730','ar-2b4aeae2d9','ar-0486c50bd5','Hemisphere','hemisphere',4,1,253,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('491','al-1a27548730','ar-2b4aeae2d9','ar-0486c50bd5','Overresonated','overresonated',5,1,292,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('490','al-1a27548730','ar-2b4aeae2d9','ar-0486c50bd5','共鸣曲','共鸣曲',6,1,270,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('489','al-1a27548730','ar-2b4aeae2d9','ar-0486c50bd5','梨花泽泽远山远','梨花泽泽远山远',7,1,210,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('492','al-1a27548730','ar-b86d3071fc','ar-0486c50bd5','渊之心','渊之心',8,1,273,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('493','al-1a27548730','ar-2b4aeae2d9','ar-0486c50bd5','Seattle物语II','seattle物语ii',9,1,246,'Vocaloid',0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-b8fabd82-f0b','pending-uploads','unknown-artist',NULL,'01  -粉色柠檬',NULL,NULL,NULL,264,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-14ec6786-592','pending-uploads','unknown-artist',NULL,'02  - Princess Syndrome',NULL,NULL,NULL,264,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-55c19ccc-aa2','pending-uploads','unknown-artist',NULL,'03  - Scarlet Drop',NULL,NULL,NULL,263,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-820671c5-bbe','pending-uploads','unknown-artist',NULL,'04  - Hemisphere',NULL,NULL,NULL,253,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-03ccb298-4a1','pending-uploads','unknown-artist',NULL,'05  - Overresonated',NULL,NULL,NULL,292,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-9a545ddf-565','pending-uploads','unknown-artist',NULL,'06  -共鸣曲',NULL,NULL,NULL,270,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-dc94f069-0d2','pending-uploads','unknown-artist',NULL,'07  -梨花泽泽远山远',NULL,NULL,NULL,210,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-4bd88968-092','pending-uploads','unknown-artist',NULL,'08  -渊之心',NULL,NULL,NULL,273,NULL,0,NULL,0,0,NULL,NULL,NULL),
('sm-upload-bf258535-10a','pending-uploads','unknown-artist',NULL,'09  -Seattle物语II',NULL,NULL,NULL,246,NULL,0,NULL,0,0,NULL,NULL,NULL);

INSERT INTO storage_objects VALUES ('obj_6f5f7eb6b38e540a'),('obj_3e224dbf7ea72367'),('obj_01670fcda29a45b7'),('obj_28dec5d5e31a5385'),('obj_bd32313e8b2d344b'),('obj_b5df9c696e9642db'),('obj_3e3105c88a8bd0f4'),('obj_2d695562524877fc'),('obj_f416b1299925a47d');
INSERT INTO song_instances VALUES
('si-upload-b2b67d68-1e9','sm-upload-b8fabd82-f0b','obj_6f5f7eb6b38e540a','wav',1),('si-upload-6f1bc3a4-0d1','sm-upload-14ec6786-592','obj_3e224dbf7ea72367','wav',2),('si-upload-96edf67f-07d','sm-upload-55c19ccc-aa2','obj_01670fcda29a45b7','wav',3),('si-upload-bddf767f-75e','sm-upload-820671c5-bbe','obj_28dec5d5e31a5385','wav',4),('si-upload-a9d8a957-241','sm-upload-03ccb298-4a1','obj_bd32313e8b2d344b','wav',5),('si-upload-265893d2-568','sm-upload-9a545ddf-565','obj_b5df9c696e9642db','wav',6),('si-upload-ca5f8dd5-d54','sm-upload-dc94f069-0d2','obj_3e3105c88a8bd0f4','wav',7),('si-upload-c2f0c37b-d5e','sm-upload-4bd88968-092','obj_2d695562524877fc','wav',8),('si-upload-b0162f2a-e49','sm-upload-bf258535-10a','obj_f416b1299925a47d','wav',9);
INSERT INTO storage_entries VALUES
('se-c469d17528fd48129a266e76bb4d7fa3','si-upload-b2b67d68-1e9','obj_6f5f7eb6b38e540a','平四1-6/平行四界3/01  -粉色柠檬.wav'),('se-bed3d9e30b974d8f8ea7edc91165e874','si-upload-6f1bc3a4-0d1','obj_3e224dbf7ea72367','平四1-6/平行四界3/02  - Princess Syndrome.wav'),('se-70f6c244a66e42d18ddcd294d1f105df','si-upload-96edf67f-07d','obj_01670fcda29a45b7','平四1-6/平行四界3/03  - Scarlet Drop.wav'),('se-fa901183bece4047804408dc60da9656','si-upload-bddf767f-75e','obj_28dec5d5e31a5385','平四1-6/平行四界3/04  - Hemisphere.wav'),('se-24799201e961499d8cb8ae90b11258c2','si-upload-a9d8a957-241','obj_bd32313e8b2d344b','平四1-6/平行四界3/05  - Overresonated.wav'),('se-48f3222e87e048f4b863560cb6302bb4','si-upload-265893d2-568','obj_b5df9c696e9642db','平四1-6/平行四界3/06  -共鸣曲.wav'),('se-b462fc06b2754b5481115546cc31c3b8','si-upload-ca5f8dd5-d54','obj_3e3105c88a8bd0f4','平四1-6/平行四界3/07  -梨花泽泽远山远.wav'),('se-3e3ae8ad196840489056ac3da3cb1ee9','si-upload-c2f0c37b-d5e','obj_2d695562524877fc','平四1-6/平行四界3/08  -渊之心.wav'),('se-ca6844d844364d37be4a18d03cb07636','si-upload-b0162f2a-e49','obj_f416b1299925a47d','平四1-6/平行四界3/09  -Seattle物语II.wav');
INSERT INTO song_artists VALUES ('495','ar-2b4aeae2d9',0),('497','ar-2b4aeae2d9',0),('496','ar-b86d3071fc',0),('494','ar-2b4aeae2d9',0),('491','ar-2b4aeae2d9',0),('490','ar-2b4aeae2d9',0),('489','ar-2b4aeae2d9',0),('492','ar-b86d3071fc',0),('493','ar-2b4aeae2d9',0);
