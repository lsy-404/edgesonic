"""Build a D1-only track-order candidate from the reviewed safe-move snapshot."""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path


NUMBERED_NAME = re.compile(r"^\s*(?:Track\s+)?0*(\d{1,2})(?=\s|[._-])", re.I)


def sql(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main(source: Path, output: Path) -> None:
    rows = json.loads(source.read_text(encoding="utf-8"))
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        match = NUMBERED_NAME.match(row["display_name"])
        if match:
            row = {**row, "filename_track": int(match.group(1))}
            groups[row["target_album_id"]].append(row)

    selected = []
    for album_id, members in groups.items():
        if len(members) == len([r for r in rows if r["target_album_id"] == album_id]):
            indices = [r["filename_track"] for r in members]
            if len(indices) == len(set(indices)):
                selected.extend(members)

    selected.sort(key=lambda r: (r["target_album_id"], r["filename_track"], r["master_id"]))
    if len(selected) != 243 or len({r["target_album_id"] for r in selected}) != 25:
        raise SystemExit(f"unexpected scope: {len(selected)} masters / {len({r['target_album_id'] for r in selected})} groups")

    output.mkdir(parents=True, exist_ok=True)
    snapshot = [
        {
            "master_id": row["master_id"],
            "target_album_id": row["target_album_id"],
            "filename_track": row["filename_track"],
        }
        for row in selected
    ]
    (output / "snapshot_candidate.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    values = ",\n".join(
        f"  ({sql(r['master_id'])}, {sql(r['target_album_id'])}, {r['filename_track']})"
        for r in selected
    )
    preflight = f"""WITH expected(master_id, album_id, filename_track) AS (VALUES
{values}
), candidate AS (
  SELECT e.master_id, e.album_id, e.filename_track, sm.id AS actual_master_id, sm.album_id AS actual_album_id, sm.track, sm.disc
  FROM expected e LEFT JOIN song_masters sm ON sm.id=e.master_id
)
SELECT
  (SELECT COUNT(*) FROM expected) AS expected_masters,
  (SELECT COUNT(DISTINCT album_id) FROM expected) AS expected_albums,
  (SELECT COUNT(*) FROM candidate WHERE track IS NULL AND disc IS NULL) AS null_track_disc,
  (SELECT COUNT(*) FROM candidate WHERE track IS NOT NULL OR disc IS NOT NULL) AS stale_or_conflicting,
  (SELECT COUNT(*) FROM candidate WHERE actual_master_id IS NULL) AS missing_masters,
  (SELECT COUNT(*) FROM candidate WHERE actual_album_id=album_id) AS matching_album_membership,
  (SELECT COUNT(*) FROM candidate WHERE actual_master_id IS NOT NULL AND actual_album_id<>album_id) AS moved_or_wrong_album,
  (SELECT COUNT(*) FROM (SELECT album_id, filename_track, COUNT(*) n FROM expected GROUP BY album_id, filename_track HAVING n<>1)) AS duplicate_expected_indices;
"""
    (output / "primary_preflight.sql").write_text(preflight, encoding="utf-8")

    for offset in range(0, len(selected), 48):
        chunk = selected[offset : offset + 48]
        chunk_values = ",\n".join(
            f"  ({sql(r['master_id'])}, {sql(r['target_album_id'])}, {r['filename_track']})"
            for r in chunk
        )
        chunk_sql = f"""WITH expected(master_id, album_id, filename_track) AS (VALUES
{chunk_values}
)
SELECT e.master_id, e.album_id AS expected_album_id, e.filename_track,
       sm.id AS actual_master_id, sm.album_id AS actual_album_id, sm.track, sm.disc
FROM expected e LEFT JOIN song_masters sm ON sm.id=e.master_id
ORDER BY e.album_id, e.filename_track, e.master_id;
"""
        (output / f"primary_preflight_{offset // 48 + 1:02d}.sql").write_text(chunk_sql, encoding="utf-8")

    guard_values = ",\n".join(
        f"  ({sql(r['master_id'])}, {sql(r['target_album_id'])}, {r['filename_track']})"
        for r in selected
    )
    guarded_apply = f"""BEGIN TRANSACTION;
WITH expected(master_id, album_id, filename_track) AS (VALUES
{guard_values}
)
UPDATE song_masters
SET track=(SELECT e.filename_track FROM expected e WHERE e.master_id=song_masters.id),
    disc=1,
    updated_at=unixepoch()
WHERE id IN (SELECT master_id FROM expected)
  AND (SELECT COUNT(*) FROM song_masters sm JOIN expected e ON e.master_id=sm.id
       WHERE sm.album_id=e.album_id AND sm.track IS NULL AND sm.disc IS NULL)
      =(SELECT COUNT(*) FROM expected);
COMMIT;
"""
    guarded_rollback = f"""BEGIN TRANSACTION;
WITH expected(master_id, album_id, filename_track) AS (VALUES
{guard_values}
)
UPDATE song_masters
SET track=NULL, disc=NULL, updated_at=unixepoch()
WHERE id IN (SELECT master_id FROM expected)
  AND (SELECT COUNT(*) FROM song_masters sm JOIN expected e ON e.master_id=sm.id
       WHERE sm.album_id=e.album_id AND sm.track=e.filename_track AND sm.disc=1)
      =(SELECT COUNT(*) FROM expected);
COMMIT;
"""
    (output / "apply_guarded.sql").write_text(guarded_apply, encoding="utf-8")
    (output / "rollback_guarded.sql").write_text(guarded_rollback, encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
