"""Capture current display-group memberships with a bounded read-only query."""
from __future__ import annotations

import json

from capture_and_compare import ROOT, d1


ALBUM_IDS = (
    "al-6e9d098041", "al-da4b6cd40d", "al-00997a7da1", "al-2dd78c6e22",
    "al-2ea8eb469a", "al-9180eaf495", "al-4c6df4d0bc", "al-8a0bee80b4",
    "al-0bf1d619c1", "al-58fb8df24d",
)


def main() -> None:
    ids = ",".join(repr(value) for value in ALBUM_IDS)
    rows = d1(
        "SELECT a.id album_id,a.name,a.sort_name,a.year,a.song_count,a.duration,a.size,"
        "g.id group_id,g.display_name,g.sort_name group_sort_name,gm.sort_order,"
        "(SELECT COUNT(*) FROM album_display_group_members peer WHERE peer.group_id=g.id) member_count,"
        "(SELECT COUNT(*) FROM song_masters sm WHERE sm.album_id=a.id) master_count,"
        "(SELECT COUNT(*) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id "
        "WHERE sm.album_id=a.id AND si.source_type='original' AND si.missing=0) available_instances "
        "FROM albums a LEFT JOIN album_display_group_members gm ON gm.album_id=a.id "
        "LEFT JOIN album_display_groups g ON g.id=gm.group_id "
        f"WHERE a.id IN ({ids}) ORDER BY g.id,gm.sort_order,a.id"
    )
    (ROOT / "display_group_membership_primary.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
