import hashlib
import json
from pathlib import Path

base = Path(__file__).parent
scope = json.loads((base / "pcm_verification_scope.json").read_text(encoding="utf-8"))
inventory = {r["master_id"]: r for r in json.loads((base / "version_group_primary_inventory.json").read_text(encoding="utf-8"))["results"]}
metadata = {r["id"]: r for r in json.loads((base / "version_group_master_metadata.json").read_text(encoding="utf-8"))["results"]}
source_albums = {r["id"]: r for r in json.loads((base / "version_group_source_albums_primary.json").read_text(encoding="utf-8"))["results"]}

def q(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"

def guard(condition):
    return "INSERT INTO work_queue (id,task_type,payload,status,created_at) SELECT 'version-group-guard','metadata','{}','guard_failed',unixepoch() WHERE NOT (" + condition + ");"

groups = {
    "freesia": {"target_album_id": "al-version-freesia-wav", "group_id": "ag-version-freesia", "display_name": "Freesia", "existing_album_id": "al-9544935a62"},
    "pages": {"target_album_id": "al-version-pages-wav", "group_id": "ag-version-page-interlude", "display_name": "页间曲", "existing_album_id": "al-7e5eae45c8"},
}
pairs = []
for case in scope["cases"]:
    for pair in case["pairs"]:
        candidate = pair["candidate"]
        source = pair["existing_options"][0]
        pairs.append({
            "case": case["case"], "track_index": pair["track_index_from_path"],
            "candidate_master_id": candidate["master_id"], "source_master_id": source["master_id"],
            "candidate": metadata[candidate["master_id"]], "source": metadata[source["master_id"]],
            "inventory": inventory[candidate["master_id"]], "source_inventory": inventory[source["master_id"]],
        })

page_source_albums = {}
for row in (p for p in pairs if p["case"] == "pages"):
    sid = row["source"]["album_id"]
    page_source_albums.setdefault(sid, []).append(row["source_master_id"])
canonical_page = groups["pages"]["existing_album_id"]
assert len(pairs) == 22 and len(page_source_albums) == 9
assert sorted(r["source"]["track"] for r in pairs if r["case"] == "pages") == list(range(1, 11))
assert len({r["source"]["track"] for r in pairs if r["case"] == "pages"}) == 10

candidate = {"schema": 1, "groups": groups, "pairs": pairs, "page_source_albums": page_source_albums, "canonical_page_album_id": canonical_page, "source_albums": source_albums}
(base / "version_group_candidate.json").write_text(json.dumps(candidate, ensure_ascii=False, indent=2), encoding="utf-8")

wav_ids = [r["candidate_master_id"] for r in pairs]
source_ids = [r["source_master_id"] for r in pairs]
fragment_ids = [a for a in page_source_albums if a != canonical_page]
affected_old_albums = [groups["freesia"]["existing_album_id"], *page_source_albums]
album_snapshot_guard = " AND ".join("EXISTS (SELECT 1 FROM albums WHERE id=%s AND name IS %s AND sort_name IS %s AND year IS %s AND genre IS %s AND cover_r2_key IS %s AND song_count=%s AND duration=%s AND size=%s AND compilation=%s)" % tuple(q(source_albums[a][k]) for k in ['id','name','sort_name','year','genre','cover_r2_key','song_count','duration','size','compilation']) for a in affected_old_albums)

rows = []
for r in pairs:
    i, m = r["inventory"], r["candidate"]
    rows.append("(" + ",".join(q(x) for x in [r["candidate_master_id"], r["source_master_id"], r["case"], i["instance_id"], i["entry_id"], i["storage_object_id"], m["title"], m["track"], m["disc"], r["source"]["track"], i["path"], i["display_name"]]) + ")")
cte = "WITH c(master_id,source_master_id,cohort,instance_id,entry_id,object_id,title_snapshot,track_snapshot,disc_snapshot,source_track_snapshot,path_snapshot,display_name_snapshot) AS (VALUES\n" + ",\n".join(rows) + ")"
file_guard = "(SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id='pending-uploads' AND sm.title IS c.title_snapshot AND sm.track IS c.track_snapshot AND sm.disc IS c.disc_snapshot JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND lower(si.suffix)='wav' AND si.storage_object_id=c.object_id JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id AND se.kind='file' AND se.source_id='r2-local' AND se.object_id=si.storage_object_id AND se.path=c.path_snapshot AND se.display_name=c.display_name_snapshot JOIN storage_objects so ON so.id=c.object_id)=22"
source_guard = "(SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.source_master_id AND sm.track IS c.source_track_snapshot)=22"
album_cardinality = " AND ".join("(SELECT COUNT(*) FROM song_masters WHERE album_id=%s)=%d" % (q(album), len(ids)) for album, ids in page_source_albums.items())
precondition = " AND ".join([
    file_guard, source_guard, album_cardinality,
    album_snapshot_guard,
    "NOT EXISTS (SELECT 1 FROM albums WHERE id IN ('al-version-freesia-wav','al-version-pages-wav'))",
    "NOT EXISTS (SELECT 1 FROM album_display_groups WHERE id IN ('ag-version-freesia','ag-version-page-interlude'))",
    "NOT EXISTS (SELECT 1 FROM album_display_group_members WHERE album_id IN (%s))" % ",".join(q(x) for x in affected_old_albums),
    "NOT EXISTS (SELECT 1 FROM annotations WHERE item_type='album' AND item_id IN (%s))" % ",".join(q(x) for x in fragment_ids),
    "NOT EXISTS (SELECT 1 FROM clone_id_map WHERE item_type='album' AND local_id IN (%s))" % ",".join(q(x) for x in fragment_ids),
    "(SELECT COUNT(*) FROM song_artists sa JOIN c ON c.source_master_id=sa.song_id)=22",
    "NOT EXISTS (SELECT 1 FROM song_artists sa JOIN c ON c.master_id=sa.song_id)",
])

apply = [cte + "\n" + guard(precondition)]
apply += [
    "INSERT INTO albums (id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation,created_at,updated_at) VALUES ('al-version-freesia-wav','Freesia (WAV)','freesia wav',2022,'未知流派',(SELECT cover_r2_key FROM albums WHERE id='al-9544935a62'),0,0,0,0,unixepoch(),unixepoch()),('al-version-pages-wav','页间曲 (WAV)','页间曲 wav',2025,NULL,NULL,0,0,0,0,unixepoch(),unixepoch());",
    guard("changes()=2"),
]
for r in pairs:
    c, s = r["candidate"], r["source"]
    target = groups[r["case"]]["target_album_id"]
    fields = "album_id=%s,artist_id=(SELECT artist_id FROM song_masters WHERE id=%s),album_artist_id=(SELECT album_artist_id FROM song_masters WHERE id=%s),cover_r2_key=(SELECT cover_r2_key FROM song_masters WHERE id=%s),genre=(SELECT genre FROM song_masters WHERE id=%s),participants=(SELECT participants FROM song_masters WHERE id=%s),lyrics=(SELECT lyrics FROM song_masters WHERE id=%s),lyrics_rich=(SELECT lyrics_rich FROM song_masters WHERE id=%s),track=(SELECT track FROM song_masters WHERE id=%s),disc=(SELECT disc FROM song_masters WHERE id=%s),updated_at=unixepoch()" % tuple([q(target)] + [q(r["source_master_id"])] * 9)
    apply += ["UPDATE song_masters SET %s WHERE id=%s AND album_id='pending-uploads' AND title IS %s AND EXISTS (SELECT 1 FROM song_masters s WHERE s.id=%s AND s.album_id=%s AND s.track=%d);" % (fields, q(r["candidate_master_id"]), q(c["title"]), q(r["source_master_id"]), q(s["album_id"]), s["track"]), guard("changes()=1")]
apply += [cte + "\nINSERT INTO song_artists (song_id,artist_id,position) SELECT c.master_id,sa.artist_id,sa.position FROM c JOIN song_artists sa ON sa.song_id=c.source_master_id;", guard("changes()=22")]
for r in (x for x in pairs if x["case"] == "pages" and x["source"]["album_id"] != canonical_page):
    s = r["source"]
    apply += ["UPDATE song_masters SET album_id=%s,updated_at=unixepoch() WHERE id=%s AND album_id=%s AND title IS %s AND track=%d;" % (q(canonical_page), q(r["source_master_id"]), q(s["album_id"]), q(s["title"]), s["track"]), guard("changes()=1")]
apply += ["UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(si.duration),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN ('pending-uploads','al-version-freesia-wav','al-version-pages-wav',%s);" % q(canonical_page), guard("changes()=4")]
for album in fragment_ids:
    apply += ["DELETE FROM albums WHERE id=%s AND name='页间曲' AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id=%s) AND NOT EXISTS (SELECT 1 FROM annotations WHERE item_type='album' AND item_id=%s) AND NOT EXISTS (SELECT 1 FROM album_display_group_members WHERE album_id=%s);" % (q(album), q(album), q(album), q(album)), guard("changes()=1")]
apply += ["INSERT INTO album_display_groups (id,display_name,sort_name,created_at,updated_at) VALUES ('ag-version-freesia','Freesia','freesia',unixepoch(),unixepoch()),('ag-version-page-interlude','页间曲','页间曲',unixepoch(),unixepoch());", guard("changes()=2"), "INSERT INTO album_display_group_members (group_id,album_id,sort_order) VALUES ('ag-version-freesia','al-9544935a62',0),('ag-version-freesia','al-version-freesia-wav',1),('ag-version-page-interlude',%s,0),('ag-version-page-interlude','al-version-pages-wav',1);" % q(canonical_page), guard("changes()=4"), guard("(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='ag-version-freesia')=2 AND (SELECT COUNT(*) FROM album_display_group_members WHERE group_id='ag-version-page-interlude')=2 AND (SELECT duration FROM albums WHERE id='al-version-freesia-wav')=(SELECT COALESCE(SUM(si.duration),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-version-freesia-wav') AND (SELECT duration FROM albums WHERE id='al-version-pages-wav')=(SELECT COALESCE(SUM(si.duration),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-version-pages-wav')")]
(base / "version_group_apply.sql").write_text("\n".join(apply) + "\n", encoding="utf-8")

rollback = [guard("(SELECT COUNT(*) FROM song_masters WHERE id IN (%s) AND album_id IN ('al-version-freesia-wav','al-version-pages-wav'))=22" % ",".join(q(x) for x in wav_ids))]
rollback += [cte + "\nDELETE FROM song_artists WHERE EXISTS (SELECT 1 FROM c JOIN song_artists source_credit ON source_credit.song_id=c.source_master_id WHERE song_artists.song_id=c.master_id AND song_artists.artist_id=source_credit.artist_id AND song_artists.position=source_credit.position);", guard("changes()=22")]
for r in pairs:
    c = r["candidate"]
    values = tuple(q(c[k]) for k in ['artist_id','album_artist_id','cover_r2_key','genre','participants','lyrics','lyrics_rich','track','disc']) + (q(r['candidate_master_id']),q(groups[r['case']]['target_album_id']))
    rollback += ["UPDATE song_masters SET album_id='pending-uploads',artist_id=%s,album_artist_id=%s,cover_r2_key=%s,genre=%s,participants=%s,lyrics=%s,lyrics_rich=%s,track=%s,disc=%s,updated_at=unixepoch() WHERE id=%s AND album_id=%s;" % values, guard("changes()=1")]
for album in fragment_ids:
    a = source_albums[album]
    values = tuple(q(a[k]) for k in ['id','name','sort_name','year','genre','cover_r2_key','song_count','duration','size','compilation']) + (q(album),)
    rollback += ["INSERT INTO albums (id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation,created_at,updated_at) SELECT %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,unixepoch(),unixepoch() WHERE NOT EXISTS (SELECT 1 FROM albums WHERE id=%s);" % values, guard("changes()=1")]
for r in (x for x in pairs if x["case"] == "pages" and x["source"]["album_id"] != canonical_page):
    s = r["source"]
    rollback += ["UPDATE song_masters SET album_id=%s,updated_at=unixepoch() WHERE id=%s AND album_id=%s;" % (q(s['album_id']),q(r['source_master_id']),q(canonical_page)), guard("changes()=1")]
rollback += ["DELETE FROM album_display_group_members WHERE (group_id='ag-version-freesia' AND album_id IN ('al-9544935a62','al-version-freesia-wav')) OR (group_id='ag-version-page-interlude' AND album_id IN (%s,'al-version-pages-wav'));" % q(canonical_page), guard("changes()=4"), "DELETE FROM album_display_groups WHERE id IN ('ag-version-freesia','ag-version-page-interlude') AND NOT EXISTS (SELECT 1 FROM album_display_group_members m WHERE m.group_id=album_display_groups.id);", "DELETE FROM albums WHERE id IN ('al-version-freesia-wav','al-version-pages-wav') AND NOT EXISTS (SELECT 1 FROM song_masters sm WHERE sm.album_id=albums.id) AND NOT EXISTS (SELECT 1 FROM annotations n WHERE n.item_type='album' AND n.item_id=albums.id) AND NOT EXISTS (SELECT 1 FROM album_display_group_members m WHERE m.album_id=albums.id);", "UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(si.duration),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN ('pending-uploads',%s);" % ",".join(q(x) for x in [canonical_page, *fragment_ids]), guard("changes()=10")]
(base / "version_group_rollback.sql").write_text("\n".join(rollback) + "\n", encoding="utf-8")

preflight = "SELECT (SELECT COUNT(*) FROM song_masters WHERE id IN (%s) AND album_id='pending-uploads') AS pending_wav_masters,(SELECT COUNT(*) FROM song_masters WHERE id IN (%s)) AS existing_flac_masters,(SELECT COUNT(*) FROM song_masters WHERE id IN (%s) AND track BETWEEN 1 AND 10) AS page_track_range,(SELECT COUNT(DISTINCT track) FROM song_masters WHERE id IN (%s)) AS page_distinct_tracks,(CASE WHEN %s THEN %d ELSE 0 END) AS source_album_metadata_matches,(SELECT COUNT(*) FROM albums WHERE id IN ('al-version-freesia-wav','al-version-pages-wav')) AS target_album_collisions,(SELECT COUNT(*) FROM album_display_groups WHERE id IN ('ag-version-freesia','ag-version-page-interlude')) AS target_group_collisions,(SELECT COUNT(*) FROM album_display_group_members WHERE album_id IN (%s)) AS existing_group_memberships,(SELECT COUNT(*) FROM annotations WHERE item_type='album' AND item_id IN (%s)) AS fragment_annotations,(SELECT COUNT(*) FROM clone_id_map WHERE item_type='album' AND local_id IN (%s)) AS fragment_clone_mappings,(SELECT COUNT(*) FROM song_artists WHERE song_id IN (%s)) AS wav_artist_credits,(SELECT COUNT(*) FROM song_artists WHERE song_id IN (%s)) AS flac_artist_credits;" % (",".join(q(x) for x in wav_ids), ",".join(q(x) for x in source_ids), ",".join(q(r['source_master_id']) for r in pairs if r['case']=='pages'), ",".join(q(r['source_master_id']) for r in pairs if r['case']=='pages'), album_snapshot_guard, len(affected_old_albums), ",".join(q(x) for x in affected_old_albums), ",".join(q(x) for x in fragment_ids), ",".join(q(x) for x in fragment_ids), ",".join(q(x) for x in wav_ids), ",".join(q(x) for x in source_ids))
(base / "version_group_preflight.sql").write_text(preflight + "\n", encoding="utf-8")
for name in ["version_group_apply.sql", "version_group_rollback.sql", "version_group_preflight.sql", "version_group_candidate.json"]:
    print(name, hashlib.sha256((base / name).read_bytes()).hexdigest())
