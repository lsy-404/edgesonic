import argparse
import json
import os
import re
import tomllib
import urllib.error
import urllib.request
from pathlib import Path


def repo_root(start: Path) -> Path:
    for parent in (start, *start.parents):
        if (parent / "worker").is_dir() and (parent / "test").is_dir():
            return parent
    raise RuntimeError("Could not locate worker/wrangler.toml")


def validate(sql: str) -> None:
    if ";" in sql:
        raise ValueError("One statement per query file; semicolon is disallowed")
    words = re.findall(r"[A-Za-z_][A-Za-z_0-9]*", sql.upper())
    if not words or words[0] not in {"SELECT", "WITH", "PRAGMA"}:
        raise ValueError("Only read-only SELECT/WITH or approved PRAGMA statements are accepted")
    forbidden = {"INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "VACUUM", "ATTACH", "DETACH", "REINDEX", "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK"}
    if forbidden.intersection(words):
        raise ValueError("Mutation token found in read-only statement")
    if words[0] == "PRAGMA" and not re.fullmatch(r"PRAGMA\s+(foreign_key_check|quick_check)\s*", sql, re.I):
        raise ValueError("Unsupported read-only pragma")
    if len(sql.encode("utf-8")) >= 100_000:
        raise ValueError("SQL statement exceeds the API request limit")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queries", required=True, type=Path, help="JSON object mapping safe names to read-only SQL")
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--stem", required=True, help="Unique capture stem")
    parser.add_argument("--wrangler-config", type=Path, help="Path to the local Wrangler config when the checkout has no local config")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9_-]+", args.stem):
        raise ValueError("Invalid capture stem")
    queries = json.loads(args.queries.read_text(encoding="utf-8"))
    if not isinstance(queries, dict) or not queries:
        raise ValueError("Query input must be a nonempty object")
    for name, sql in queries.items():
        if not re.fullmatch(r"[a-z0-9_]+", name) or not isinstance(sql, str):
            raise ValueError("Invalid query name or SQL value")
        validate(sql)
    root = repo_root(Path(__file__).resolve())
    config_path = args.wrangler_config or (root / "worker" / "wrangler.toml")
    wrangler = tomllib.loads(config_path.read_text(encoding="utf-8"))
    db = next(item for item in wrangler["d1_databases"] if item["database_name"] == "edgesonic-db")
    account = wrangler["account_id"]
    auth_path = Path(os.environ["LOCALAPPDATA"]) / "XDGConfig" / ".wrangler" / "config" / "default.toml"
    auth = tomllib.loads(auth_path.read_text(encoding="utf-8"))
    token = auth["oauth_token"]
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db['database_id']}/query"
    args.out_dir.mkdir(parents=True, exist_ok=True)
    output = {"status": "READ_ONLY_PRIMARY_CAPTURE", "database_name": db["database_name"], "captures": {}}
    for name, sql in queries.items():
        req = urllib.request.Request(endpoint, data=json.dumps({"sql": sql}).encode("utf-8"), method="POST", headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                response_json = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Primary read failed for {name}: HTTP {error.code}") from None
        if not response_json.get("success"):
            raise RuntimeError(f"Primary read failed for {name}")
        receipts = response_json["result"]
        if isinstance(receipts, dict):
            receipts = [receipts]
        if not receipts or any(not item.get("success") or not item.get("meta", {}).get("served_by_primary") or item["meta"].get("rows_written") != 0 or item["meta"].get("changed_db") for item in receipts):
            raise RuntimeError(f"Read-only primary assertions failed for {name}")
        flattened = [row for receipt in receipts for row in receipt["results"]]
        out_file = args.out_dir / f"{args.stem}_{name}.json"
        out_file.write_text(json.dumps({"sql": sql, "receipts": receipts, "rows": flattened}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        output["captures"][name] = {"path": out_file.name, "rows": len(flattened), "primary": True, "rows_written": 0}
    (args.out_dir / f"{args.stem}_manifest.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
