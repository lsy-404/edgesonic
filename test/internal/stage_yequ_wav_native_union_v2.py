from __future__ import annotations

import hashlib
import json
import os
import ntpath
import pathlib
import secrets
import shutil
import re
import zipfile

from mutagen.flac import FLAC
from mutagen.id3 import APIC, TALB, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK, TXXX
from mutagen.wave import WAVE


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = pathlib.Path(os.environ["YEQ_AUDIT_DIR"])
STAGE = OPS / "yequ_wav_native_stage_v2"
SOURCE_DIR = STAGE / "source"
FLAC_DIR = STAGE / "source_flac"
OUTPUT_DIR = STAGE / "tagged"
REPORT_PATH = OPS / "generic_identity_yequ_flac_wav_pcm_v1.json"
TITLES = [
    "夏日未应答", "名無しの油絵", "星球卑", "南风", "海风以北", "在云端提着花洒的女孩",
    "在路上", "ナルキッソス", "线条与色彩", "再开启", "对你说", "另一世界的你",
]


def digest(path: pathlib.Path, algorithm: str) -> str:
    h = hashlib.new(algorithm)
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def riff_chunks(path: pathlib.Path) -> list[dict[str, object]]:
    result = []
    size = path.stat().st_size
    with path.open("rb") as f:
        header = f.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError(f"not a RIFF/WAVE file: {path.name}")
        if int.from_bytes(header[4:8], "little") + 8 != size:
            raise ValueError(f"RIFF length mismatch: {path.name}")
        offset = 12
        while offset < size:
            f.seek(offset)
            chunk_header = f.read(8)
            if len(chunk_header) != 8:
                raise ValueError(f"truncated RIFF chunk: {path.name}")
            chunk_id = chunk_header[:4]
            length = int.from_bytes(chunk_header[4:], "little")
            data_offset = offset + 8
            end = data_offset + length
            padded_end = end + (length & 1)
            if padded_end > size:
                raise ValueError(f"RIFF chunk exceeds file: {path.name}")
            h = hashlib.sha256()
            f.seek(data_offset)
            remaining = length
            while remaining:
                block = f.read(min(1024 * 1024, remaining))
                if not block:
                    raise ValueError(f"truncated RIFF data: {path.name}")
                h.update(block)
                remaining -= len(block)
            pad = f.read(1) if length & 1 else b""
            result.append({
                "id": chunk_id.decode("latin1"),
                "length": length,
                "sha256": h.hexdigest(),
                "padding_hex": pad.hex(),
            })
            offset = padded_end
    return result


def flac_blocks(path: pathlib.Path) -> list[dict[str, object]]:
    kinds = {0: "STREAMINFO", 1: "PADDING", 2: "APPLICATION", 3: "SEEKTABLE", 4: "VORBIS_COMMENT", 5: "CUESHEET", 6: "PICTURE"}
    result = []
    with path.open("rb") as f:
        if f.read(4) != b"fLaC":
            raise ValueError(f"not a FLAC stream: {path.name}")
        while True:
            header = f.read(4)
            if len(header) != 4:
                raise ValueError(f"truncated FLAC metadata: {path.name}")
            last = bool(header[0] & 0x80)
            kind = header[0] & 0x7F
            length = int.from_bytes(header[1:], "big")
            payload = f.read(length)
            if len(payload) != length:
                raise ValueError(f"truncated FLAC block payload: {path.name}")
            result.append({"type": kind, "name": kinds.get(kind, f"UNKNOWN_{kind}"), "length": length,
                           "payload_sha256": hashlib.sha256(payload).hexdigest()})
            if last:
                return result


def lexical_z_path(path: os.PathLike[str] | str, approved_root: os.PathLike[str] | str) -> pathlib.Path:
    raw_path = os.fspath(path)
    raw_root = os.fspath(approved_root)
    for label, value in (("archive", raw_path), ("approved root", raw_root)):
        drive, _ = ntpath.splitdrive(value)
        if drive.upper() != "Z:" or not ntpath.isabs(value):
            raise SystemExit(f"{label} must be an absolute Z: path")
        if ".." in pathlib.PureWindowsPath(value).parts:
            raise SystemExit(f"{label} path may not contain parent traversal")
    normalized_path = ntpath.normcase(os.path.normpath(os.path.abspath(raw_path)))
    normalized_root = ntpath.normcase(os.path.normpath(os.path.abspath(raw_root)))
    try:
        common = ntpath.commonpath((normalized_root, normalized_path))
    except ValueError as error:
        raise SystemExit("archive is outside the approved Z: root") from error
    if common != normalized_root:
        raise SystemExit("archive is outside the approved Z: root")
    return pathlib.Path(os.path.normpath(os.path.abspath(raw_path)))


