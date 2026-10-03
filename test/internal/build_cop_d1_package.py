import argparse
import hashlib
import json
import re
import time
from pathlib import Path

from export_yuesi_readonly_guards import guards as readonly_guards


def load(path):
    return json.loads(Path(path).read_bytes().decode("utf-8"))


def value(item):
    if item is None:
        return "NULL"
    if isinstance(item, bool):
        return "1" if item else "0"
    if isinstance(item, (int, float)):
        return str(item)
    return "'" + str(item).replace("'", "''") + "'"


def ident(name):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name):
        raise ValueError("Invalid SQL identifier")
    return '"' + name + '"'


def rows(capture_dir, stem, name):
    return load(capture_dir / f"{stem}_{name}.json")["rows"]


def exact_guard(name, table, expected, where_sql, columns=None):
    if not expected:
        return "INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT " + ",".join([
            value("guard-cop-v1-" + name), value("metadata"), value("{}"), value("guard_failed"), "unixepoch()"
        ]) + " WHERE EXISTS(SELECT 1 FROM " + ident(table) + " WHERE " + where_sql + ");"
    columns = columns or list(expected[0])
    names = ",".join(ident(column) for column in columns)
    values = ",\n".join("(" + ",".join(value(row.get(column)) for column in columns) + ")" for row in expected)
    cte = "WITH expected_" + name + "(" + names + ") AS (VALUES\n" + values + ")\n"
    changed = (
        f"EXISTS(SELECT {names} FROM {ident(table)} WHERE {where_sql} EXCEPT SELECT {names} FROM expected_{name})\n"
        f"OR EXISTS(SELECT {names} FROM expected_{name} EXCEPT SELECT {names} FROM {ident(table)} WHERE {where_sql})"
    )
    return cte + "INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT " + ",".join([
        value("guard-cop-v1-" + name), value("metadata"), value("{}"), value("guard_failed"), "unixepoch()"
    ]) + "\nWHERE " + changed + ";"


