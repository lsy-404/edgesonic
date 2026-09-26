import json
from pathlib import Path

base = Path(__file__).parent
rows = json.loads((base / "rose_primary_snapshot.json").read_text(encoding="utf-8"))
values = []
for row in rows:
    text = [row[key].replace("'", "''") for key in ("master_id", "instance_id", "object_id", "entry_id", "path", "display_name", "physical_key", "title")]
    values.append("('%s','%s','%s','%s','%s','%s','%s','%s',%d,%d,%d)" % (*text, row["duration"], row["size"], row["track"]))
(base / "artifacts" / "rose_snapshot_values.sql").write_text("-- production primary snapshot\nVALUES\n" + ",\n".join(values) + ";\n", encoding="utf-8")
