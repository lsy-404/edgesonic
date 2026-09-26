"""Read-only D1/R2 capture and decoded-PCM comparison for bounded album pairs."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCRATCH = ROOT / "scratch"
CONFIG = Path(sys.argv[1])
WORKER = CONFIG.parent
ALBUMS = {
    "lost": ("al-6e9d098041", "al-da4b6cd40d"),
    "summer": ("al-00997a7da1", "al-2dd78c6e22"),
    "luo": ("al-2ea8eb469a", "al-9180eaf495"),
    "nothing": ("al-4c6df4d0bc", "al-8a0bee80b4"),
    "dream": ("al-0bf1d619c1", "al-58fb8df24d"),
}


def run(*args: str, capture: bool = True) -> str:
    command = subprocess.list2cmdline(args) if args[0] == "npx" else args
    completed = subprocess.run(command, cwd=WORKER, check=True, text=True,
                               encoding="utf-8", stdout=subprocess.PIPE if capture else None,
                               stderr=subprocess.PIPE if capture else None,
                               shell=args[0] == "npx")
    return completed.stdout if capture else ""


def d1(sql: str) -> list[dict]:
    output = run("npx", "--no-install", "wrangler", "d1", "execute", "edgesonic-db",
                 "--remote", "--config", str(CONFIG), "--command", sql, "--json")
    return json.loads(output)[0]["results"]


def normalized(title: str) -> str:
    return title.lower().replace(" ", "").replace("(米库喵ver.)", "").replace("伴奏", "")


def download(row: dict) -> Path:
    path = SCRATCH / f"{row['instance_id']}.{row['suffix']}"
    if not path.exists():
        run("npx", "--no-install", "wrangler", "r2", "object", "get",
            f"edgesonic-music/{row['physical_key']}", "--remote", "--config", str(CONFIG),
            "--file", str(path), capture=False)
    if path.stat().st_size != row["instance_size"]:
        raise RuntimeError(f"size mismatch for {row['instance_id']}")
    return path


def pcm_digest(path: Path) -> tuple[str, int]:
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(path), "-map_metadata", "-1",
                             "-f", "s32le", "-"], stdout=subprocess.PIPE)
    digest = hashlib.sha256()
    count = 0
    assert proc.stdout
    while block := proc.stdout.read(1024 * 1024):
        digest.update(block)
        count += len(block)
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg decode failed for {path}")
    return digest.hexdigest(), count


def probe_tags(path: Path) -> dict:
    data = json.loads(run("ffprobe", "-v", "error", "-show_entries",
                          "format_tags:stream=codec_name,sample_rate,channels,bits_per_raw_sample",
                          "-of", "json", str(path)))
    return data


def main() -> None:
    ids = ",".join(repr(album_id) for group in ALBUMS.values() for album_id in group)
    rows = d1(
        "SELECT a.id album_id,a.name,a.sort_name,a.year,a.song_count,a.duration,a.size album_size,"
        "a.cover_r2_key album_cover,sm.id master_id,sm.title,sm.track,sm.disc,sm.artist_id,"
        "sm.album_artist_id,sm.cover_r2_key master_cover,si.id instance_id,si.suffix,si.sample_rate,"
        "si.bit_depth,si.channels,si.duration instance_duration,si.size instance_size,"
        "si.storage_object_id,so.physical_key,so.etag,se.id entry_id,se.path,se.companion_of "
        "FROM albums a JOIN song_masters sm ON sm.album_id=a.id "
        "JOIN song_instances si ON si.master_id=sm.id AND si.source_type='original' "
        "LEFT JOIN storage_objects so ON so.id=si.storage_object_id "
        "LEFT JOIN storage_entries se ON se.instance_id=si.id "
        f"WHERE a.id IN ({ids}) ORDER BY a.id,sm.disc,sm.track,sm.id"
    )
    entries = d1(
        "SELECT se.id,se.path,se.kind,se.display_name,se.object_id,se.instance_id,se.companion_of,"
        "so.physical_key,so.suffix,so.size FROM storage_entries se "
        "LEFT JOIN storage_objects so ON so.id=se.object_id WHERE se.path IN ("
        "SELECT DISTINCT substr(se2.path,1,instr(se2.path || '/', '/') - 1) FROM storage_entries se2 "
        f"WHERE se2.instance_id IN (SELECT id FROM song_instances WHERE master_id IN "
        f"(SELECT id FROM song_masters WHERE album_id IN ({ids})))) ORDER BY se.path"
    )
    by_album = defaultdict(list)
    for row in rows:
        by_album[row["album_id"]].append(row)
    comparisons = []
    for group, (left_id, right_id) in ALBUMS.items():
        left = by_album[left_id]
        right = by_album[right_id]
        left_keys = {((r["track"] if group in {"lost", "summer", "luo", "dream"} else normalized(r["title"]))): r for r in left}
        right_keys = {((r["track"] if group in {"lost", "summer", "luo", "dream"} else normalized(r["title"]))): r for r in right}
        for key in sorted(set(left_keys) & set(right_keys), key=str):
            a, b = left_keys[key], right_keys[key]
            a_path, b_path = download(a), download(b)
            a_pcm, a_len = pcm_digest(a_path)
            b_pcm, b_len = pcm_digest(b_path)
            comparisons.append({
                "group": group, "alignment": key, "left": a, "right": b,
                "left_pcm_sha256": a_pcm, "right_pcm_sha256": b_pcm,
                "left_pcm_bytes": a_len, "right_pcm_bytes": b_len,
                "pcm_equal": a_pcm == b_pcm and a_len == b_len,
                "left_probe": probe_tags(a_path), "right_probe": probe_tags(b_path),
            })
    (ROOT / "production_inventory.json").write_text(json.dumps({"rows": rows, "entries": entries}, ensure_ascii=False, indent=2), encoding="utf-8")
    (ROOT / "pcm_comparison.json").write_text(json.dumps(comparisons, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(SCRATCH)


if __name__ == "__main__":
    main()
