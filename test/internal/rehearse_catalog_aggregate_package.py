import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

from rehearse_cop_d1_package import insert_rows, snapshot, split_sql, run_transaction, expect_reject


def fixture(bundle):
    connection = sqlite3.connect(':memory:')
    connection.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100000)
    connection.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
    schema = bundle['schema']
    for row in schema:
        if row['type'] == 'table' and row['sql'] and row['name'] != 'sqlite_sequence':
            connection.execute(row['sql'])
    table_names = sorted(row['name'] for row in schema if row['type'] == 'table')
    for table, rows in bundle['tables'].items():
        if table in table_names:
            insert_rows(connection, table, rows)
    connection.commit()
    connection.execute('PRAGMA foreign_keys=ON')
    assert connection.execute('PRAGMA foreign_keys').fetchone()[0] == 1
    for kind in ('index', 'trigger'):
        for row in schema:
            if row['type'] == kind and row['sql']:
                connection.execute(row['sql'])
    assert not connection.execute('PRAGMA foreign_key_check').fetchall()
    assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    return connection, table_names


def expected_rows(connection, table, before, changes):
    columns = [row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')]
    position = columns.index('id')
    updated = []
    for row in before:
        replacement = changes.get(row[position])
        if replacement:
            current = dict(zip(columns, row))
            current.update(replacement)
            updated.append(tuple(current[column] for column in columns))
        else:
            updated.append(row)
    return sorted(updated, key=lambda row: json.dumps(row, ensure_ascii=True, default=str))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    assert not args.out.exists()
    bundle_raw = args.bundle.read_bytes()
    bundle = json.loads(bundle_raw)
    manifest = json.loads((args.package / 'manifest.json').read_bytes())
    assert hashlib.sha256(bundle_raw).hexdigest() == manifest['bundle_sha256']
    files = {}
    for name in ('apply.sql', 'rollback.sql'):
        raw = (args.package / name).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == manifest['sql_sha256'][name]
        assert b'unixepoch(' not in raw.lower()
        files[name] = split_sql(raw)
    connection, tables = fixture(bundle)
    original = snapshot(connection, tables)
    computed = connection.execute('SELECT a.id,a.song_count,a.duration,a.size,'
        '(SELECT COUNT(*) FROM song_masters sm WHERE sm.album_id=a.id),'
        '(SELECT COALESCE(SUM(duration),0) FROM song_masters sm WHERE sm.album_id=a.id),'
        '(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=a.id)'
        ' FROM albums a ORDER BY a.id').fetchall()
    changes = {row[0]: {'song_count': row[4], 'duration': row[5], 'size': row[6], 'updated_at': manifest['write_epoch']}
               for row in computed if tuple(row[1:4]) != tuple(row[4:7])}
    assert set(changes) == {x['before']['id'] for x in manifest['changed_albums']}
    counts = connection.execute('WITH playable AS (SELECT DISTINCT sm.id,sm.album_id,sm.artist_id,sm.album_artist_id'
        ' FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE si.missing=0),'
        ' referenced AS (SELECT artist_id AS id FROM playable UNION SELECT album_artist_id FROM playable'
        ' UNION SELECT sa.artist_id FROM song_artists sa JOIN playable p ON sa.song_id=p.id)'
        ' SELECT (SELECT COUNT(*) FROM artists a JOIN referenced r ON r.id=a.id),'
        '(SELECT COUNT(DISTINCT p.album_id) FROM playable p JOIN albums a ON a.id=p.album_id),'
        '(SELECT COUNT(*) FROM playable)').fetchone()
    expected_cache = {**manifest['cache_before'], 'artists': counts[0], 'albums': counts[1], 'songs': counts[2],
                      'dirty': 0, 'updated_at': manifest['write_epoch']}
    assert manifest['cache_after'] == expected_cache
    expected = {table: list(rows) for table, rows in original.items()}
    expected['albums'] = expected_rows(connection, 'albums', original['albums'], changes)
    expected['library_stats_cache'] = expected_rows(connection, 'library_stats_cache', original['library_stats_cache'], {1: expected_cache})
    run_transaction(connection, files['apply.sql'])
    assert snapshot(connection, tables) == expected
    assert not connection.execute('PRAGMA foreign_key_check').fetchall()
    assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    expect_reject(connection, files['apply.sql'], tables, 'replay')
    run_transaction(connection, files['rollback.sql'])
    assert snapshot(connection, tables) == original
    expect_reject(connection, files['apply.sql'] + ["INSERT INTO work_queue(id,task_type,payload,status) VALUES('late-failure','metadata','{}','guard_failed');"], tables, 'late_failure')
    tests = ['exact_all_table_afterimage', 'replay_rejected', 'exact_rollback', 'atomic_late_failure']
    for label, mutation in (
        ('stale_duration', "UPDATE song_masters SET duration=COALESCE(duration,0)+1 WHERE id=(SELECT id FROM song_masters LIMIT 1)"),
        ('stale_size', "UPDATE song_instances SET size=COALESCE(size,0)+1 WHERE id=(SELECT id FROM song_instances LIMIT 1)"),
        ('stale_credit', "DELETE FROM song_artists WHERE rowid=(SELECT rowid FROM song_artists LIMIT 1)"),
        ('stale_album', "UPDATE albums SET name=name||'changed' WHERE id=(SELECT id FROM albums LIMIT 1)"),
        ('stale_cache', 'UPDATE library_stats_cache SET updated_at=updated_at+1 WHERE id=1'),
        ('active_work', "INSERT INTO work_queue(id,task_type,payload,status) VALUES('active','metadata','{}','queued')"),
    ):
        stale, stale_tables = fixture(bundle)
        expect_reject(stale, files['apply.sql'], stale_tables, label, lambda db: db.execute(mutation))
        stale.close()
        tests.append(label)
    result = {'status': 'PASS', 'tables': len(tables), 'triggers': connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0],
              'changed_albums': len(changes), 'runtime_clock_overridden': False, 'write_epoch': manifest['write_epoch'],
              'tests': tests, 'bundle_sha256': manifest['bundle_sha256'], 'sql_sha256': manifest['sql_sha256']}
    args.out.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
