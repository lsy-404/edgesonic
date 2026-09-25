#!/usr/bin/env python3
"""Copy FLAC Vorbis comments and pictures into a new WAV ID3 chunk safely."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from mutagen.flac import FLAC
from mutagen.id3 import APIC, COMM, ID3, TCOM, TCON, TIT2, TDRC, TPOS, TRCK, TPE1, TPE2, TALB, TXXX, USLT
from mutagen.wave import WAVE


VERSION = "1"
FIELD_FRAMES = {
    "TITLE": "TIT2", "ARTIST": "TPE1", "ALBUM": "TALB",
    "ALBUMARTIST": "TPE2", "ALBUM ARTIST": "TPE2", "GENRE": "TCON",
    "TRACKNUMBER": "TRCK", "TRACK": "TRCK", "DISCNUMBER": "TPOS",
    "DISC": "TPOS", "DATE": "TDRC", "YEAR": "TDRC",
    "COMPOSER": "TCOM", "LYRICS": "USLT", "UNSYNCEDLYRICS": "USLT",
    "COMMENT": "COMM",
}
FRAME_CLASSES = {
    "TIT2": TIT2, "TPE1": TPE1, "TALB": TALB, "TPE2": TPE2,
    "TCON": TCON, "TRCK": TRCK, "TPOS": TPOS, "TDRC": TDRC,
    "TCOM": TCOM, "USLT": USLT, "COMM": COMM,
}
BLOCK_NAMES = {
    0: "STREAMINFO", 1: "PADDING", 2: "APPLICATION", 3: "SEEKTABLE",
    4: "VORBIS_COMMENT", 5: "CUESHEET", 6: "PICTURE",
}
REGENERABLE_BLOCKS = {1, 3}


class MergeError(Exception):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_values(tags: ID3 | None) -> dict[str, list[str]]:
    values: dict[str, list[str]] = {}
    if not tags:
        return values
    for frame_id in set(FIELD_FRAMES.values()):
        frames = tags.getall(frame_id)
        if frame_id in ("USLT", "COMM"):
            frames = sorted(frames, key=lambda frame: frame.desc.casefold())
        if not frames:
            continue
        raw: list[Any] = []
        for frame in frames:
            if frame_id == "USLT":
                raw.append(frame.text)
            else:
                raw.extend(frame.text)
        vals = [str(v) for v in raw if str(v) != ""]
        if vals:
            values[frame_id] = vals
    return values


def flac_comments(flac: FLAC) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if flac.tags:
        for key, vals in flac.tags.items():
            out[str(key).upper()] = [str(v) for v in vals]
    return out


def parse_flac_blocks(path: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    with path.open("rb") as f:
        if f.read(4) != b"fLaC":
            raise MergeError("invalid FLAC signature")
        while True:
            header = f.read(4)
            if len(header) != 4:
                raise MergeError("truncated FLAC metadata block header")
            last = bool(header[0] & 0x80)
            code = header[0] & 0x7F
            size = int.from_bytes(header[1:4], "big")
            payload = f.read(size)
            if len(payload) != size:
                raise MergeError("truncated FLAC metadata block")
            result.append({
                "type": code,
                "name": BLOCK_NAMES.get(code, f"UNKNOWN_{code}"),
                "length": size,
                "sha256": sha256(payload),
                "preserved_in_wav": code in (4, 6),
            })
            if last:
                break
    return result


def riff_chunks(path: Path) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    file_size = path.stat().st_size
    with path.open("rb") as f:
        head = f.read(12)
        if len(head) != 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise MergeError("input must be a RIFF/WAVE file (RF64 is not supported)")
        declared_size = int.from_bytes(head[4:8], "little") + 8
        if declared_size != file_size:
            raise MergeError("RIFF size does not match physical file size")
        offset = 12
        while offset < file_size:
            f.seek(offset)
            chunk_head = f.read(8)
            if len(chunk_head) != 8:
                raise MergeError("truncated RIFF chunk header")
            chunk_id = chunk_head[:4]
            size = int.from_bytes(chunk_head[4:], "little")
            data_offset = offset + 8
            end = data_offset + size
            padded_end = end + (size & 1)
            if padded_end > file_size:
                raise MergeError("RIFF chunk exceeds file boundary")
            digest = hashlib.sha256()
            f.seek(data_offset)
            remaining = size
            while remaining:
                part = f.read(min(1024 * 1024, remaining))
                if not part:
                    raise MergeError("truncated RIFF chunk data")
                digest.update(part)
                remaining -= len(part)
            chunks.append({
                "id": chunk_id.decode("latin1"),
                "length": size,
                "sha256": digest.hexdigest(),
                "padding_sha256": sha256(f.read(1)) if size & 1 else sha256(b""),
                "offset": offset,
            })
            offset = padded_end
        if offset != file_size:
            raise MergeError("invalid RIFF chunk padding")
    return chunks


def non_id3_signature(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: chunk[key] for key in ("id", "length", "sha256", "padding_sha256")}
        for chunk in chunks if chunk["id"] not in ("id3 ", "ID3 ")
    ]


def audio_data_signature(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: chunk[key] for key in ("length", "sha256")}
        for chunk in chunks if chunk["id"] == "data"
    ]


def compare_audio_format(flac_info: Any, wav_info: Any) -> dict[str, Any]:
    flac_rate = int(flac_info.sample_rate)
    wav_rate = int(wav_info.sample_rate)
    fields = {
        "sample_rate": {"flac": flac_rate, "wav": wav_rate},
        "channels": {"flac": int(flac_info.channels), "wav": int(wav_info.channels)},
        "bits_per_sample": {"flac": int(flac_info.bits_per_sample), "wav": int(wav_info.bits_per_sample)},
        "sample_count": {
            "flac": round(float(flac_info.length) * flac_rate),
            "wav": round(float(wav_info.length) * wav_rate),
        },
    }
    return {
        "fields": fields,
        "matches": all(value["flac"] == value["wav"] for value in fields.values()),
        "pcm_content_checked": False,
        "pcm_content_check_required": "Compare decoded FLAC samples with WAV data bytes externally.",
    }


def _values_for_comment(key: str, values: list[str]) -> list[str]:
    return values


def _add_frame(tags: ID3, frame_id: str, values: list[str], desc: str = "") -> None:
    if frame_id == "USLT":
        for index, value in enumerate(values, start=1):
            tags.add(USLT(encoding=3, lang="XXX", desc=desc or f"FLAC value {index:06}", text=value))
    elif frame_id == "COMM":
        for index, value in enumerate(values, start=1):
            tags.add(COMM(encoding=3, lang="XXX", desc=desc or f"FLAC value {index:06}", text=value))
    else:
        cls = FRAME_CLASSES[frame_id]
        tags.add(cls(encoding=3, text=values))


def source_for_resolution(value: Any, wav_values: list[str], flac_values: list[str]) -> list[str]:
    if value == "wav":
        return wav_values
    if value == "flac":
        return flac_values
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    raise MergeError("resolution values must be 'wav', 'flac', a string, or a string list")


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    created = False
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.link(temp_name, path)
        created = True
    except Exception:
        try:
            if created:
                path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    finally:
        Path(temp_name).unlink(missing_ok=True)


def merge(flac_path: Path, wav_path: Path, output_path: Path, report_path: Path, resolutions: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    flac_path = flac_path.resolve()
    wav_path = wav_path.resolve()
    output_path = output_path.resolve()
    report_path = report_path.resolve()
    if not flac_path.is_file() or not wav_path.is_file():
        raise MergeError("both input files must exist")
    if flac_path == wav_path or output_path in (flac_path, wav_path):
        raise MergeError("input and output paths must be distinct")
    if output_path == report_path or report_path in (flac_path, wav_path):
        raise MergeError("report path must be distinct from audio paths")
    if output_path.exists() or report_path.exists():
        raise MergeError("output or report already exists; refusing to overwrite")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    wav_chunks_before = riff_chunks(wav_path)
    id3_chunks_before = [c for c in wav_chunks_before if c["id"] in ("id3 ", "ID3 ")]
    if len(id3_chunks_before) > 1:
        raise MergeError("WAV contains multiple ID3 chunks; refusing ambiguous edit")
    flac = FLAC(str(flac_path))
    source_tags = flac_comments(flac)
    target_audio = WAVE(str(wav_path))
    target_tags = target_audio.tags
    format_comparison = compare_audio_format(flac.info, target_audio.info)
    target_values = canonical_values(target_tags)
    mapped_comments: dict[str, list[str]] = {}
    custom_comments: dict[str, list[str]] = {}
    for key, values in source_tags.items():
        frame_id = FIELD_FRAMES.get(key)
        if frame_id:
            mapped_comments[frame_id] = mapped_comments.get(frame_id, []) + _values_for_comment(key, values)
        custom_comments[key] = values

    field_values = {key: vals for key, vals in mapped_comments.items()}
    field_mapping_notes = []
    for key, frame_id in FIELD_FRAMES.items():
        values = source_tags.get(key, [])
        if frame_id in ("USLT", "COMM") and len(values) > 1:
            field_mapping_notes.append({
                "field": key,
                "frame": frame_id,
                "note": "Each source value is written as a separate ID3 frame with a unique description and mirrored in TXXX.",
            })
    target_custom: dict[str, list[str]] = {}
    if target_tags:
        for frame in target_tags.getall("TXXX"):
            target_custom.setdefault(frame.desc.upper(), []).extend(str(v) for v in frame.text)
    custom_conflicts: dict[str, dict[str, list[str]]] = {}
    planned_custom: dict[str, list[str]] = {}
    for key, values in custom_comments.items():
        existing = target_custom.get(key, [])
        if existing and values and existing != values:
            conflict_key = f"TXXX:{key}"
            custom_conflicts[conflict_key] = {"wav": existing, "flac": values}
            if conflict_key in resolutions:
                planned_custom[key] = source_for_resolution(resolutions[conflict_key], existing, values)
        elif values:
            planned_custom[key] = existing or values
    conflicts: dict[str, dict[str, list[str]]] = {}
    planned_values: dict[str, list[str]] = {}
    for field in sorted(set(target_values) | set(field_values)):
        wav_values = target_values.get(field, [])
        flac_values = field_values.get(field, [])
        if wav_values and flac_values and wav_values != flac_values:
            conflicts[field] = {"wav": wav_values, "flac": flac_values}
            if field in resolutions:
                planned_values[field] = source_for_resolution(resolutions[field], wav_values, flac_values)
        elif flac_values:
            planned_values[field] = wav_values or flac_values
        elif wav_values:
            planned_values[field] = wav_values

    blocks = parse_flac_blocks(flac_path)
    pictures = []
    unpreserved_pictures = []
    for index, picture in enumerate(flac.pictures):
        pic = {
            "index": index, "type": int(picture.type), "mime": str(picture.mime),
            "description": str(picture.desc), "length": len(picture.data),
            "sha256": sha256(picture.data), "preserved_in_wav": 0 <= int(picture.type) <= 20,
        }
        pictures.append(pic)
        if not pic["preserved_in_wav"]:
            unpreserved_pictures.append(pic)
    for block in blocks:
        if block["type"] == 0:
            block["preserved_in_wav"] = format_comparison["matches"]
            block["preservation"] = "equivalent_wav_format" if format_comparison["matches"] else "unpreserved_format_mismatch"
        elif block["type"] in REGENERABLE_BLOCKS:
            block["preserved_in_wav"] = True
            block["preservation"] = "regenerable"
        elif block["type"] == 4:
            block["preserved_in_wav"] = True
            block["preservation"] = "copied_as_id3_frames"
        elif block["type"] == 6:
            block["preserved_in_wav"] = not unpreserved_pictures
            block["preservation"] = "copied_as_apic" if block["preserved_in_wav"] else "unpreserved_picture_type"
        else:
            block["preserved_in_wav"] = False
            block["preservation"] = "must_be_retained_with_flac"
    unpreserved_blocks = [b for b in blocks if not b["preserved_in_wav"]]

    report: dict[str, Any] = {
        "tool_version": VERSION,
        "inputs": {
            "flac": {"path": str(flac_path), "sha256": file_sha256(flac_path)},
            "wav": {"path": str(wav_path), "sha256": file_sha256(wav_path)},
        },
        "output": {"path": str(output_path), "written": False},
        "fields": {
            frame: {"wav": target_values.get(frame, []), "flac": field_values.get(frame, []),
                   "selected": planned_values.get(frame, [])}
            for frame in sorted(set(target_values) | set(field_values))
        },
        "field_mapping_notes": field_mapping_notes,
        "conflicts": conflicts,
        "custom_comment_conflicts": custom_conflicts,
        "resolutions": resolutions,
        "custom_vorbis_comments": {key: values for key, values in custom_comments.items() if key not in FIELD_FRAMES},
        "source_comments_written_as_txxx": list(custom_comments),
        "unmapped_fields": [key for key in custom_comments if key not in FIELD_FRAMES],
        "unmapped_fields_preserved_as_txxx": [key for key in custom_comments if key not in FIELD_FRAMES],
        "custom_comment_values": {
            key: {"wav": target_custom.get(key, []), "flac": values, "selected": planned_custom.get(key, [])}
            for key, values in custom_comments.items()
        },
        "pictures": pictures,
        "unpreserved_pictures": unpreserved_pictures,
        "flac_metadata_blocks": blocks,
        "unpreserved_flac_blocks": unpreserved_blocks,
        "audio_format_comparison": format_comparison,
        "wav_non_id3_chunks_before": non_id3_signature(wav_chunks_before),
        "pcm_data_chunks_before": audio_data_signature(wav_chunks_before),
        "verification": {"passed": False},
        "flac_retention": {
            "metadata_preserved": False,
            "external_pcm_match_required": True,
            "reasons": [],
        },
    }
    retention_reasons = []
    if unpreserved_blocks:
        retention_reasons.append("FLAC contains metadata blocks whose information is not represented in the WAV")
    if unpreserved_pictures:
        retention_reasons.append("FLAC contains picture types not representable as ID3 APIC")
    if not format_comparison["matches"]:
        retention_reasons.append("FLAC STREAMINFO does not match the WAV technical format")
    retention_reasons.append("PCM identity has not been externally verified.")
    report["flac_retention"]["reasons"] = retention_reasons

    unresolved = sorted((set(conflicts) | set(custom_conflicts)) - set(resolutions))
    if unresolved:
        report["verification"] = {"passed": False, "status": "aborted_unresolved_conflicts", "unresolved_fields": unresolved}
        report["flac_retention"]["reasons"].append("Tag conflicts are unresolved.")
        atomic_json(report_path, report)
        return 2, report

    tmp_fd, tmp_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp.wav", dir=output_path.parent)
    os.close(tmp_fd)
    tmp = Path(tmp_name)
    published = False
    try:
        shutil.copyfile(wav_path, tmp)
        wav_out = WAVE(str(tmp))
        if wav_out.tags is None:
            wav_out.add_tags()
        out_tags = wav_out.tags
        assert out_tags is not None

        for frame_id, values in planned_values.items():
            write_values = values
            existing = out_tags.get(frame_id)
            old_values = canonical_values(out_tags).get(frame_id, [])
            if not old_values or (frame_id in resolutions and old_values != values):
                if existing is not None:
                    for frame in list(out_tags.getall(frame_id)):
                        del out_tags[frame.HashKey]
                if write_values:
                    _add_frame(out_tags, frame_id, write_values)

        for key, values in custom_comments.items():
            if key not in planned_custom or not planned_custom[key]:
                continue
            existing_values = [str(v) for frame in out_tags.getall("TXXX") if frame.desc.casefold() == key.casefold() for v in frame.text]
            selected_values = planned_custom[key]
            if f"TXXX:{key}" in resolutions and existing_values != selected_values:
                for frame in list(out_tags.getall("TXXX")):
                    if frame.desc.casefold() == key.casefold():
                        del out_tags[frame.HashKey]
                existing_values = []
            missing = [v for v in selected_values if v not in existing_values]
            if missing:
                out_tags.add(TXXX(encoding=3, desc=key, text=missing))

        for picture in flac.pictures:
            if 0 <= int(picture.type) <= 20:
                out_tags.add(APIC(encoding=3, mime=picture.mime or "application/octet-stream",
                                  type=int(picture.type), desc=picture.desc or "", data=picture.data))

        out_tags.save(str(tmp), v2_version=4)
        wav_chunks_after = riff_chunks(tmp)
        before_non_id3 = non_id3_signature(wav_chunks_before)
        after_non_id3 = non_id3_signature(wav_chunks_after)
        before_pcm = audio_data_signature(wav_chunks_before)
        after_pcm = audio_data_signature(wav_chunks_after)
        if before_non_id3 != after_non_id3:
            raise MergeError("verification failed: non-ID3 RIFF chunks changed in order, length, or SHA-256")
        if not before_pcm or before_pcm != after_pcm:
            raise MergeError("verification failed: PCM data chunk sequence, length, or SHA-256 changed")

        check = WAVE(str(tmp))
        actual_values = canonical_values(check.tags)
        field_checks = {}
        for frame_id, expected in planned_values.items():
            actual = actual_values.get(frame_id, [])
            expected_frame_values = expected
            ok = actual == expected_frame_values
            field_checks[frame_id] = {"expected": expected, "expected_frame_values": expected_frame_values,
                                      "actual": actual, "passed": ok}
            if not ok:
                raise MergeError(f"verification failed: {frame_id} values differ after readback: expected {expected!r}, got {actual!r}")
        expected_custom = {(key.casefold(), value) for key, vals in planned_custom.items() for value in vals}
        actual_custom = {(frame.desc.casefold(), str(value)) for frame in (check.tags.getall("TXXX") if check.tags else []) for value in frame.text}
        custom_ok = expected_custom <= actual_custom
        if not custom_ok:
            raise MergeError("verification failed: custom Vorbis comments did not round-trip")
        expected_pics = {(sha256(p.data), p.mime or "application/octet-stream", int(p.type), p.desc or "") for p in flac.pictures if 0 <= int(p.type) <= 20}
        actual_pics = {(sha256(frame.data), frame.mime, int(frame.type), frame.desc) for frame in (check.tags.getall("APIC") if check.tags else [])}
        pictures_ok = expected_pics <= actual_pics
        if not pictures_ok:
            raise MergeError("verification failed: one or more FLAC pictures did not round-trip")

        report["output"]["sha256"] = file_sha256(tmp)
        report["output"]["size"] = tmp.stat().st_size
        report["output"]["written"] = True
        report["wav_non_id3_chunks_after"] = after_non_id3
        report["pcm_data_chunks_after"] = after_pcm
        report["verification"] = {
            "passed": True, "status": "verified",
            "non_id3_riff_chunks_unchanged": True,
            "pcm_data_chunks_unchanged": True,
            "fields": field_checks,
            "custom_comments": custom_ok,
            "pictures": pictures_ok,
        }
        report["flac_retention"]["metadata_preserved"] = (
            not unpreserved_blocks and not unpreserved_pictures and format_comparison["matches"]
        )
        # Publish without replacing a file created concurrently.
        os.link(tmp, output_path)
        published = True
        atomic_json(report_path, report)
        return 0, report
    except Exception as exc:
        if published:
            output_path.unlink(missing_ok=True)
        report["output"]["written"] = False
        report["verification"] = {"passed": False, "status": "failed_and_rolled_back", "error": str(exc)}
        report["flac_retention"]["metadata_preserved"] = False
        report["flac_retention"]["reasons"].append("WAV output did not pass verification.")
        if not report_path.exists():
            atomic_json(report_path, report)
        raise
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("flac", type=Path, help="source FLAC file")
    parser.add_argument("wav", type=Path, help="target WAV file")
    parser.add_argument("--output", type=Path, help="new WAV output path (defaults to <wav>.merged.wav)")
    parser.add_argument("--report", type=Path, help="JSON report path (defaults beside output)")
    parser.add_argument("--resolve-json", type=Path, help="JSON object mapping conflicting ID3 frame IDs to wav/flac/value/list")
    args = parser.parse_args()
    output = args.output or args.wav.with_name(f"{args.wav.stem}.merged{args.wav.suffix}")
    report = args.report or output.with_name(f"{output.stem}.merge-report.json")
    resolutions: dict[str, Any] = {}
    try:
        if args.resolve_json:
            resolutions = json.loads(args.resolve_json.read_text(encoding="utf-8"))
            if not isinstance(resolutions, dict):
                raise MergeError("resolution JSON must be an object")
        status, result = merge(args.flac, args.wav, output, report, resolutions)
        print(json.dumps({"status": status, "report": str(report), "output": result["output"]}, ensure_ascii=False))
        return status
    except Exception as exc:
        print(f"merge failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
