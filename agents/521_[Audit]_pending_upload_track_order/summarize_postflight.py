"""Validate the read-only production postflight receipts."""
from __future__ import annotations
import json, sys
from pathlib import Path

def rows_from(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8-sig")
    start = raw.rfind("[\n  {")
    if start < 0:
        raise ValueError(f"missing Wrangler JSON: {path.name}")
    value, _ = json.JSONDecoder().raw_decode(raw[start:])
    return value[0]["results"]

def main(root: Path) -> None:
    expected = json.loads((root / "snapshot_candidate.json").read_text(encoding="utf-8"))
    rows = [row for path in sorted(root.glob("postflight_*.raw.json")) for row in rows_from(path)]
    expected_by_id = {row["master_id"]: row for row in expected}
    mismatches = [row for row in rows if row["master_id"] not in expected_by_id or row["actual_master_id"] != row["master_id"] or row["actual_album_id"] != row["expected_album_id"] or row["track"] != row["filename_track"] or row["disc"] != 1 or not row["exact_source_match"]]
    albums = {}
    for row in rows:
        bucket = albums.setdefault(row["expected_album_id"], {"members": 0, "tracks": [], "invalid": 0})
        bucket["members"] += 1
        bucket["tracks"].append(row["track"])
        bucket["invalid"] += int(row in mismatches)
    album_summary = [{"album_id": album, "members": data["members"], "tracks": sorted(data["tracks"]), "invalid": data["invalid"]} for album, data in sorted(albums.items())]
    anomalies = [entry for entry in album_summary if entry["invalid"] or len(entry["tracks"]) != len(set(entry["tracks"]))]
    summary = {"served_by_primary": True, "expected_masters": len(expected), "received_rows": len(rows), "expected_albums": len({r["target_album_id"] for r in expected}), "exact_source_matches": sum(bool(r["exact_source_match"]) for r in rows), "mismatches": len(mismatches), "album_anomalies": len(anomalies), "status": "GO" if len(rows) == len(expected) and not mismatches and not anomalies else "NO-GO"}
    (root / "postflight_rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2).replace("#", "\\u0023") + "\n", encoding="utf-8", newline="\n")
    (root / "postflight_album_summary.json").write_text(json.dumps(album_summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (root / "postflight_execution_receipt.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8", newline="\n")

if __name__ == "__main__": main(Path(sys.argv[1]))
