import hashlib
import json
import os
import subprocess
from pathlib import Path

root = Path(r"C:\Users\User\.codex\worktrees\accompaniment-album-repair\lsy-404@edgesonic")
config = Path(r"F:\Development\lsy-404@edgesonic\worker\wrangler.toml")
query = """SELECT CASE WHEN instr(se.path,'人声版')>0 THEN 'human' ELSE 'yanhe' END edition, CAST(substr(se.display_name,1,2) AS INTEGER) track, so.physical_key FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' JOIN storage_objects so ON so.id=si.storage_object_id WHERE instr(se.path,'你的灵魂长出一支玫瑰')>0 AND (instr(se.path,'人声版')>0 OR instr(se.path,'言和版')>0) ORDER BY edition,track"""

rows = json.loads(subprocess.check_output(["npx.cmd", "wrangler", "d1", "execute", "edgesonic-db", "--config", str(config), "--remote", "--json", "--command", query], cwd=root / "worker", text=True, encoding="utf-8"))[0]["results"]
if os.environ.get("PCM_SMOKE"):
    rows = rows[:1]
limit = int(os.environ.get("PCM_BATCH", "0"))
receipt = root / "agents" / "532_[Audit]_pending_library_followup" / "rose_pcm_receipt.json"
completed = json.loads(receipt.read_text(encoding="utf-8")) if receipt.exists() else []
completed_keys = {item["physical_key"] for item in completed}
rows = [row for row in rows if row["physical_key"] not in completed_keys]
if limit:
    rows = rows[:limit]

def digest(key):
    source = subprocess.Popen(["npx.cmd", "wrangler", "r2", "object", "get", f"edgesonic-music/{key}", "--config", str(config), "--remote", "--pipe"], cwd=root / "worker", stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    decoder = subprocess.Popen(["ffmpeg", "-v", "error", "-i", "pipe:0", "-map", "0:a:0", "-acodec", "pcm_s32le", "-f", "s32le", "pipe:1"], stdin=source.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    source.stdout.close()
    h = hashlib.sha256(); size = 0
    while chunk := decoder.stdout.read(1024 * 1024):
        h.update(chunk); size += len(chunk)
    if decoder.wait(timeout=180) or source.wait(timeout=180):
        raise RuntimeError(f"{key}: decoder or source exited unsuccessfully")
    return {"sha256": h.hexdigest(), "bytes": size}

out = completed
for row in rows:
    out.append({**row, "pcm": digest(row["physical_key"])})
    receipt.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
