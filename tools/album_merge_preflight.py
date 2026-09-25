#!/usr/bin/env python3
"""Build a read-only local preflight manifest for WAV/FLAC merge candidates."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


class PreflightError(Exception):
    pass


def sha256_file(path: Path, cache: dict[str, Any] | None = None) -> str:
    cache_key = str(path.resolve())
    stat = path.stat()
    if cache is not None:
        cached = cache.get(cache_key)
        if cached and cached[0] == stat.st_size and cached[1] == stat.st_mtime_ns:
            return cached[2]
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    result = digest.hexdigest()
    if cache is not None:
        cache[cache_key] = (stat.st_size, stat.st_mtime_ns, result)
    return result


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PreflightError(f"cannot read JSON file {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise PreflightError(f"JSON root must be an object: {path}")
    return value


def open_snapshot(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise PreflightError(f"SQLite snapshot does not exist: {path}")
    uri = path.resolve().as_uri() + "?mode=ro"
    try:
        db = sqlite3.connect(uri, uri=True)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        result = db.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            db.close()
            raise PreflightError(f"SQLite integrity_check failed: {result}")
        return db
    except sqlite3.Error as exc:
        raise PreflightError(f"cannot open SQLite snapshot read-only: {exc}") from exc


def table_names(db: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        if not row[0].startswith("sqlite_")
    }


def table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({quote_identifier(table)})")}


def rows_where(db: sqlite3.Connection, table: str, column: str, values: set[str]) -> list[dict[str, Any]]:
    if not values:
        return []
    columns = table_columns(db, table)
    if column not in columns:
        return []
    ordered = sorted(values)
    marks = ",".join("?" for _ in ordered)
    sql = f"SELECT * FROM {quote_identifier(table)} WHERE {quote_identifier(column)} IN ({marks})"
    return [dict(row) for row in db.execute(sql, ordered)]


def one_by(db: sqlite3.Connection, table: str, column: str, value: str) -> dict[str, Any] | None:
    rows = rows_where(db, table, column, {value})
    return rows[0] if rows else None


def lookup_object(db: sqlite3.Connection, physical_key: str) -> dict[str, Any]:
    rows = rows_where(db, "storage_objects", "physical_key", {physical_key})
    if len(rows) != 1:
        raise PreflightError(f"physical_key must resolve to one storage_objects row: {physical_key}")
    return rows[0]


def validate_cache(db: sqlite3.Connection, descriptor: dict[str, Any], label: str, hash_cache: dict[str, Any] | None = None) -> dict[str, Any]:
    path = Path(str(descriptor.get("path", ""))).expanduser().resolve()
    physical_key = descriptor.get("physical_key")
    expected_hash = descriptor.get("sha256")
    if not isinstance(expected_hash, str) or len(expected_hash) != 64:
        raise PreflightError(f"{label}.sha256 must be the expected 64-character cache SHA-256")
    if not path.is_file():
        raise PreflightError(f"{label} cache file does not exist: {path}")
    actual_hash = sha256_file(path, hash_cache)
    actual_size = path.stat().st_size
    if physical_key:
        obj = lookup_object(db, str(physical_key))
        expected_size = int(obj.get("size") or 0)
        etag = obj.get("etag")
        size_matches: bool | None = actual_size == expected_size
        object_id_matches = not descriptor.get("object_id") or str(descriptor["object_id"]) == str(obj["id"])
        manifest_size_matches = descriptor.get("size") is None or int(descriptor["size"]) == expected_size
    else:
        obj = None
        expected_size = None
        etag = None
        size_matches = None
        object_id_matches = descriptor.get("object_id") is None
        manifest_size_matches = True
    return {
        "local_path": str(path),
        "physical_key": physical_key,
        "expected_sha256": expected_hash.lower(),
        "actual_sha256": actual_hash,
        "sha256_matches": actual_hash.lower() == expected_hash.lower(),
        "local_size": actual_size,
        "d1_object_size": expected_size,
        "size_matches": size_matches,
        "d1_backed_cache": bool(physical_key),
        "d1_etag_recorded": etag,
        "etag_used_as_sha256": False,
        "manifest_object_id": descriptor.get("object_id"),
        "manifest_object_id_matches_snapshot": object_id_matches,
        "manifest_size": descriptor.get("size"),
        "manifest_size_matches_snapshot": manifest_size_matches,
        "object": obj,
    }


def probe_stream(path: Path, ffprobe: str) -> dict[str, int]:
    command = [
        ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=sample_rate,channels,bits_per_sample,bits_per_raw_sample", "-of", "json", str(path),
    ]
    proc = subprocess.run(command, capture_output=True, check=False)
    if proc.returncode:
        raise PreflightError(f"ffprobe failed for {path}: {proc.stderr.decode('utf-8', 'replace')[-1000:]}")
    try:
        streams = json.loads(proc.stdout.decode("utf-8"))["streams"]
        if not streams:
            raise ValueError("no audio stream")
        bits = streams[0].get("bits_per_raw_sample") or streams[0].get("bits_per_sample") or 0
        return {"sample_rate": int(streams[0]["sample_rate"]), "channels": int(streams[0]["channels"]), "bits_per_sample": int(bits)}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PreflightError(f"ffprobe did not return a usable audio stream for {path}: {exc}") from exc


def pcm_signature(path: Path, ffmpeg: str, ffprobe: str, stream: dict[str, int], sample_format: str = "s32le") -> dict[str, Any]:
    sample_bytes = {"s16le": 2, "s32le": 4}.get(sample_format)
    if sample_bytes is None:
        raise PreflightError(f"unsupported PCM sample format: {sample_format}")
    command = [
        ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-map", "0:a:0", "-f", sample_format,
        "-acodec", f"pcm_{sample_format}", "-ar", str(stream["sample_rate"]), "-ac", str(stream["channels"]), "pipe:1",
    ]
    with tempfile.TemporaryFile() as error_output:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=error_output)
        assert proc.stdout is not None
        digest = hashlib.sha256()
        size = 0
        while chunk := proc.stdout.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
        return_code = proc.wait()
        error_output.seek(0)
        error = error_output.read().decode("utf-8", "replace")[-1000:]
    if return_code:
        raise PreflightError(f"ffmpeg decode failed for {path}: {error}")
    sample_width = sample_bytes * stream["channels"]
    if not size or size % sample_width:
        raise PreflightError(f"decoded PCM is empty or has an incomplete sample frame: {path}")
    return {
        "sample_rate": stream["sample_rate"],
        "channels": stream["channels"],
        "frames": size // sample_width,
        "bytes": size,
        "sha256": digest.hexdigest(),
        "normalization": f"ffmpeg pcm_{sample_format} at native sample rate and channel count",
    }


def collect_instances(db: sqlite3.Connection, obj: dict[str, Any]) -> list[dict[str, Any]]:
    result = rows_where(db, "song_instances", "storage_object_id", {str(obj["id"])})
    if "storage_uri" in table_columns(db, "song_instances"):
        result += rows_where(db, "song_instances", "storage_uri", {f"r2://{obj['physical_key']}"})
    unique = {str(row["id"]): row for row in result}
    return [unique[key] for key in sorted(unique)]


def collect_entries(db: sqlite3.Connection, object_ids: set[str], instance_ids: set[str]) -> list[dict[str, Any]]:
    entries = rows_where(db, "storage_entries", "object_id", object_ids)
    entries += rows_where(db, "storage_entries", "instance_id", instance_ids)
    unique = {str(row["id"]): row for row in entries}
    return [unique[key] for key in sorted(unique)]


def collect_object_instances_and_entries(
    db: sqlite3.Connection, initial_objects: list[dict[str, Any]], initial_instances: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    object_rows = {str(row["id"]): row for row in initial_objects}
    instance_rows = {str(row["id"]): row for row in initial_instances}
    master_ids = {str(row["master_id"]) for row in instance_rows.values() if row.get("master_id")}
    if master_ids:
        for row in rows_where(db, "song_instances", "master_id", master_ids):
            instance_rows[str(row["id"])] = row
    linked_object_ids = {
        str(row["storage_object_id"])
        for row in instance_rows.values()
        if row.get("storage_object_id")
    }
    if linked_object_ids:
        for row in rows_where(db, "storage_objects", "id", linked_object_ids):
            object_rows[str(row["id"])] = row
    entries = collect_entries(db, set(object_rows), set(instance_rows))
    entry_rows = {str(row["id"]): row for row in entries}
    while True:
        children = rows_where(db, "storage_entries", "companion_of", set(entry_rows))
        new_children = {str(row["id"]): row for row in children if str(row["id"]) not in entry_rows}
        if not new_children:
            break
        entry_rows.update(new_children)
    return list(object_rows.values()), list(instance_rows.values()), list(entry_rows.values())


def find_payload_matches(value: Any, needles: set[str], path: str = "$ ") -> list[dict[str, str]]:
    matches: list[dict[str, str]] = []
    if isinstance(value, str) and value in needles:
        matches.append({"json_path": path.strip(), "identifier": value})
    elif isinstance(value, dict):
        for key, item in value.items():
            matches.extend(find_payload_matches(item, needles, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            matches.extend(find_payload_matches(item, needles, f"{path}[{index}]"))
    return matches


def collect_queue_rows(db: sqlite3.Connection, identifiers: set[str]) -> list[dict[str, Any]]:
    if "work_queue" not in table_names(db):
        return []
    rows = [dict(row) for row in db.execute("SELECT * FROM work_queue")]
    matches = []
    for row in rows:
        for column in ("payload", "result_json"):
            text = row.get(column)
            if not text:
                continue
            try:
                payload = json.loads(text)
            except (TypeError, json.JSONDecodeError):
                found = [needle for needle in identifiers if needle and needle in str(text)]
                if found:
                    matches.append({
                        key: row.get(key) for key in ("id", "task_type", "status", "priority", "attempts", "created_at", "expires_at")
                        if key in row
                    } | {"matched_unparsed_payload": True, "matched_identifiers": sorted(found), "matched_payload_column": column})
                    break
            else:
                found = find_payload_matches(payload, identifiers)
                if found:
                    matches.append({
                        key: row.get(key) for key in ("id", "task_type", "status", "priority", "attempts", "created_at", "expires_at")
                        if key in row
                    } | {"matched_payload_column": column, "payload_references": found})
                    break
    return matches


def collect_fk_associations(db: sqlite3.Connection, identifiers_by_table: dict[str, set[str]]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for source in sorted(table_names(db)):
        for fk in db.execute(f"PRAGMA foreign_key_list({quote_identifier(source)})"):
            target, source_col, target_col = str(fk[2]), str(fk[3]), str(fk[4]) or "id"
            target_ids = identifiers_by_table.get(target, set())
            if target_ids:
                rows = rows_where(db, source, source_col, target_ids)
                if rows:
                    refs.append({"table": source, "foreign_key_to": target, "column": source_col, "rows": rows})
    return refs


def collect_impacted_associations(
    db: sqlite3.Connection,
    object_rows: list[dict[str, Any]],
    instance_rows: list[dict[str, Any]],
    entry_rows: list[dict[str, Any]],
    master_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    object_ids = {str(row["id"]) for row in object_rows}
    instance_ids = {str(row["id"]) for row in instance_rows}
    entry_ids = {str(row["id"]) for row in entry_rows}
    master_ids = {str(row["id"]) for row in master_rows}
    ids_by_table = {
        "storage_objects": object_ids,
        "song_instances": instance_ids,
        "storage_entries": entry_ids,
        "song_masters": master_ids,
    }
    annotations = []
    if "annotations" in table_names(db) and master_ids:
        annotations = rows_where(db, "annotations", "item_id", master_ids)
        annotations = [row for row in annotations if row.get("item_type") == "song"]
    play_queues = []
    if "play_queues" in table_names(db):
        for row in db.execute("SELECT * FROM play_queues"):
            item = dict(row)
            try:
                song_ids = json.loads(item.get("song_ids") or "[]")
            except (TypeError, json.JSONDecodeError):
                song_ids = []
            if (isinstance(song_ids, list) and any(str(value) in master_ids for value in song_ids)) or item.get("current_id") in master_ids:
                item["matched_song_ids"] = [value for value in song_ids if str(value) in master_ids] if isinstance(song_ids, list) else []
                play_queues.append({
                    "user_id": item.get("user_id"),
                    "matched_song_ids": [value for value in song_ids if str(value) in master_ids] if isinstance(song_ids, list) else [],
                    "current_id": item.get("current_id") if item.get("current_id") in master_ids else None,
                    "position_ms": item.get("position_ms"),
                    "changed_by": item.get("changed_by"),
                    "updated_at": item.get("updated_at"),
                })
    return {
        "foreign_key_associations": collect_fk_associations(db, ids_by_table),
        "annotations_song_rows": annotations,
        "play_queues": play_queues,
        "work_queue_rows": collect_queue_rows(
            db,
            object_ids | instance_ids | entry_ids | master_ids
            | {str(row.get("physical_key")) for row in object_rows if row.get("physical_key")}
            | {f"r2://{row.get('physical_key')}" for row in object_rows if row.get("physical_key")},
        ),
    }


def preflight_pair(
    db: sqlite3.Connection,
    pair: dict[str, Any],
    ffmpeg: str,
    ffprobe: str,
    cache: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cache = cache if cache is not None else {}
    cache.setdefault("hashes", {})
    cache.setdefault("streams", {})
    cache.setdefault("pcm", {})
    label = str(pair.get("label") or "candidate")
    wav = validate_cache(db, pair.get("wav_cache", {}), f"{label}.wav_cache", cache["hashes"])
    wav_reference_descriptor = pair.get("wav_reference_cache")
    wav_reference = (
        validate_cache(db, wav_reference_descriptor, f"{label}.wav_reference_cache", cache["hashes"])
        if wav_reference_descriptor else wav
    )
    flac = validate_cache(db, pair.get("flac_cache", {}), f"{label}.flac_cache", cache["hashes"])
    merged_path = Path(str(pair.get("merged_wav", ""))).expanduser().resolve()
    report_path = Path(str(pair.get("tag_merge_report", ""))).expanduser().resolve()
    if not merged_path.is_file() or not report_path.is_file():
        raise PreflightError(f"{label}: merged_wav and tag_merge_report must be existing local files")
    report = read_json(report_path)
    wav_hash = wav["actual_sha256"]
    flac_hash = flac["actual_sha256"]
    merged_hash = sha256_file(merged_path, cache["hashes"])
    report_inputs = report.get("inputs", {})
    report_output = report.get("output", {})
    report_verification = report.get("verification", {})
    report_retention = report.get("flac_retention", {})
    report_source_hashes_match = (
        report_inputs.get("wav", {}).get("sha256", "").lower() == wav_hash
        and report_inputs.get("flac", {}).get("sha256", "").lower() == flac_hash
    )
    report_merged_hash_matches = report_output.get("sha256", "").lower() == merged_hash
    report_output_path_matches = bool(report_output.get("path")) and Path(str(report_output["path"])).expanduser().resolve() == merged_path
    report_output_size_matches = report_output.get("size") == merged_path.stat().st_size
    conflicts = dict(report.get("conflicts") or {})
    conflicts.update(report.get("custom_comment_conflicts") or {})
    resolutions = report.get("resolutions") or {}
    unresolved = sorted(str(key) for key in conflicts if key not in resolutions)

    def cached_stream(path: Path) -> dict[str, int]:
        key = str(path.resolve())
        if key not in cache["streams"]:
            cache["streams"][key] = probe_stream(path, ffprobe)
        return cache["streams"][key]

    def cached_pcm(path: Path, stream: dict[str, int]) -> dict[str, Any]:
        key = str(path.resolve())
        if key not in cache["pcm"]:
            cache["pcm"][key] = pcm_signature(path, ffmpeg, ffprobe, stream)
        return cache["pcm"][key]

    wav_stream = cached_stream(Path(wav["local_path"]))
    flac_stream = cached_stream(Path(flac["local_path"]))
    output_stream = cached_stream(merged_path)
    streams_match = wav_stream == flac_stream == output_stream
    pcm = {
        "wav_cache": cached_pcm(Path(wav["local_path"]), wav_stream),
        "flac_cache": cached_pcm(Path(flac["local_path"]), flac_stream),
        "merged_wav": cached_pcm(merged_path, output_stream),
    }
    pcm_exact = streams_match and len({item["sha256"] for item in pcm.values()}) == 1

    wav_obj = wav_reference["object"]
    flac_obj = flac["object"]
    if wav_obj is None:
        raise PreflightError(f"{label}: intermediate WAV must reference its original WAV cache separately")
    wav_instances = collect_instances(db, wav_obj)
    flac_instances = collect_instances(db, flac_obj)
    object_list, instance_list, entries = collect_object_instances_and_entries(db, [wav_obj, flac_obj], wav_instances + flac_instances)
    instances = {str(row["id"]): row for row in instance_list}
    object_rows = {str(row["id"]): row for row in object_list}
    master_ids = {str(row["master_id"]) for row in instances.values() if row.get("master_id")}
    masters = rows_where(db, "song_masters", "id", master_ids) if "song_masters" in table_names(db) else []
    same_object = wav_obj["id"] == flac_obj["id"]
    shared_objects = []
    for obj in object_rows.values():
        linked_entries = rows_where(db, "storage_entries", "object_id", {str(obj["id"])})
        linked_instances = rows_where(db, "song_instances", "storage_object_id", {str(obj["id"])})
        shared_objects.append({
            "object": obj,
            "entry_reference_count": len(linked_entries),
            "entry_references": linked_entries,
            "instance_reference_count": len(linked_instances),
            "instance_references": linked_instances,
            "shared": len(linked_entries) > 1 or len(linked_instances) > 1,
        })
    associations = collect_impacted_associations(db, list(object_rows.values()), list(instances.values()), entries, masters)
    context = pair.get("candidate_context") or {}
    expected_pcm_hash = context.get("expected_pcm_sha256")
    expected_pcm_check = True
    pcm_s16 = None
    if expected_pcm_hash:
        pcm_s16 = pcm_signature(merged_path, ffmpeg, ffprobe, output_stream, sample_format="s16le")
        expected_pcm_check = pcm_s16["sha256"].lower() == str(expected_pcm_hash).lower()
    expected_references = context.get("expected_references") or {}
    expected_wav = expected_references.get("wav") or {}
    expected_flac = expected_references.get("flac") or {}
    parent_report_path = context.get("intermediate_source_report")
    parent_report_matches = True
    if parent_report_path:
        parent_report = read_json(Path(parent_report_path))
        parent_output = parent_report.get("output", {})
        parent_report_matches = (
            bool(parent_output.get("path"))
            and Path(str(parent_output["path"])).expanduser().resolve() == Path(wav["local_path"])
            and str(parent_output.get("sha256", "")).lower() == wav["actual_sha256"]
            and parent_output.get("size") == wav["local_size"]
            and parent_output.get("written") is True
            and parent_report.get("verification", {}).get("passed") is True
        )
    entry_ids = {str(row["id"]) for row in entries}
    wav_instance_map = {str(row["id"]): row for row in wav_instances}
    flac_instance_map = {str(row["id"]): row for row in flac_instances}
    expected_refs_match = True
    for expected, instance_map in ((expected_wav, wav_instance_map), (expected_flac, flac_instance_map)):
        instance_id = expected.get("instance_id")
        entry_id = expected.get("entry_id")
        master_id = expected.get("master_id")
        if instance_id and str(instance_id) not in instance_map:
            expected_refs_match = False
        elif instance_id and master_id and str(instance_map[str(instance_id)].get("master_id")) != str(master_id):
            expected_refs_match = False
        if entry_id and str(entry_id) not in entry_ids:
            expected_refs_match = False
    upload_record = context.get("upload_status_record")
    new_key = context.get("expected_new_physical_key")
    new_key_rows = rows_where(db, "storage_objects", "physical_key", {str(new_key)}) if new_key else []
    upload_record_matches = True
    if upload_record and upload_record.get("status_available"):
        upload_record_matches = (
            upload_record.get("readback_matches_tagged_output") is True
            and upload_record.get("new_physical_key_matches_manifest") is True
        )

    checks = {
        "wav_cache_sha_matches_expected": wav["sha256_matches"],
        "flac_cache_sha_matches_expected": flac["sha256_matches"],
        "wav_cache_size_matches_d1": wav["size_matches"] if wav["d1_backed_cache"] else True,
        "wav_intermediate_matches_parent_report": parent_report_matches,
        "wav_reference_cache_sha_matches_report": wav_reference["sha256_matches"],
        "wav_reference_cache_size_matches_d1": wav_reference["size_matches"],
        "flac_cache_size_matches_d1": flac["size_matches"],
        "wav_cache_object_matches_manifest": (wav["manifest_object_id_matches_snapshot"] and wav["manifest_size_matches_snapshot"]) if wav["d1_backed_cache"] else True,
        "wav_reference_object_matches_manifest": wav_reference["manifest_object_id_matches_snapshot"] and wav_reference["manifest_size_matches_snapshot"],
        "flac_cache_object_matches_manifest": flac["manifest_object_id_matches_snapshot"] and flac["manifest_size_matches_snapshot"],
        "manifest_d1_references_match_snapshot": expected_refs_match,
        "reported_upload_record_consistent": upload_record_matches,
        "tag_report_source_hashes_match_caches": report_source_hashes_match,
        "tag_report_output_hash_matches_file": report_merged_hash_matches,
        "tag_report_output_path_matches_file": report_output_path_matches,
        "tag_report_output_size_matches_file": report_output_size_matches,
        "tag_report_output_written": report_output.get("written") is True,
        "tag_report_verification_passed": report_verification.get("passed") is True,
        "tag_report_pcm_data_guard_passed": report_verification.get("pcm_data_chunks_unchanged") is True,
        "tag_report_non_id3_chunk_guard_passed": report_verification.get("non_id3_riff_chunks_unchanged") is True,
        "tag_report_picture_verification_passed": report_verification.get("pictures") is True,
        "tag_report_format_parameters_match": report.get("audio_format_comparison", {}).get("matches") is True,
        "tag_report_metadata_preserved": report_retention.get("metadata_preserved") is True,
        "tag_report_has_no_unpreserved_flac_metadata": not report.get("unpreserved_flac_blocks"),
        "tag_report_has_no_unpreserved_pictures": not report.get("unpreserved_pictures"),
        "tag_report_unmapped_fields_mirrored": report.get("unmapped_fields", []) == report.get("unmapped_fields_preserved_as_txxx", []),
        "tag_conflicts_resolved": not unresolved,
        "audio_stream_parameters_match": streams_match,
        "wav_flac_and_merged_pcm_match": pcm_exact,
        "tag_manifest_pcm_hash_matches": expected_pcm_check,
        "wav_and_flac_map_to_distinct_r2_objects": not same_object,
        "wav_object_has_song_instance": bool(wav_instances),
        "flac_object_has_song_instance": bool(flac_instances),
    }
    blockers = [name for name, passed in checks.items() if not passed]
    return {
        "label": label,
        "status": "ready_for_manual_review" if not blockers else "blocked",
        "checks": checks,
        "blockers": blockers,
        "unresolved_tag_conflicts": unresolved,
        "cache_files": {"wav_input": wav, "wav_reference": wav_reference, "flac": flac},
        "merged_wav": {"local_path": str(merged_path), "size": merged_path.stat().st_size, "sha256": merged_hash},
        "tag_merge_report": {"local_path": str(report_path), "report": report},
        "pcm_comparison": {"exact": pcm_exact, "streams_match": streams_match, "files": pcm, "expected_pcm_evidence": pcm_s16},
        "d1_references": {
            "storage_objects": list(object_rows.values()),
            "song_instances": list(instances.values()),
            "storage_entries": entries,
            "song_masters": masters,
            "shared_object_analysis": shared_objects,
            "same_master_ids_between_wav_and_flac": sorted(
                {str(row["master_id"]) for row in wav_instances} & {str(row["master_id"]) for row in flac_instances}
            ),
            "impacted_associations": associations,
        },
        "candidate_context": context,
        "new_object_snapshot_state": {
            "physical_key": new_key,
            "present_in_snapshot": bool(new_key_rows),
            "rows": new_key_rows,
            "note": "Local snapshot observation only; no live R2 or D1 query was made.",
        } if new_key else None,
        "preflight_is_not_deletion_or_upload_authorization": True,
    }


def normalize_candidate_manifest(
    payload: dict[str, Any], manifest_path: Path, status_path: Path | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    pairs = payload.get("pairs")
    if isinstance(pairs, list):
        return pairs, {"format": "preflight_pairs_v1"}
    items = payload.get("items")
    if not isinstance(items, list):
        raise PreflightError("candidate JSON must contain either a 'pairs' array or exact WAV upload manifest 'items'")
    status: dict[str, Any] = {}
    if status_path:
        loaded = read_json(status_path)
        status = loaded
    normalized: list[dict[str, Any]] = []
    for item in items:
        name = str(item.get("name") or "candidate")
        flacs = item.get("exact_flacs") or []
        reports = item.get("tag_reports") or []
        if len(flacs) != len(reports):
            raise PreflightError(f"{name}: exact_flacs and tag_reports must have a one-to-one mapping")
        original = item.get("original_wav") or {}
        upload_state = status.get(name)
        records: list[tuple[dict[str, Any], dict[str, Any], Path]] = []
        for report_ref in reports:
            report_path = Path(str(report_ref.get("report_path") or "")).expanduser().resolve()
            report = read_json(report_path)
            records.append((report_ref, report, report_path))
        base_record = None
        for report_ref, report, report_path in records:
            input_wav = report.get("inputs", {}).get("wav", {})
            input_path = Path(str(input_wav.get("path") or "")).expanduser().resolve()
            if input_path.is_file() and (original.get("size") is None or input_path.stat().st_size == int(original["size"])):
                base_record = (input_wav, input_path, report_path)
                break
        if not base_record:
            raise PreflightError(f"{name}: cannot find a report input WAV matching the original D1 size")
        base_wav_input, base_wav_path, base_report_path = base_record
        selected_report_found = False
        for index, (flac, record) in enumerate(zip(flacs, records, strict=True), start=1):
            report_ref, report, report_path = record
            wav_input = report.get("inputs", {}).get("wav", {})
            flac_input = report.get("inputs", {}).get("flac", {})
            output = report.get("output", {})
            if report_ref.get("tagged_sha256") and str(report_ref["tagged_sha256"]).lower() != str(output.get("sha256", "")).lower():
                raise PreflightError(f"{name}: tag report digest disagrees with upload manifest")
            merged_path = Path(str(output.get("path") or "")).expanduser().resolve()
            selected_output = (
                bool(item.get("output_path"))
                and Path(str(item["output_path"])).expanduser().resolve() == merged_path
                and str(item.get("output_sha256", "")).lower() == str(output.get("sha256", "")).lower()
            )
            selected_report_found = selected_report_found or selected_output
            report_wav_path = Path(str(wav_input.get("path") or "")).expanduser().resolve()
            input_is_base_cache = report_wav_path == base_wav_path
            parent_report_path = None
            if not input_is_base_cache:
                for _, possible_parent, possible_parent_path in records:
                    parent_output = possible_parent.get("output", {})
                    if (
                        parent_output.get("path")
                        and Path(str(parent_output["path"])).expanduser().resolve() == report_wav_path
                        and str(parent_output.get("sha256", "")).lower() == str(wav_input.get("sha256", "")).lower()
                    ):
                        parent_report_path = possible_parent_path
                        break
                if not parent_report_path:
                    raise PreflightError(f"{name}: intermediate WAV input has no matching parent tag report")
            if input_is_base_cache:
                wav_cache = {
                    "path": str(report_wav_path),
                    "physical_key": original.get("physical_key"),
                    "sha256": wav_input.get("sha256"),
                    "object_id": original.get("object_id"),
                    "size": original.get("size"),
                }
                wav_reference_cache = None
            else:
                wav_cache = {"path": str(report_wav_path), "sha256": wav_input.get("sha256")}
                wav_reference_cache = {
                    "path": str(base_wav_path),
                    "physical_key": original.get("physical_key"),
                    "sha256": base_wav_input.get("sha256"),
                    "object_id": original.get("object_id"),
                    "size": original.get("size"),
                }
            pair_context = {
                "exact_wav_upload_manifest": str(manifest_path.resolve()),
                "manifest_name": name,
                "manifest_album": item.get("album"),
                "manifest_track": item.get("track"),
                "selected_for_uploaded_output": selected_output,
                "intermediate_source_report": str(parent_report_path) if parent_report_path else None,
                "expected_new_physical_key": item.get("new_physical_key"),
                "expected_pcm_sha256": item.get("pcm_sha256"),
                "expected_references": {
                    "wav": {key: original.get(key) for key in ("object_id", "entry_id", "instance_id", "master_id", "physical_key", "size")},
                    "flac": {key: flac.get(key) for key in ("object_id", "entry_id", "instance_id", "master_id", "physical_key", "size")},
                },
            }
            pair_context["exact_flac_index"] = index
            if upload_state and selected_output:
                pair_context["upload_status_report"] = {
                    "status_available": True,
                    "uploaded_reported": upload_state.get("uploaded"),
                    "readback_sha256": upload_state.get("readback_sha256"),
                    "readback_matches_tagged_output": str(upload_state.get("readback_sha256", "")).lower() == str(item.get("output_sha256", "")).lower(),
                    "new_physical_key_matches_manifest": upload_state.get("new_physical_key") == item.get("new_physical_key"),
                    "evidence_kind": "locally supplied status record; not independently queried",
                }
            else:
                pair_context["upload_status_record"] = {"status_available": False}
            normalized.append({
                "label": f"{name} / FLAC {index}",
                "wav_cache": wav_cache,
                "wav_reference_cache": wav_reference_cache,
                "flac_cache": {
                    "path": flac_input.get("path"),
                    "physical_key": flac.get("physical_key"),
                    "sha256": flac_input.get("sha256"),
                    "object_id": flac.get("object_id"),
                    "size": flac.get("size"),
                },
                "merged_wav": str(merged_path),
                "tag_merge_report": str(report_path),
                "candidate_context": pair_context,
            })
        if not selected_report_found:
            raise PreflightError(f"{name}: no tag report matches the manifest's selected output path and SHA-256")
    return normalized, {"format": "exact_wav_upload_manifest_v1", "source_snapshot": payload.get("source_snapshot"), "status_manifest": str(status_path.resolve()) if status_path else None}


def build_manifest(db_path: Path, pairs_path: Path, ffmpeg: str, ffprobe: str, status_path: Path | None = None) -> dict[str, Any]:
    candidates = read_json(pairs_path)
    pairs, candidate_metadata = normalize_candidate_manifest(candidates, pairs_path, status_path)
    if not isinstance(pairs, list) or not pairs:
        raise PreflightError("candidate manifest must contain at least one complete WAV/FLAC/report candidate")
    declared_snapshot = candidate_metadata.get("source_snapshot")
    candidate_metadata["source_snapshot_matches_database_path"] = (
        Path(str(declared_snapshot)).resolve() == db_path.resolve() if declared_snapshot else None
    )
    db = open_snapshot(db_path)
    try:
        cache: dict[str, Any] = {}
        results = [preflight_pair(db, pair, ffmpeg, ffprobe, cache) for pair in pairs]
        return {
            "tool_version": "1",
            "source_snapshot": {"path": str(db_path.resolve()), "integrity_check": "ok", "opened_read_only": True},
            "candidate_source": str(pairs_path.resolve()),
            "candidate_manifest": candidate_metadata,
            "candidate_count": len(results),
            "ready_for_manual_review_count": sum(result["status"] == "ready_for_manual_review" for result in results),
            "pairs": results,
            "authorization": {"upload": False, "delete": False, "d1_write": False, "r2_access": False},
        }
    finally:
        db.close()


def write_new_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
    except FileExistsError as exc:
        raise PreflightError(f"manifest output already exists; refusing to overwrite: {path}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path, help="local SQLite D1 snapshot")
    parser.add_argument("--candidates", required=True, type=Path, help="JSON listing cache pairs and merge reports")
    parser.add_argument("--output", required=True, type=Path, help="new JSON manifest path; existing files are never overwritten")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable")
    parser.add_argument("--ffprobe", default="ffprobe", help="ffprobe executable")
    parser.add_argument("--status", type=Path, help="optional local exact_wav_upload_status.json record")
    args = parser.parse_args(argv)
    try:
        manifest = build_manifest(args.db, args.candidates, args.ffmpeg, args.ffprobe, args.status)
        write_new_json(args.output, manifest)
        print(json.dumps({"status": "ok", "manifest": str(args.output.resolve()), "ready_for_manual_review": manifest["ready_for_manual_review_count"]}, ensure_ascii=False))
        return 0
    except (PreflightError, OSError, sqlite3.Error, subprocess.SubprocessError) as exc:
        print(f"preflight failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
