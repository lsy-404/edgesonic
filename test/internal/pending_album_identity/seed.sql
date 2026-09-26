INSERT INTO albums(id,name,song_count,duration,size) VALUES('pending-uploads','Pending Uploads',641,141395,24700222725);
INSERT INTO artists(id,name) VALUES('unknown-artist','Unknown Artist');
INSERT INTO storage_entries(id,path,kind) VALUES('root','蔗蓝的创作集1.0-蔗蓝（wav）','folder');
WITH c(id,n) AS (VALUES
 ('sm-upload-1f9017ea-07f',1),('sm-upload-e736c93d-965',2),('sm-upload-e28f7e1d-766',3),('sm-upload-a6848b06-77d',4),('sm-upload-dd6123b1-898',5),('sm-upload-02e005e7-c69',6),('sm-upload-00211c6c-9ec',7),('sm-upload-ad051eb3-7a3',8),('sm-upload-6994d270-a67',9),('sm-upload-1f16389e-357',10),('sm-upload-048a0756-d80',11),('sm-upload-67927a7e-561',12),('sm-upload-23a540dc-0e6',13),('sm-upload-625aa43b-4d2',14),('sm-upload-72a666eb-1fa',15),('sm-upload-c289a81c-56a',16),('sm-upload-2646aee8-8c7',17),('sm-upload-6459b53d-e6e',18),('sm-upload-d2e15dcf-ef7',19),('sm-upload-72dbb920-90d',20),('sm-upload-29aa737e-d7d',21),('sm-upload-82fdd9cb-3dc',22),('sm-upload-1a1b38e3-18e',23),('sm-upload-0534d6fb-3e6',24),('sm-upload-3511d1fa-551',25),('sm-upload-f22fe5c6-23b',26),('sm-upload-ad9a3f3a-778',27),('sm-upload-ccea0ae3-484',28))
INSERT INTO song_masters(id,album_id,artist_id,title,duration) SELECT id,'pending-uploads','unknown-artist',printf('%02d fixture',n),n FROM c;
WITH c(id,n) AS (SELECT id,ROW_NUMBER() OVER (ORDER BY id) FROM song_masters WHERE id LIKE 'sm-upload-%')
INSERT INTO storage_objects(id,physical_key,suffix,size) SELECT 'obj-'||n,'objects/obj-'||n||'.wav','wav',n FROM c;
WITH c(id,n) AS (SELECT id,ROW_NUMBER() OVER (ORDER BY id) FROM song_masters WHERE id LIKE 'sm-upload-%')
INSERT INTO song_instances(id,master_id,source_id,source_type,suffix,size,duration,missing,tag_scanned,storage_object_id) SELECT 'si-'||n,id,'r2-local','original','wav',n,n,0,1,'obj-'||n FROM c;
WITH c(id,n) AS (SELECT id,ROW_NUMBER() OVER (ORDER BY id) FROM song_masters WHERE id LIKE 'sm-upload-%')
INSERT INTO storage_entries(id,parent_id,path,kind,object_id,instance_id) SELECT 'se-'||n,'se-e43af23755444b1aa56d4501c7ba77d4','蔗蓝的创作集1.0-蔗蓝（wav）/'||printf('%02d',n)||' fixture.wav','file','obj-'||n,'si-'||n FROM c;
INSERT INTO storage_objects(id,physical_key,suffix,size) VALUES('obj_568cc33144589d95','objects/obj_568cc33144589d95.cue','cue',1);
INSERT INTO storage_entries(id,parent_id,path,kind,object_id) VALUES('se-9c7a6e8fe38949a6b6a231dafc7ccad1','se-e43af23755444b1aa56d4501c7ba77d4','蔗蓝的创作集1.0-蔗蓝（wav）/蔗蓝的创作集1.0.cue','file','obj_568cc33144589d95');