def archive_members(path: pathlib.Path, expected_root: pathlib.Path, extension: str) -> dict[int, zipfile.ZipInfo]:
    guarded_path = lexical_z_path(path, expected_root)
    if not guarded_path.is_file():
        raise SystemExit(f"{extension} archive does not exist on the approved Z: path")
    with zipfile.ZipFile(guarded_path) as archive:
        result = {}
        for info in archive.infolist():
            if info.is_dir() or info.filename.startswith("__MACOSX/") or not info.filename.lower().endswith(extension):
                continue
            match = re.match(r"(\d+) ", pathlib.PurePosixPath(info.filename).name)
            if not match:
                continue
            track = int(match.group(1))
            if track in result:
                raise SystemExit(f"duplicate archive track number {track}")
            result[track] = info
        if set(result) != set(range(1, 13)):
            raise SystemExit(f"{extension} archive did not contain exactly twelve numbered tracks")
        return result

def extract_verified(path: pathlib.Path, target: pathlib.Path, info: zipfile.ZipInfo, expected: dict[str, object], expected_root: pathlib.Path) -> dict[str, str | int]:
    guarded_path = lexical_z_path(path, expected_root)
    if not guarded_path.is_file():
        raise SystemExit("source archive does not exist on the approved Z: path")
    if target.exists():
        raise SystemExit(f"refusing to overwrite {target.name}")
    if info.file_size != expected["size"] or f"{info.CRC:08x}" != expected["crc32"]:
        raise SystemExit(f"archive member size/CRC differs from frozen source proof: {target.name}")
    md5 = hashlib.md5()
    sha = hashlib.sha256()
    with zipfile.ZipFile(guarded_path) as archive, archive.open(info) as source, target.open("xb") as output:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            output.write(block)
            md5.update(block)
            sha.update(block)
    if target.stat().st_size != expected["size"] or md5.hexdigest() != expected["md5"] or sha.hexdigest() != expected["sha256"]:
        raise SystemExit(f"archive member full hash differs from frozen source proof: {target.name}")
    return {"size": target.stat().st_size, "md5": md5.hexdigest(), "sha256": sha.hexdigest(), "crc32": f"{info.CRC:08x}"}


