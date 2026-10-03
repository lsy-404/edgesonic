import argparse
import hashlib
import json
import re
import sqlite3
from pathlib import Path


def split_sql(raw):
    text = raw.decode("utf-8")
    statements = []
    current = ""
    for character in text:
        current += character
        if character == ";" and sqlite3.complete_statement(current):
            statements.append(current)
            current = ""
    if current.strip():
        raise ValueError("SQL source has an incomplete tail")
    if current and statements:
        statements[-1] += current
    if b"".join(item.encode("utf-8") for item in statements) != raw:
        raise ValueError("SQL source is incomplete or was not preserved byte for byte")
    return statements


def guards(raw, prefix, guard_prefix="guard-yuesi-"):
    result = []
    for index, statement in enumerate(split_sql(raw)):
        if guard_prefix not in statement:
            continue
        insert_at = statement.find("INSERT INTO work_queue")
        select_at = statement.find("SELECT ", insert_at)
        if insert_at < 0 or select_at < 0:
            raise ValueError("Guard statement is not the expected fail-closed sentinel")
        candidates = [position for marker in ("\nWHERE ", " WHERE ") if (position := statement.find(marker, select_at)) >= 0]
        if not candidates:
            raise ValueError("Cannot locate the outer guard WHERE clause")
        where_at = min(candidates)
        marker_length = len("\nWHERE ") if statement.startswith("\nWHERE ", where_at) else len(" WHERE ")
        semicolon = statement.rfind(";")
        condition = statement[where_at + marker_length:semicolon].strip()
        cte_prefix = statement[:insert_at]
        readonly = cte_prefix + "SELECT NOT (" + condition + ") AS guard_pass"
        name_match = re.search(re.escape(guard_prefix) + r"[^']+?-([^']+)", statement)
        name = name_match.group(1) if name_match else str(index)
        kind = "rollback" if "rollback" in name else ("post" if name.startswith("post_") else "pre")
        result.append({
            "name": f"{prefix}_{index:03}_{name}",
            "kind": kind,
            "source_statement_sha256": hashlib.sha256(statement.encode("utf-8")).hexdigest(),
            "sql": readonly,
            "sql_sha256": hashlib.sha256(readonly.encode("utf-8")).hexdigest(),
        })
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", required=True, type=Path)
    parser.add_argument("--rollback", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    apply_raw = args.apply.read_bytes()
    rollback_raw = args.rollback.read_bytes()
    result = {
        "apply_sha256": hashlib.sha256(apply_raw).hexdigest(),
        "rollback_sha256": hashlib.sha256(rollback_raw).hexdigest(),
        "queries": guards(apply_raw, "apply") + guards(rollback_raw, "rollback"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"query_count": len(result["queries"]), "apply_sha256": result["apply_sha256"], "rollback_sha256": result["rollback_sha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
