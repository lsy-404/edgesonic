"""Build an isolated D1 fixture from the reviewed candidate snapshot."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def quote(value: object) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def main(snapshot_path: Path, output_path: Path) -> None:
    rows = json.loads(snapshot_path.read_text(encoding="utf-8"))
    statements = [
        "INSERT INTO albums(id,name,sort_name,year) VALUES('pending-uploads','Pending uploads','pending uploads',NULL);"
    ]
    for index, row in enumerate(rows, start=1):
        statements.extend(
            [
                "INSERT INTO song_masters(id,album_id,artist_id,title,track,disc,duration) VALUES(" + ",".join(
                    [quote(row["master_id"]), "'pending-uploads'", "'unknown-artist'", quote(row["title"]), "NULL", "NULL", str(180 + index)]
                ) + ");",
                "INSERT INTO storage_objects(id,physical_key,suffix,size) VALUES(" + ",".join(
                    [quote(row["object_id"]), quote(f"objects/{row['object_id']}.wav"), "'wav'", str(1000 + index)]
                ) + ");",
                "INSERT INTO song_instances(id,master_id,source_id,source_type,storage_object_id,suffix,size,duration,missing,tag_scanned,source_etag) VALUES(" + ",".join(
                    [quote(row["instance_id"]), quote(row["master_id"]), "'r2-local'", "'original'", quote(row["object_id"]), "'wav'", str(1000 + index), str(180 + index), "0", "1", quote(f"etag-{index}")]
                ) + ");",
                "INSERT INTO storage_entries(id,parent_id,path,kind,object_id,instance_id) VALUES(" + ",".join(
                    [quote(row["entry_id"]), quote(row["parent_id"]), quote(row["path"]), "'file'", quote(row["object_id"]), quote(row["instance_id"])]
                ) + ");",
            ]
        )
    output_path.write_text("\n".join(statements) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