def main() -> int:
    wav_archive = pathlib.Path(os.environ["YEQ_Z_WAV_ZIP"])
    flac_archive = pathlib.Path(os.environ["YEQ_Z_FLAC_ZIP"])
    expected_z_root = pathlib.Path(os.environ["YEQ_Z_ROOT"])
    wav_archive = lexical_z_path(wav_archive, expected_z_root)
    flac_archive = lexical_z_path(flac_archive, expected_z_root)
    if not REPORT_PATH.is_file():
        raise SystemExit("the verified source report is missing")
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    items = {int(item["track"]): item for item in report["items"]}
    if len(items) != 12 or len(TITLES) != 12:
        raise SystemExit("unexpected source mapping scope")
    wav_members = archive_members(wav_archive, expected_z_root, ".wav")
    flac_members = archive_members(flac_archive, expected_z_root, ".flac")
    SOURCE_DIR.mkdir(parents=True, exist_ok=False)
    FLAC_DIR.mkdir(parents=True, exist_ok=False)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=False)
    manifest_items = []
    proof_items = []
    for track in range(1, 13):
        source = SOURCE_DIR / f"source_{track:02d}.wav"
        flac_source = FLAC_DIR / f"source_{track:02d}.flac"
        output = OUTPUT_DIR / f"track_{track:02d}.wav"
        if output.exists():
            raise SystemExit(f"existing output for track {track}")
        expected = items[track]
        wav_body = extract_verified(wav_archive, source, wav_members[track], expected["wav_body"], expected_z_root)
        flac_body = extract_verified(flac_archive, flac_source, flac_members[track], expected["flac_body"], expected_z_root)
        if pathlib.PurePosixPath(flac_members[track].filename).name != pathlib.PurePosixPath(expected["flac_member"]).name:
            raise SystemExit(f"FLAC member identity differs from the frozen source proof for track {track}")
        source_flac = FLAC(str(flac_source))
        source_comments = {str(key): [str(value) for value in values] for key, values in (source_flac.tags or {}).items()}
        source_pictures = [{"type": int(pic.type), "mime": pic.mime, "description": pic.desc,
                            "size": len(pic.data), "sha256": hashlib.sha256(pic.data).hexdigest()} for pic in source_flac.pictures]
        blocks = flac_blocks(flac_source)
        canonical_title = TITLES[track - 1]
        if source_comments.get("title") != [canonical_title] or source_comments.get("artist") != ["洛天依"]:
            raise SystemExit(f"FLAC title/artist tags do not match the reviewed release for track {track}")
        if source_comments.get("tracknumber") != [f"{track:02d}"]:
            raise SystemExit(f"FLAC track number does not match the source order for track {track}")
        chunks_before = riff_chunks(source)
        if any(chunk["id"] in ("id3 ", "ID3 ") for chunk in chunks_before):
            raise SystemExit(f"unexpected existing WAV ID3 chunk for track {track}")
        shutil.copyfile(source, output)
        audio = WAVE(str(output))
        if audio.tags is not None:
            raise SystemExit(f"unexpected Mutagen tags for track {track}")
        audio.add_tags()
        assert audio.tags is not None
        audio.tags.add(TIT2(encoding=3, text=TITLES[track - 1]))
        audio.tags.add(TPE1(encoding=3, text="洛天依"))
        audio.tags.add(TALB(encoding=3, text="遇依"))
        audio.tags.add(TPE2(encoding=3, text="洛天依"))
        audio.tags.add(TDRC(encoding=3, text="2024"))
        audio.tags.add(TRCK(encoding=3, text=f"{track}/12"))
        audio.tags.add(TPOS(encoding=3, text="1/1"))
        for picture in source_flac.pictures:
            audio.tags.add(APIC(encoding=3, mime=picture.mime, type=int(picture.type), desc=picture.desc, data=picture.data))
        source_copy = {
            "archive_path": str(wav_archive),
            "archive_member": wav_members[track].filename,
            "source_full_md5": wav_body["md5"],
            "source_full_sha256": wav_body["sha256"],
            "source_size": wav_body["size"],
            "source_archive_crc32": wav_body["crc32"],
            "source_native_tags": "none",
            "lower_flac": {
                "archive_path": str(flac_archive),
                "archive_member": flac_members[track].filename,
                "full_md5": flac_body["md5"],
                "full_sha256": flac_body["sha256"],
                "size": flac_body["size"],
                "archive_crc32": flac_body["crc32"],
                "comments": source_comments,
                "pictures": source_pictures,
                "metadata_blocks": blocks,
                "preservation": "all source comments are preserved verbatim in this JSON frame; embedded pictures are copied byte-exactly into APIC; original FLAC body remains retained by its verified object identity",
            },
            "preservation": "original RIFF non-ID3 chunks remain byte-identical; canonical metadata and lower-FLAC source-copy data are in new ID3 frames",
        }
        audio.tags.add(TXXX(encoding=3, desc="SOURCE_COPY", text=json.dumps(source_copy, ensure_ascii=False, sort_keys=True, separators=(",", ":"))))
        audio.tags.add(TXXX(encoding=3, desc="SOURCE_COPY_LOWER_FLAC_JSON", text=json.dumps(source_copy["lower_flac"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))))
        audio.tags.save(str(output), v2_version=4)
        chunks_after = riff_chunks(output)
        non_id3_before = [chunk for chunk in chunks_before if chunk["id"] not in ("id3 ", "ID3 ")]
        non_id3_after = [chunk for chunk in chunks_after if chunk["id"] not in ("id3 ", "ID3 ")]
        if non_id3_before != non_id3_after:
            raise SystemExit(f"non-ID3 RIFF chunks changed for track {track}")
        if [chunk for chunk in non_id3_before if chunk["id"] == "data"] != [chunk for chunk in non_id3_after if chunk["id"] == "data"]:
            raise SystemExit(f"PCM data chunk changed for track {track}")
        check = WAVE(str(output))
        if check.info.sample_rate != 48000 or check.info.channels != 2 or check.info.bits_per_sample != 24:
            raise SystemExit(f"audio format changed for track {track}")
        frames = {frame.FrameID: frame for frame in check.tags.values()}
        actual = {
            "title": str(frames["TIT2"].text[0]), "artist": str(frames["TPE1"].text[0]),
            "album": str(frames["TALB"].text[0]), "album_artist": str(frames["TPE2"].text[0]),
            "year": str(frames["TDRC"].text[0]), "track": str(frames["TRCK"].text[0]),
        }
        expected_tags = {"title": TITLES[track - 1], "artist": "洛天依", "album": "遇依", "album_artist": "洛天依", "year": "2024", "track": f"{track}/12"}
        if actual != expected_tags:
            raise SystemExit(f"native ID3 mismatch track {track}: {actual!r}")
        if {frame.desc for frame in check.tags.getall("TXXX")} != {"SOURCE_COPY", "SOURCE_COPY_LOWER_FLAC_JSON"}:
            raise SystemExit(f"SOURCE_COPY provenance missing for track {track}")
        if len(check.tags.getall("APIC")) != len(source_flac.pictures):
            raise SystemExit(f"source FLAC pictures were not preserved for track {track}")
        for source_picture, apic in zip(source_flac.pictures, check.tags.getall("APIC"), strict=True):
            if source_picture.data != apic.data or hashlib.sha256(source_picture.data).hexdigest() != hashlib.sha256(apic.data).hexdigest():
                raise SystemExit(f"source picture bytes changed for track {track}")
        object_id = "obj_" + secrets.token_hex(8)
        manifest_items.append({
            "object_id": object_id,
            "physical_key": f"objects/{object_id}.wav",
            "local_file": str(output),
            "size": output.stat().st_size,
            "sha256": digest(output, "sha256"),
            "md5": digest(output, "md5"),
            "content_type": "audio/wav",
            "suffix": "wav",
        })
        proof_items.append({
            "track": track,
            "title": TITLES[track - 1],
            "source_full_md5": wav_body["md5"],
            "source_full_sha256": wav_body["sha256"],
            "source_size": wav_body["size"],
            "lower_flac_full_md5": flac_body["md5"],
            "lower_flac_full_sha256": flac_body["sha256"],
            "lower_flac_size": flac_body["size"],
            "lower_flac_comments": source_comments,
            "lower_flac_pictures": source_pictures,
            "lower_flac_metadata_blocks": blocks,
            "tagged_full_md5": manifest_items[-1]["md5"],
            "tagged_full_sha256": manifest_items[-1]["sha256"],
            "tagged_size": manifest_items[-1]["size"],
            "audio_format": {"sample_rate": check.info.sample_rate, "channels": check.info.channels, "bits_per_sample": check.info.bits_per_sample},
            "non_id3_chunks_identical": True,
            "pcm_chunk_identical": True,
            "native_tags": actual,
            "source_copy": source_copy,
            "riff_chunks_before": chunks_before,
            "riff_chunks_after": chunks_after,
            "object_id": object_id,
        })
    manifest = {"complete": True, "items": manifest_items}
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    manifest_path = OPS / "yequ_wav_native_union_upload_manifest_v2.json"
    if manifest_path.exists():
        raise SystemExit("refusing to overwrite immutable v1 upload manifest")
    manifest_path.write_bytes(manifest_bytes)
    proof = {
        "status": "PASS",
        "source_report_sha256": hashlib.sha256(REPORT_PATH.read_bytes()).hexdigest(),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "worker_parser_test": "pending",
        "item_count": len(proof_items),
        "all_source_bodies_match_full_md5_sha256_size": True,
        "all_non_id3_riff_chunks_byte_identical": True,
        "all_pcm_data_chunks_byte_identical": True,
        "all_native_tags_verified_after_write": True,
        "items": proof_items,
    }
    proof_path = OPS / "yequ_wav_native_union_source_copy_pcm_proof_v2.json"
    if proof_path.exists():
        raise SystemExit("refusing to overwrite immutable v1 native proof")
    proof_path.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"status": "PASS", "manifest": str(manifest_path), "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "items": len(manifest_items), "proof": str(proof_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