def absent_guard(name, query):
    return "INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT " + ",".join([
        value("guard-cop-v1-" + name), value("metadata"), value("{}"), value("guard_failed"), "unixepoch()"
    ]) + " WHERE EXISTS(" + query + ");"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-dir", required=True, type=Path)
    parser.add_argument("--capture-dir", required=True, type=Path)
    parser.add_argument("--capture-stem", required=True)
    parser.add_argument("--stage-manifest", required=True, type=Path)
    parser.add_argument("--upload-manifest", required=True, type=Path)
    parser.add_argument("--headers", required=True, type=Path)
    parser.add_argument("--referenced-artists-capture", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()
    stage_raw = args.stage_manifest.read_bytes()
    upload_raw = args.upload_manifest.read_bytes()
    headers_raw = args.headers.read_bytes()
    stage = json.loads(stage_raw.decode("utf-8"))
    upload = json.loads(upload_raw.decode("utf-8"))
    headers = json.loads(headers_raw.decode("utf-8"))["items"]
    capture = args.capture_dir
    stem = args.capture_stem
    if not re.fullmatch(r"[a-z0-9_-]+", stem):
        raise SystemExit("Invalid capture stem")
    if hashlib.sha256(stage_raw).hexdigest() != upload.get("source_manifest_sha256"):
        raise SystemExit("Root upload manifest is not bound to the staged native manifest")
    if not upload.get("complete") or len(upload.get("items", [])) != 16 or len(headers) != 16:
        raise SystemExit("Root upload/header receipt is incomplete")

    album_id = stage["album_id"]
    album = rows(capture, stem, "album")
    masters = rows(capture, stem, "masters")
    album_masters = rows(capture, stem, "album_masters")
    instances = rows(capture, stem, "instances")
    entries = rows(capture, stem, "entries")
    old_objects = rows(capture, stem, "old_objects")
    old_instance_refs = rows(capture, stem, "old_object_references")
    old_entry_refs = rows(capture, stem, "old_entry_references")
    credits = rows(capture, stem, "credits")
    artists = rows(capture, stem, "artists")
    referenced_artist_rows = load(args.referenced_artists_capture)["rows"]
    referenced_ids = {row["id"] for row in referenced_artist_rows}
    if referenced_ids != {"ar-0486c50bd5", "unknown-artist"}:
        raise SystemExit("Fresh full-row Various Artists and Unknown Artist guards are missing")
    artists_by_id = {row["id"]: row for row in artists}
    artists_by_id.update({row["id"]: row for row in referenced_artist_rows})
    artists = list(artists_by_id.values())
    history = rows(capture, stem, "history")
    active = rows(capture, stem, "active")
    new_object_namespace = rows(capture, stem, "new_object_namespace")
    new_artist_namespace = rows(capture, stem, "new_artist_namespace")
    cop_artist_namespace = rows(capture, stem, "cop_artist_namespace")
    group_rows = rows(capture, stem, "album_groups")
    group_members = rows(capture, stem, "album_group_members")
    cache = rows(capture, stem, "cache")
    source = rows(capture, stem, "sources")
    triggers = rows(capture, stem, "live_triggers")
    fk = rows(capture, stem, "fk")
    quick = rows(capture, stem, "quick")
    if (len(album) != 1 or album[0]["id"] != album_id or len(masters) != 16 or len(album_masters) != 16
            or len(instances) != 16 or len(entries) != 16 or len(old_objects) != 16
            or len(old_instance_refs) != 16 or len(old_entry_refs) != 16 or credits
            or len(cache) != 1 or len(source) != 1 or len(triggers) != 20 or fk
            or quick != [{"quick_check": "ok"}] or active or group_rows or group_members
            or new_object_namespace or new_artist_namespace or cop_artist_namespace):
        raise SystemExit("Fresh target cohort, shared rows, or namespace checks do not satisfy package scope")
    stage_items = {row["master_id"]: row for row in stage["items"]}
    upload_items = {row["object_id"]: row for row in upload["items"]}
    header_items = {row["object_id"]: row for row in headers}
    instance_by_master = {row["master_id"]: row for row in instances}
    entry_by_instance = {row["instance_id"]: row for row in entries}
    old_object_by_id = {row["id"]: row for row in old_objects}
    artist_name_by_id = {row["id"]: row["name"] for row in artists}
    artist_name_by_id.update({row["id"]: row["name"] for row in stage["new_artist_entities"]})
    for entity in stage["existing_artist_entities"]:
        if artist_name_by_id.get(entity["id"]) != entity["name"]:
            raise SystemExit("Existing performer entity differs from its exact ID/name mapping")

    mapping = []
    all_ids = {row["id"] for row in masters}
    for item in stage["items"]:
        master = next((row for row in masters if row["id"] == item["master_id"]), None)
        instance = instance_by_master.get(item["master_id"])
        entry = entry_by_instance.get(item["instance_id"])
        current_object = old_object_by_id.get(item["old_object_id"])
        upload_item = upload_items.get(item["new_object_id"])
        header = header_items.get(item["new_object_id"])
        if not all((master, instance, entry, current_object, upload_item, header)):
            raise SystemExit(f"Fresh bindings or upload proof missing for {item['master_id']}")
        if (instance["id"] != item["instance_id"] or entry["id"] != item["entry_id"]
                or entry["object_id"] != item["old_object_id"] or instance["storage_object_id"] != item["old_object_id"]
                or master["album_id"] != album_id or current_object["physical_key"] != item["old_physical_key"]):
            raise SystemExit(f"Current primary binding changed for {item['master_id']}")
        if (upload_item["physical_key"] != item["new_physical_key"] or upload_item["size"] != item["size"]
                or upload_item["md5"].lower() != item["md5"].lower() or header["size"] != item["size"]
                or header["etag"].lower() != item["md5"].lower() or header["physical_key"] != item["new_physical_key"]):
            raise SystemExit(f"Provider headers or upload receipt differs for {item['master_id']}")
        for credit in item["artist_credits"]:
            if artist_name_by_id.get(credit["artist_id"]) != credit["artist_name"]:
                raise SystemExit(f"Performer ID/name mismatch for {item['master_id']}")
        mapping.append({"stage": item, "master": master, "instance": instance, "entry": entry,
                        "old_object": current_object, "upload": upload_item, "header": header})
    if len({item["stage"]["new_object_id"] for item in mapping}) != 16 or len(all_ids) != 16:
        raise SystemExit("Duplicate IDs in the current 16-track release mapping")
    mapping.sort(key=lambda item: (item["stage"]["disc"], item["stage"]["track"]))
    album_before = album[0]
    target_ids = [item["master"]["id"] for item in mapping]
    instance_ids = [item["instance"]["id"] for item in mapping]
    old_ids = [item["old_object"]["id"] for item in mapping]
    new_ids = [item["stage"]["new_object_id"] for item in mapping]
    new_keys = [item["stage"]["new_physical_key"] for item in mapping]
    new_artist_entities = stage["new_artist_entities"]
    albumartist_id = stage["albumartist_id"]
    write_epoch = int(time.time())

    expected_masters = []
    expected_instances = []
    expected_entries = []
    expected_objects = []
    expected_credits = []
    for row in mapping:
        item, master, instance, entry, header = row["stage"], row["master"], row["instance"], row["entry"], row["header"]
        master_after = dict(master)
        master_after.update({
            "album_id": album_id, "artist_id": item["primary_artist_id"], "album_artist_id": albumartist_id,
            "title": item["title"], "sort_title": item["title"].casefold(), "track": item["track"],
            "disc": item["disc"], "compilation": 1, "updated_at": write_epoch,
        })
        expected_masters.append(master_after)
        instance_after = dict(instance)
        instance_after.update({
            "storage_object_id": item["new_object_id"], "storage_uri": "r2://" + item["new_physical_key"],
            "source_etag": header["etag"], "source_last_modified": header["last_modified"],
            "size": header["size"], "updated_at": write_epoch,
        })
        expected_instances.append(instance_after)
        entry_after = dict(entry)
        entry_after.update({"object_id": item["new_object_id"], "updated_at": write_epoch})
        expected_entries.append(entry_after)
        expected_objects.append({
            "id": item["new_object_id"], "physical_key": item["new_physical_key"], "legacy_key": None,
            "suffix": item["suffix"], "content_type": item["content_type"], "size": header["size"],
            "etag": header["etag"], "last_modified": header["last_modified"],
            "created_at": write_epoch, "updated_at": write_epoch,
        })
        expected_credits.extend({"song_id": master["id"], "artist_id": credit["artist_id"], "position": credit["position"]}
                                for credit in item["artist_credits"])
    new_size = sum(row["header"]["size"] for row in mapping)
    duration_sum = sum(row["master"]["duration"] or 0 for row in mapping)
    album_after = dict(album_before)
    album_after.update({"name": stage["album_name"], "sort_name": stage["album_name"], "year": None,
                        "song_count": 16, "duration": duration_sum, "size": new_size,
                        "compilation": 1, "updated_at": write_epoch})
    expected_artists = [{"id": row["id"], "name": row["name"], "sort_name": row["sort_name"],
                         "created_at": write_epoch, "updated_at": write_epoch} for row in new_artist_entities]
    cache_after = dict(cache[0])
    cache_after["dirty"] = 1

    target_sql = ",".join(value(row) for row in target_ids)
    instance_sql = ",".join(value(row) for row in instance_ids)
    old_sql = ",".join(value(row) for row in old_ids)
    new_sql = ",".join(value(row) for row in new_ids)
    new_key_sql = ",".join(value(row) for row in new_keys)
    guards = [
        exact_guard("album", "albums", album, "id=" + value(album_id)),
        exact_guard("masters", "song_masters", masters, "id IN (" + target_sql + ")"),
        exact_guard("instances", "song_instances", instances, "id IN (" + instance_sql + ")"),
        exact_guard("entries", "storage_entries", entries, "instance_id IN (" + instance_sql + ")"),
        exact_guard("old_objects", "storage_objects", old_objects, "id IN (" + old_sql + ")"),
        exact_guard("old_instance_refs", "song_instances", old_instance_refs, "storage_object_id IN (" + old_sql + ")"),
        exact_guard("old_entry_refs", "storage_entries", old_entry_refs, "object_id IN (" + old_sql + ")"),
        exact_guard("artists", "artists", artists, "id IN (" + ",".join(value(row["id"]) for row in artists) + ")"),
        exact_guard("history", "work_queue", history, "task_type='metadata' AND id IN (" + ",".join(value(row["id"]) for row in history) + ")"),
        exact_guard("cache", "library_stats_cache", cache, "id=1"),
        exact_guard("source", "storage_sources", source, "id='r2-local'"),
        absent_guard("credits_empty", "SELECT 1 FROM song_artists WHERE song_id IN (" + target_sql + ")"),
        absent_guard("objects_absent", "SELECT 1 FROM storage_objects WHERE id IN (" + new_sql + ") OR physical_key IN (" + new_key_sql + ")"),
        absent_guard("artist_ids_names_absent", "SELECT 1 FROM artists WHERE id IN (" + ",".join(value(row["id"]) for row in new_artist_entities) + ") OR name IN (" + ",".join(value(row["name"]) for row in new_artist_entities) + ")"),
        absent_guard("active_absent", "SELECT 1 FROM work_queue WHERE status IN ('queued','claimed') AND (json_extract(payload,'$.instanceId') IN (" + instance_sql + ") OR json_extract(result_json,'$.instanceId') IN (" + instance_sql + "))"),
        absent_guard("groups_absent", "SELECT 1 FROM album_display_groups WHERE id IN (SELECT group_id FROM album_display_group_members WHERE album_id=" + value(album_id) + ")"),
        absent_guard("group_members_absent", "SELECT 1 FROM album_display_group_members WHERE album_id=" + value(album_id)),
    ]
    mutations = []
    for entity in new_artist_entities:
        mutations.append("INSERT INTO artists(id,name,sort_name,created_at,updated_at) VALUES(" + ",".join([
            value(entity["id"]), value(entity["name"]), value(entity["sort_name"]), str(write_epoch), str(write_epoch)
        ]) + ");")
    for row in mapping:
        item, header = row["stage"], row["header"]
        mutations.append("INSERT INTO storage_objects(id,physical_key,legacy_key,suffix,content_type,size,etag,last_modified,created_at,updated_at) VALUES(" + ",".join([
            value(item["new_object_id"]), value(item["new_physical_key"]), "NULL", value(item["suffix"]), value(item["content_type"]),
            value(header["size"]), value(header["etag"]), value(header["last_modified"]), str(write_epoch), str(write_epoch)
        ]) + ");")
    for row in mapping:
        item, header, inst, entry = row["stage"], row["header"], row["instance"], row["entry"]
        mutations.append("UPDATE song_instances SET storage_object_id=" + value(item["new_object_id"]) + ",storage_uri=" + value("r2://" + item["new_physical_key"]) + ",source_etag=" + value(header["etag"]) + ",source_last_modified=" + value(header["last_modified"]) + ",size=" + value(header["size"]) + ",updated_at=" + str(write_epoch) + " WHERE id=" + value(inst["id"]) + ";")
        mutations.append("UPDATE storage_entries SET object_id=" + value(item["new_object_id"]) + ",updated_at=" + str(write_epoch) + " WHERE id=" + value(entry["id"]) + ";")
    for row in mapping:
        item, master = row["stage"], row["master"]
        mutations.append("UPDATE song_masters SET album_id=" + value(album_id) + ",artist_id=" + value(item["primary_artist_id"]) + ",album_artist_id=" + value(albumartist_id) + ",title=" + value(item["title"]) + ",sort_title=" + value(item["title"].casefold()) + ",track=" + str(item["track"]) + ",disc=" + str(item["disc"]) + ",compilation=1,updated_at=" + str(write_epoch) + " WHERE id=" + value(master["id"]) + ";")
    mutations.append("DELETE FROM song_artists WHERE song_id IN (" + target_sql + ");")
    for row in expected_credits:
        mutations.append("INSERT INTO song_artists(song_id,artist_id,position) VALUES(" + ",".join(value(row[k]) for k in ("song_id", "artist_id", "position")) + ");")
    mutations.append("UPDATE albums SET name=" + value(album_after["name"]) + ",sort_name=" + value(album_after["sort_name"]) + ",year=NULL,song_count=16,duration=" + str(duration_sum) + ",size=" + str(new_size) + ",compilation=1,updated_at=" + str(write_epoch) + " WHERE id=" + value(album_id) + ";")
    post = [
        exact_guard("post_album", "albums", [album_after], "id=" + value(album_id)),
        exact_guard("post_masters", "song_masters", expected_masters, "id IN (" + target_sql + ")"),
        exact_guard("post_instances", "song_instances", expected_instances, "id IN (" + instance_sql + ")"),
        exact_guard("post_entries", "storage_entries", expected_entries, "instance_id IN (" + instance_sql + ")"),
        exact_guard("post_objects", "storage_objects", expected_objects, "id IN (" + new_sql + ")"),
        exact_guard("post_artists", "artists", expected_artists, "id IN (" + ",".join(value(row["id"]) for row in expected_artists) + ")"),
        exact_guard("post_credits", "song_artists", expected_credits, "song_id IN (" + target_sql + ")"),
        exact_guard("post_history", "work_queue", history, "task_type='metadata' AND id IN (" + ",".join(value(row["id"]) for row in history) + ")"),
        exact_guard("post_cache", "library_stats_cache", [cache_after], "id=1"),
        exact_guard("post_existing_artists", "artists", artists, "id IN (" + ",".join(value(row["id"]) for row in artists) + ")"),
        absent_guard("post_old_instance_refs_absent", "SELECT 1 FROM song_instances WHERE storage_object_id IN (" + old_sql + ")"),
        absent_guard("post_old_entry_refs_absent", "SELECT 1 FROM storage_entries WHERE object_id IN (" + old_sql + ")"),
        absent_guard("post_active_absent", "SELECT 1 FROM work_queue WHERE status IN ('queued','claimed') AND (json_extract(payload,'$.instanceId') IN (" + instance_sql + ") OR json_extract(result_json,'$.instanceId') IN (" + instance_sql + "))"),
    ]
    apply_sql = "\n".join(guards + mutations + post) + "\n"

    rollback_guards = [
        exact_guard("rollback_album", "albums", [album_after], "id=" + value(album_id)),
        exact_guard("rollback_masters", "song_masters", expected_masters, "id IN (" + target_sql + ")"),
        exact_guard("rollback_instances", "song_instances", expected_instances, "id IN (" + instance_sql + ")"),
        exact_guard("rollback_entries", "storage_entries", expected_entries, "instance_id IN (" + instance_sql + ")"),
        exact_guard("rollback_objects", "storage_objects", expected_objects, "id IN (" + new_sql + ")"),
        exact_guard("rollback_artists", "artists", expected_artists, "id IN (" + ",".join(value(row["id"]) for row in expected_artists) + ")"),
        exact_guard("rollback_credits", "song_artists", expected_credits, "song_id IN (" + target_sql + ")"),
        exact_guard("rollback_cache", "library_stats_cache", [cache_after], "id=1"),
    ]
    rollback = list(rollback_guards)
    rollback.append("DELETE FROM song_artists WHERE song_id IN (" + target_sql + ");")
    for row in credits:
        rollback.append("INSERT INTO song_artists(song_id,artist_id,position) VALUES(" + ",".join(value(row[k]) for k in ("song_id", "artist_id", "position")) + ");")
    for row in mapping:
        master, instance, entry = row["master"], row["instance"], row["entry"]
        mcols = ["album_id", "artist_id", "album_artist_id", "title", "sort_title", "track", "disc", "compilation", "updated_at"]
        rollback.append("UPDATE song_masters SET " + ",".join(ident(k) + "=" + value(master[k]) for k in mcols) + " WHERE id=" + value(master["id"]) + ";")
        icols = ["storage_object_id", "storage_uri", "source_etag", "source_last_modified", "size", "updated_at"]
        rollback.append("UPDATE song_instances SET " + ",".join(ident(k) + "=" + value(instance[k]) for k in icols) + " WHERE id=" + value(instance["id"]) + ";")
        rollback.append("UPDATE storage_entries SET object_id=" + value(entry["object_id"]) + ",updated_at=" + value(entry["updated_at"]) + " WHERE id=" + value(entry["id"]) + ";")
    album_cols = ["name", "sort_name", "year", "genre", "song_count", "duration", "size", "compilation", "updated_at"]
    rollback.append("UPDATE albums SET " + ",".join(ident(k) + "=" + value(album_before[k]) for k in album_cols) + " WHERE id=" + value(album_id) + ";")
    for row in mapping:
        item, header = row["stage"], row["header"]
        rollback.append("DELETE FROM storage_objects WHERE id=" + value(item["new_object_id"]) + " AND physical_key=" + value(item["new_physical_key"]) + " AND etag=" + value(header["etag"]) + " AND size=" + value(header["size"]) + " AND NOT EXISTS(SELECT 1 FROM song_instances WHERE storage_object_id=" + value(item["new_object_id"]) + ") AND NOT EXISTS(SELECT 1 FROM storage_entries WHERE object_id=" + value(item["new_object_id"]) + ");")
    for entity in new_artist_entities:
        rollback.append("DELETE FROM artists WHERE id=" + value(entity["id"]) + " AND name=" + value(entity["name"]) + " AND sort_name=" + value(entity["sort_name"]) + " AND NOT EXISTS(SELECT 1 FROM song_masters WHERE artist_id=" + value(entity["id"]) + " OR album_artist_id=" + value(entity["id"]) + ") AND NOT EXISTS(SELECT 1 FROM song_artists WHERE artist_id=" + value(entity["id"]) + ");")
    rollback.append("UPDATE library_stats_cache SET artists=" + str(cache[0]["artists"]) + ",albums=" + str(cache[0]["albums"]) + ",songs=" + str(cache[0]["songs"]) + ",updated_at=" + str(cache[0]["updated_at"]) + ",dirty=" + str(cache[0]["dirty"]) + " WHERE id=1 AND dirty=1;")
    rollback_sql = "\n".join(rollback) + "\n"

    args.out_dir.mkdir(parents=True, exist_ok=True)
    apply_path, rollback_path = args.out_dir / "apply.sql", args.out_dir / "rollback.sql"
    apply_path.write_bytes(apply_sql.encode("utf-8"))
    rollback_path.write_bytes(rollback_sql.encode("utf-8"))
    capture_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in sorted(capture.glob(f"{stem}_*.json"))}
    capture_hashes[args.referenced_artists_capture.name] = hashlib.sha256(args.referenced_artists_capture.read_bytes()).hexdigest()
    manifest = {
        "status": "DRAFT_NOT_FOR_PRODUCTION", "production_writes": 0,
        "album_id": album_id, "album_name": stage["album_name"], "track_count": 16,
        "master_ids": target_ids, "artist_insert_count": len(new_artist_entities),
        "new_song_artist_rows": len(expected_credits), "new_object_count": len(expected_objects),
        "sum_size": new_size, "sum_duration": duration_sum, "write_epoch": write_epoch,
        "primary_capture_stem": stem,
        "primary_capture_files_sha256": capture_hashes,
        "stage_manifest_sha256": hashlib.sha256(stage_raw).hexdigest(),
        "root_upload_manifest_sha256": hashlib.sha256(upload_raw).hexdigest(),
        "root_headers_sha256": hashlib.sha256(headers_raw).hexdigest(),
        "apply_sha256": hashlib.sha256(apply_path.read_bytes()).hexdigest(),
        "rollback_sha256": hashlib.sha256(rollback_path.read_bytes()).hexdigest(),
        "apply_bytes": apply_path.stat().st_size, "rollback_bytes": rollback_path.stat().st_size,
    }
    (args.out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    guards_export = {
        "apply_sha256": manifest["apply_sha256"], "rollback_sha256": manifest["rollback_sha256"],
        "primary_capture_stem": stem, "primary_capture_file_sha256": capture_hashes,
        "preimage": {"album": album, "masters": masters, "instances": instances, "entries": entries,
                     "old_objects": old_objects, "old_instance_refs": old_instance_refs,
                     "old_entry_refs": old_entry_refs, "artists": artists, "credits": credits,
                     "history": history, "active": active, "cache": cache, "sources": source,
                     "cop_artist_namespace": cop_artist_namespace, "new_object_namespace": new_object_namespace,
                     "new_artist_namespace": new_artist_namespace, "album_groups": group_rows,
                     "album_group_members": group_members, "fk": fk, "quick": quick, "live_triggers": triggers},
        "expected_afterimage": {"album": [album_after], "masters": expected_masters,
                                "instances": expected_instances, "entries": expected_entries,
                                "new_objects": expected_objects, "new_artist": expected_artists,
                                "credits": expected_credits, "cache": [cache_after]},
    }
    (args.out_dir / "guard_exports.json").write_text(json.dumps(guards_export, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    readonly = {"apply_sha256": manifest["apply_sha256"], "rollback_sha256": manifest["rollback_sha256"],
                "queries": readonly_guards(apply_path.read_bytes(), "apply", "guard-cop-")
                           + readonly_guards(rollback_path.read_bytes(), "rollback", "guard-cop-")}
    (args.out_dir / "readonly_guard_queries.json").write_text(json.dumps(readonly, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
