import json,hashlib,pathlib,collections,datetime,sys
base=pathlib.Path('agents/513_[Operations]_pending_upload_backfill')
candidate_path=base/(sys.argv[1] if len(sys.argv)>1 else 'candidate_map.json')
out=base/(sys.argv[2] if len(sys.argv)>2 else 'batches')
label='' if out.name=='batches' else '_'+out.name.replace('batches_','')
for d in ('preflight','apply','rollback','postflight'):
 p=out/d
 if p.exists():
  for f in p.iterdir(): f.unlink()
 else:p.mkdir(parents=True)
rows=json.loads(candidate_path.read_text(encoding='utf-8'))
groups=collections.defaultdict(list)
for r in rows: groups[(r['source_id'],r['parent_id'],r['suffix'],r['album_name'],r['target_album_id'])].append(r)
def q(v):return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
def values(items,fields):return ',\n'.join('('+','.join(q(x[k]) for k in fields)+')' for x in items)
def exact_exists(r,master_alias='sm'):
 return f"EXISTS (SELECT 1 FROM song_instances si JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' JOIN storage_objects so ON so.id=si.storage_object_id WHERE si.id={q(r['instance_id'])} AND si.master_id={master_alias}.id AND {master_alias}.title IS {q(r['title_snapshot'])} AND {master_alias}.disc IS {q(r['disc_snapshot'])} AND {master_alias}.track IS {q(r['track_snapshot'])} AND si.source_id={q(r['source_id'])} AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)={q(r['suffix'])} AND si.storage_object_id={q(r['storage_object_id'])} AND so.id={q(r['storage_object_id'])} AND se.id={q(r['entry_id'])} AND se.source_id={q(r['source_id'])} AND se.parent_id={q(r['parent_id'])} AND se.object_id=si.storage_object_id AND se.path={q(r['path'])} AND se.display_name={q(r['display_name'])} AND (SELECT COUNT(*) FROM storage_entries f WHERE f.instance_id=si.id AND f.kind='file')=1)"
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest=[]; all_groups=[]
for no,key in enumerate(sorted(groups),1):
 source,parent,suffix,name,target=key; items=sorted(groups[key],key=lambda x:x['master_id']); bid=f"batch_{no:03d}_{target[-8:]}_{suffix}_{len(items):02d}"
 cte='WITH c(master_id,instance_id,entry_id,object_id,title_snapshot,disc_snapshot,track_snapshot) AS (VALUES\n'+values(items,['master_id','instance_id','entry_id','storage_object_id','title_snapshot','disc_snapshot','track_snapshot'])+'\n)\n'
 expected=len(items)
 match=f"(SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id='pending-uploads' AND sm.title IS c.title_snapshot AND sm.disc IS c.disc_snapshot AND sm.track IS c.track_snapshot JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id AND si.source_id={q(source)} AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)={q(suffix)} AND si.storage_object_id=c.object_id JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id AND se.kind='file' AND se.source_id={q(source)} AND se.parent_id={q(parent)} AND se.object_id=si.storage_object_id JOIN storage_objects so ON so.id=c.object_id WHERE (SELECT COUNT(*) FROM storage_entries f WHERE f.instance_id=si.id AND f.kind='file')=1)"
 titledup=f"(SELECT COUNT(*) FROM (SELECT lower(trim(sm.title)) FROM c JOIN song_masters sm ON sm.id=c.master_id GROUP BY lower(trim(sm.title)) HAVING COUNT(*)>1))"
 trackdup=f"(SELECT COUNT(*) FROM (SELECT COALESCE(sm.disc,0),sm.track FROM c JOIN song_masters sm ON sm.id=c.master_id WHERE sm.track IS NOT NULL GROUP BY COALESCE(sm.disc,0),sm.track HAVING COUNT(*)>1))"
 other=f"(SELECT COUNT(*) FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id AND si.source_id={q(source)} AND lower(si.suffix)={q(suffix)} JOIN song_masters sm ON sm.id=si.master_id WHERE se.kind='file' AND se.source_id={q(source)} AND se.parent_id={q(parent)} AND sm.album_id!='pending-uploads')"
 allowed_other={'2024虚拟歌手夏浪派对——「创作」': {'sm-upload-36994a13-b28':'al-cb52162ace'}}.get(name,{})
 allowed_ids=','.join(q(x) for x in allowed_other) or "''"
 allowed_album_ids=','.join(q(x) for x in set(allowed_other.values())) or "''"
 other_not_allowlisted=f"(SELECT COUNT(*) FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id AND si.source_id={q(source)} AND lower(si.suffix)={q(suffix)} JOIN song_masters sm ON sm.id=si.master_id WHERE se.kind='file' AND se.source_id={q(source)} AND se.parent_id={q(parent)} AND sm.album_id!='pending-uploads' AND sm.id NOT IN ({allowed_ids}))"
 allowlist_matches=f"(SELECT COUNT(*) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' WHERE sm.id IN ({allowed_ids}) AND sm.album_id IN ({allowed_album_ids}) AND se.source_id={q(source)} AND se.parent_id={q(parent)} AND lower(si.suffix)={q(suffix)})"
 pre=cte+f"SELECT {q(bid)} AS batch_id,(SELECT COUNT(*) FROM c) AS expected_masters,{match} AS exact_pending_storage_matches,{match} AS metadata_snapshot_matches,(SELECT COUNT(*) FROM albums WHERE id={q(target)}) AS target_album_rows,{titledup} AS duplicate_title_groups,{trackdup} AS duplicate_disc_track_groups,{other} AS other_album_members,{other_not_allowlisted} AS unallowlisted_other_members,{allowlist_matches} AS allowlisted_other_members;\n"
 (out/'preflight'/f'{bid}.sql').write_text(pre,encoding='utf-8')
 # Group-wide invariant check: active album, exact scoped pending ids, unique titles/tracks, and no target collision.
 ids=','.join(q(x['master_id']) for x in items)
 apply=[]
 snapshots=' OR '.join(f"(id={q(x['master_id'])} AND title IS {q(x['title_snapshot'])} AND disc IS {q(x['disc_snapshot'])} AND track IS {q(x['track_snapshot'])})" for x in items)
 expected_other=len(allowed_other)
 guard=f"{match}={expected} AND NOT EXISTS (SELECT 1 FROM albums WHERE id={q(target)}) AND NOT EXISTS (SELECT 1 FROM song_masters WHERE id IN ({ids}) GROUP BY lower(trim(title)) HAVING COUNT(*)>1) AND NOT EXISTS (SELECT 1 FROM song_masters WHERE id IN ({ids}) AND track IS NOT NULL GROUP BY COALESCE(disc,0),track HAVING COUNT(*)>1) AND {other}={expected_other} AND {other_not_allowlisted}=0 AND {allowlist_matches}={expected_other}"
 apply.append(cte+f"INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'pending-backfill-guard','metadata','{{}}','guard_failed',unixepoch() WHERE NOT ({guard});")
 apply.append(f"INSERT INTO albums (id,name,sort_name,created_at,updated_at) SELECT {q(target)},{q(name)},{q(name.lower())},unixepoch(),unixepoch() WHERE NOT EXISTS (SELECT 1 FROM albums WHERE id={q(target)});")
 apply.append("INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'pending-backfill-guard','metadata','{}','guard_failed',unixepoch() WHERE changes()!=1;")
 for r in items:
  apply.append(f"UPDATE song_masters AS sm SET album_id={q(target)},updated_at=unixepoch() WHERE sm.id={q(r['master_id'])} AND sm.album_id='pending-uploads' AND {exact_exists(r)};")
  apply.append("INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'pending-backfill-guard','metadata','{}','guard_failed',unixepoch() WHERE changes()!=1;")
 apply.append(f"UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE song_masters.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN ('pending-uploads',{q(target)});")
 apply.append(f"INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'pending-backfill-guard','metadata','{{}}','guard_failed',unixepoch() WHERE changes()!=2 OR (SELECT COUNT(*) FROM song_masters WHERE album_id={q(target)})!={expected} OR (SELECT song_count FROM albums WHERE id={q(target)})!={expected} OR (SELECT size FROM albums WHERE id={q(target)})!=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={q(target)});")
 (out/'apply'/f'{bid}.sql').write_text('\n'.join(apply)+'\n',encoding='utf-8')
 # Strict reversibility: only exact candidate masters still in this target are restored. Keep target shell if anything else references it.
 rollback=[]
 rollback_match=match.replace("sm.album_id='pending-uploads'",f"sm.album_id={q(target)}")
 rollback_guard=f"{rollback_match}={expected}"
 rollback.append(cte+f"INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'pending-backfill-guard','metadata','{{}}','guard_failed',unixepoch() WHERE NOT ({rollback_guard});")
 for r in items:
  rollback.append(f"UPDATE song_masters AS sm SET album_id='pending-uploads',updated_at=unixepoch() WHERE sm.id={q(r['master_id'])} AND sm.album_id={q(target)} AND {exact_exists(r)};")
  rollback.append("INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'pending-backfill-guard','metadata','{}','guard_failed',unixepoch() WHERE changes()!=1;")
 rollback.append(f"UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE song_masters.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN ('pending-uploads',{q(target)});")
 rollback.append(f"INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'pending-backfill-guard','metadata','{{}}','guard_failed',unixepoch() WHERE changes()!=2 OR (SELECT COUNT(*) FROM song_masters WHERE id IN ({ids}) AND album_id='pending-uploads')!={expected} OR (SELECT COUNT(*) FROM song_masters WHERE id IN ({ids}) AND album_id={q(target)})!=0;")
 rollback.append(f"DELETE FROM albums WHERE id={q(target)} AND name={q(name)} AND year IS NULL AND genre IS NULL AND cover_r2_key IS NULL AND compilation=0 AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id={q(target)}) AND NOT EXISTS (SELECT 1 FROM album_display_group_members WHERE album_id={q(target)}) AND NOT EXISTS (SELECT 1 FROM annotations WHERE item_type='album' AND item_id={q(target)});")
 (out/'rollback'/f'{bid}.sql').write_text('\n'.join(rollback)+'\n',encoding='utf-8')
 post=(f"SELECT {q(bid)} AS batch_id,(SELECT COUNT(*) FROM song_masters WHERE id IN ({ids}) AND album_id={q(target)}) AS candidate_masters_in_target,(SELECT COUNT(*) FROM song_masters WHERE id IN ({ids}) AND album_id='pending-uploads') AS candidate_masters_still_pending,(SELECT COUNT(*) FROM albums WHERE id={q(target)} AND name={q(name)}) AS target_album_rows,(SELECT song_count FROM albums WHERE id={q(target)}) AS stored_song_count,(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={q(target)}) AS calculated_size;\n")
 (out/'postflight'/f'{bid}.sql').write_text(post,encoding='utf-8')
 rec={'batch_id':bid,'status':'NOT_EXECUTED','source_id':source,'parent_id':parent,'codec':suffix,'album_name':name,'target_album_id':target,'master_count':expected,'expected_other_album_master_ids':list(allowed_other),'master_ids':[x['master_id'] for x in items], 'master_ids_sha256':hashlib.sha256('\n'.join(x['master_id'] for x in items).encode()).hexdigest(),'files':{}}
 for typ in ('preflight','apply','rollback','postflight'):
  p=out/typ/f'{bid}.sql'; rec['files'][typ]={'path':str(p.as_posix()),'sha256':sha(p),'bytes':p.stat().st_size}
 manifest.append(rec); all_groups.append(items)
