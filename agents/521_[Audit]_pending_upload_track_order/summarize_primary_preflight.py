"""Extract Wrangler JSON receipts and validate the fresh primary preflight."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def receipt_rows(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8-sig")
    start = raw.rfind("[\n  {")
    if start < 0:
        raise ValueError(f"no JSON array in {path.name}")
    value, _ = json.JSONDecoder().raw_decode(raw[start:])
    return value[0]["results"]


def main(artifact_dir: Path) -> None:
    expected = json.loads((artifact_dir / "snapshot_candidate.json").read_text(encoding="utf-8"))
    rows = []
    for path in sorted(artifact_dir.glob("primary_preflight_*.raw.json")):
        rows.extend(receipt_rows(path))
    if len(rows) != len(expected):
        raise SystemExit(f"expected {len(expected)} primary rows, got {len(rows)}")
    mismatches = [
        row for row in rows
        if row["actual_master_id"] != row["master_id"]
        or row["actual_album_id"] != row["expected_album_id"]
        or row["track"] is not None
        or row["disc"] is not None
    ]
    summary = {
        "served_by_primary": True,
        "expected_masters": len(expected),
        "expected_albums": len({r["target_album_id"] for r in expected}),
        "received_rows": len(rows),
        "mismatches": len(mismatches),
        "status": "GO" if not mismatches else "NO-GO",
    }
    (artifact_dir / "primary_preflight_rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (artifact_dir / "primary_preflight_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
