import argparse
import hashlib
import json
import time
from collections import defaultdict
from pathlib import Path


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, str):
        return "CAST(X'" + value.encode('utf-8').hex() + "' AS TEXT)"
    assert isinstance(value, (int, float))
    return repr(value)


def row_match(table, row):
    return '(SELECT COUNT(*) FROM ' + table + ' WHERE ' + ' AND '.join(
        '"' + key + '" IS ' + literal(value) for key, value in row.items()) + ')=1'


def guard(condition):
    return "INSERT INTO work_queue(id,task_type,payload,status) SELECT 'aggregate-guard','catalog_aggregate','{}','guard_failed' WHERE NOT (" + condition + ');'


def guarded_rows(table, rows):
    result = []
    for offset in range(0, len(rows), 40):
        result.append(guard(' AND '.join(row_match(table, row) for row in rows[offset:offset + 40])))
    return result


def save_json(path, value):
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def build(bundle_path, output):
    raw = bundle_path.read_bytes()
    bundle = json.loads(raw)
    assert bundle['primary_read_only'] and not bundle['integrity']['foreign_key_check']
    assert bundle['integrity']['quick_check'] == [{'quick_check': 'ok'}]
    tables = bundle['tables']
    assert not tables['active_jobs']
    output.mkdir(parents=True, exist_ok=False)
    stamp = int(time.time())
    assert bundle['finished_at'] <= stamp
    albums = tables['albums']
    masters = tables['song_masters']
    instances = tables['song_instances']
    credits = tables['song_artists']
    artists = tables['artists']
    totals = defaultdict(lambda: {'song_count': 0, 'duration': 0, 'size': 0})
    by_master = {row['id']: row for row in masters}
    for master in masters:
        totals[master['album_id']]['song_count'] += 1
        totals[master['album_id']]['duration'] += master['duration'] or 0
    for instance in instances:
        totals[by_master[instance['master_id']]['album_id']]['size'] += instance['size'] or 0
    changed = []
    for album in albums:
        target = totals[album['id']]
        if any(album[key] != value for key, value in target.items()):
            changed.append({'before': album, 'after': {**album, **target, 'updated_at': stamp}})
    playable = {row['master_id'] for row in instances if row['missing'] == 0}
    artist_ids = set()
    for master_id in playable:
        master = by_master[master_id]
        artist_ids.add(master['artist_id'])
        artist_ids.add(master['album_artist_id'])
    artist_ids.update(row['artist_id'] for row in credits if row['song_id'] in playable)
    assert len(tables['library_stats_cache']) == 1
    cache_before = tables['library_stats_cache'][0]
    cache_after = {**cache_before, 'artists': len(artist_ids & {x['id'] for x in artists}),
                   'albums': len({by_master[mid]['album_id'] for mid in playable} & {x['id'] for x in albums}),
                   'songs': len(playable), 'dirty': 0, 'updated_at': stamp}
    inputs = {
        'song_masters': [{k: row[k] for k in ('id', 'album_id', 'artist_id', 'album_artist_id', 'duration')} for row in masters],
        'song_instances': [{k: row[k] for k in ('id', 'master_id', 'size', 'missing')} for row in instances],
        'song_artists': credits,
        'artists': [{'id': row['id']} for row in artists],
    }
    common_guards = [guard("NOT EXISTS(SELECT 1 FROM work_queue WHERE status IN ('queued','claimed'))")]
    common_guards.append(guard(' AND '.join('(SELECT COUNT(*) FROM ' + table + ')=' + str(len(rows)) for table, rows in inputs.items())
                               + ' AND (SELECT COUNT(*) FROM albums)=' + str(len(albums))))
    for table, rows in inputs.items():
        common_guards.extend(guarded_rows(table, rows))
    before_albums = guarded_rows('albums', albums)
    after_by_id = {row['after']['id']: row['after'] for row in changed}
    after_albums = guarded_rows('albums', [after_by_id.get(row['id'], row) for row in albums])
    cache_guard_before = guard(row_match('library_stats_cache', cache_before))
    cache_guard_after = guard(row_match('library_stats_cache', cache_after))
    updates, reversals = [], []
    for pair in changed:
        for row, destination in ((pair['after'], updates), (pair['before'], reversals)):
            destination.append('UPDATE albums SET ' + ','.join('"' + key + '"=' + literal(row[key]) for key in ('song_count', 'duration', 'size', 'updated_at'))
                               + ' WHERE id=' + literal(row['id']) + ';')
    def cache_update(row):
        return 'UPDATE library_stats_cache SET ' + ','.join('"' + key + '"=' + literal(row[key]) for key in ('artists', 'albums', 'songs', 'updated_at', 'dirty')) + ' WHERE id=1;'
    formula_guard = guard('NOT EXISTS(SELECT 1 FROM albums a WHERE a.song_count IS NOT (SELECT COUNT(*) FROM song_masters sm WHERE sm.album_id=a.id)'
        ' OR a.duration IS NOT (SELECT COALESCE(SUM(duration),0) FROM song_masters sm WHERE sm.album_id=a.id)'
        ' OR a.size IS NOT (SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=a.id))')
    apply = common_guards + before_albums + [cache_guard_before] + updates + [cache_update(cache_after)] + after_albums + [cache_guard_after, formula_guard]
    rollback = common_guards + after_albums + [cache_guard_after] + reversals + [cache_update(cache_before)] + before_albums + [cache_guard_before]
    hashes = {}
    for name, statements in (('apply.sql', apply), ('rollback.sql', rollback)):
        assert all(len(line.encode('utf-8')) < 100000 for line in statements)
        data = ('\n'.join(statements) + '\n').encode('utf-8')
        (output / name).write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    manifest = {'bundle_sha256': hashlib.sha256(raw).hexdigest(), 'write_epoch': stamp, 'changed_albums': changed,
                'cache_before': cache_before, 'cache_after': cache_after, 'input_counts': {k: len(v) for k, v in inputs.items()},
                'sql_sha256': hashes, 'scope': 'album song count, master duration, all instance sizes and playable library counts',
                'no_media_or_identity_mutation': True}
    hashes['manifest.json'] = save_json(output / 'manifest.json', manifest)
    print(json.dumps({'changed_albums': len(changed), 'write_epoch': stamp, 'sha256': hashes}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    build(arguments.bundle, arguments.output)