# Scoped whole-plan postflight: values kept under D1's per-statement size limit.
expected_values=','.join('('+q(g[0]['target_album_id'])+','+str(len(g))+')' for g in all_groups)
cand_values=','.join('('+q(x['master_id'])+','+q(x['target_album_id'])+')' for x in rows)
all_pre=(f"WITH targets(target_id,expected_count) AS (VALUES {expected_values}), candidates(master_id,target_id) AS (VALUES {cand_values})\nSELECT (SELECT COUNT(*) FROM candidates) AS expected_candidate_masters,(SELECT COUNT(*) FROM candidates c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id=c.target_id) AS candidate_masters_moved,(SELECT COUNT(*) FROM candidates c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id='pending-uploads') AS candidate_masters_still_pending,(SELECT COUNT(*) FROM targets t JOIN albums a ON a.id=t.target_id) AS target_album_rows,(SELECT COUNT(*) FROM targets t WHERE (SELECT COUNT(*) FROM song_masters sm WHERE sm.album_id=t.target_id)=t.expected_count) AS targets_at_expected_size,(SELECT COUNT(*) FROM song_masters sm WHERE sm.album_id='pending-uploads') AS live_pending_master_count;\n")
(base/f'postflight_total{label}.sql').write_text(all_pre,encoding='utf-8')
# exact excluded snapshot ids, for count validation without a global pending-count guard
all_ids={x['master_id'] for x in json.loads((base/'cohort.json').read_text(encoding='utf-8'))[0]['results']}
excluded=sorted(all_ids-{x['master_id'] for x in rows})
(base/f'excluded_ids{label}.json').write_text(json.dumps(excluded,ensure_ascii=True,indent=2),encoding='utf-8')
(base/f'postflight_excluded{label}.sql').write_text('SELECT COUNT(*) AS expected_excluded_snapshot_rows, SUM(CASE WHEN sm.album_id=\'pending-uploads\' THEN 1 ELSE 0 END) AS excluded_snapshot_rows_still_pending FROM song_masters sm WHERE sm.id IN ('+','.join(q(x) for x in excluded)+');\n',encoding='utf-8')
# Manifest written after SQL outputs so all file hashes are fixed.
manifest_path=base/f'manifest{label}.json'
(manifest_path).write_text(json.dumps({'task':'513','generated_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),'source':'primary D1 SELECT snapshot; see findings.md for audit time/meta','candidate_map_file':str(candidate_path.as_posix()),'candidate_count':len(rows),'target_album_count':len(groups),'excluded_snapshot_count':len(excluded),'candidate_map_sha256':sha(candidate_path),'postflight_total_sql_sha256':sha(base/f'postflight_total{label}.sql'),'postflight_excluded_sql_sha256':sha(base/f'postflight_excluded{label}.sql'),'groups':manifest},ensure_ascii=True,indent=2),encoding='utf-8')
(base/f'manifest{label}.sha256').write_text(sha(manifest_path)+'  '+manifest_path.name+'\n',encoding='ascii')
print('groups',len(groups),'candidates',len(rows),'excluded',len(excluded),'largest preflight bytes',max(x['files']['preflight']['bytes'] for x in manifest),'largest apply bytes',max(x['files']['apply']['bytes'] for x in manifest),'total bytes',sum(p.stat().st_size for p in out.rglob('*.sql')))
print('manifest sha256',sha(manifest_path),'postflight_total bytes',len(all_pre.encode()))
