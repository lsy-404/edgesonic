"""Capture only bounded source-tree entries; the query is strictly read-only."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from capture_and_compare import ROOT, d1


PREFIXES = (
    "Lost In Tianyi/%", "复刻天依丢了/%", "华哉有夏·贰/%", "华哉有夏 ·贰/%",
    "洛 LUO/%", "无事发生/%", "三无Marblue 无事发生/%", "[夢境之森][FLAC+CUE+LOG+PNG]/%",
)


def main() -> None:
    where = " OR ".join("se.path LIKE " + repr(prefix) for prefix in PREFIXES)
    rows = d1(
        "SELECT se.id,se.path,se.display_name,se.kind,se.object_id,se.instance_id,se.companion_of,"
        "so.physical_key,so.suffix,so.size FROM storage_entries se "
        "LEFT JOIN storage_objects so ON so.id=se.object_id WHERE " + where + " ORDER BY se.path"
    )
    (ROOT / "production_companions.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
