import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  createStableObjectId,
  createStableObjectKey,
  normalizeEntryPath,
  normalizeSuffix,
  splitEntryPath,
} from '../../worker/src/utils/storageObjects.ts';

const root = process.cwd();
const schema = readFileSync(join(root, 'worker/migrations/Schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'worker/migrations/0037_r2_d1_storage_objects.sql'), 'utf8');

test('stable object keys retain normalized suffixes', () => {
  const id = createStableObjectId('content-hash:abc');
  assert.equal(id, createStableObjectId('content-hash:abc'));
  assert.equal(createStableObjectKey(id, '.FLAC'), `objects/${id}.flac`);
  assert.equal(normalizeSuffix(' .Mp3 '), 'mp3');
});

test('logical entry paths normalize separators and dot segments', () => {
  assert.equal(normalizeEntryPath('/artists\\A/./album/../song.flac/'), 'artists/A/song.flac');
  assert.deepEqual(splitEntryPath('artists/A/song.flac'), {
    parentPath: 'artists/A',
    displayName: 'song.flac',
  });
  assert.throws(() => normalizeEntryPath('../song.flac'));
});

test('schema declares the stable object and entry model contract', () => {
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS storage_objects/);
    assert.match(source, /physical_key TEXT NOT NULL UNIQUE/);
    assert.match(source, /legacy_key TEXT UNIQUE/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS storage_entries/);
    assert.match(source, /path TEXT NOT NULL/);
    assert.match(source, /kind TEXT NOT NULL CHECK \(kind IN \('folder', 'file'\)\)/);
    assert.match(source, /COALESCE\(parent_id, ''\), display_name/);
    assert.match(source, /idx_storage_entries_source_path/);
    assert.match(source, /ON storage_entries\(source_id, path\)/);
    assert.match(source, /idx_storage_objects_legacy_key/);
    assert.match(source, /idx_storage_entries_parent/);
    assert.match(source, /idx_storage_entries_object/);
    assert.match(source, /idx_storage_entries_instance/);
  }
  assert.match(schema, /storage_object_id TEXT/);
  assert.match(schema, /storage_uri TEXT NOT NULL/);
  assert.match(migration, /ALTER TABLE song_instances ADD COLUMN storage_object_id TEXT/);
});
