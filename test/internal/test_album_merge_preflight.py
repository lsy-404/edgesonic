from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import album_merge_preflight as preflight


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class AlbumMergePreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db_path = self.root / "snapshot.sqlite"
        db = sqlite3.connect(self.db_path)
        db.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE storage_objects(id TEXT PRIMARY KEY, physical_key TEXT UNIQUE, suffix TEXT, size INTEGER, etag TEXT);
            CREATE TABLE song_masters(id TEXT PRIMARY KEY, album_id TEXT, title TEXT);
            CREATE TABLE song_instances(id TEXT PRIMARY KEY, master_id TEXT REFERENCES song_masters(id), storage_object_id TEXT REFERENCES storage_objects(id), storage_uri TEXT, suffix TEXT, size INTEGER);
            CREATE TABLE storage_entries(id TEXT PRIMARY KEY, object_id TEXT REFERENCES storage_objects(id), instance_id TEXT REFERENCES song_instances(id), companion_of TEXT REFERENCES storage_entries(id), path TEXT, display_name TEXT);
            CREATE TABLE playlist_songs(playlist_id TEXT, song_master_id TEXT REFERENCES song_masters(id), position INTEGER);
            CREATE TABLE annotations(user_id TEXT, item_id TEXT, item_type TEXT, starred INTEGER);
            CREATE TABLE play_queues(user_id TEXT, song_ids TEXT, current_id TEXT);
            CREATE TABLE work_queue(id TEXT PRIMARY KEY, status TEXT, payload TEXT, result_json TEXT);
            INSERT INTO storage_objects VALUES ('obj-wav','objects/wav.wav','wav',3,'wav-etag');
            INSERT INTO storage_objects VALUES ('obj-flac','objects/flac.flac','flac',4,'flac-etag');
            INSERT INTO song_masters VALUES ('master-1','album-1','Song');
            INSERT INTO song_instances VALUES ('inst-wav','master-1','obj-wav','r2://objects/wav.wav','wav',3);
            INSERT INTO song_instances VALUES ('inst-flac','master-1','obj-flac','r2://objects/flac.flac','flac',4);
            INSERT INTO storage_entries VALUES ('entry-wav','obj-wav','inst-wav',NULL,'album/song.wav','song.wav');
            INSERT INTO storage_entries VALUES ('entry-flac','obj-flac','inst-flac',NULL,'album/song.flac','song.flac');
            INSERT INTO storage_entries VALUES ('entry-share','obj-wav',NULL,'entry-wav','sidecar/song.jpg','song.jpg');
            INSERT INTO playlist_songs VALUES ('playlist-1','master-1',1);
            INSERT INTO annotations VALUES ('alice','master-1','song',1);
            INSERT INTO play_queues VALUES ('alice','["master-1", "master-other"]','master-1');
            INSERT INTO work_queue VALUES ('work-1','queued','{"instance_id":"inst-flac"}',NULL);
            INSERT INTO work_queue VALUES ('work-other','queued','{"instance_id":"unrelated"}',NULL);
        """)
        db.commit()
        db.close()
        self.wav = self.root / "wav.cache"
        self.wav.write_bytes(b"wav")
        self.flac = self.root / "flac.cache"
        self.flac.write_bytes(b"flac")
        self.merged = self.root / "merged.wav"
        self.merged.write_bytes(b"merged")
        self.report_path = self.root / "tag-report.json"
        self.report_path.write_text(json.dumps(self.report()), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def report(self) -> dict:
        return {
            "inputs": {
                "wav": {"sha256": digest(b"wav")},
                "flac": {"sha256": digest(b"flac")},
            },
            "output": {"path": str(self.merged.resolve()), "sha256": digest(b"merged"), "size": len(b"merged"), "written": True},
            "verification": {
                "passed": True,
                "pcm_data_chunks_unchanged": True,
                "non_id3_riff_chunks_unchanged": True,
                "pictures": True,
            },
            "flac_retention": {"metadata_preserved": True},
            "audio_format_comparison": {"matches": True},
            "unmapped_fields": [],
            "unmapped_fields_preserved_as_txxx": [],
            "conflicts": {},
            "resolutions": {},
            "unpreserved_flac_blocks": [],
            "unpreserved_pictures": [],
        }

    def pair(self) -> dict:
        return {
            "label": "sample track",
            "wav_cache": {"path": str(self.wav), "physical_key": "objects/wav.wav", "sha256": digest(b"wav")},
            "flac_cache": {"path": str(self.flac), "physical_key": "objects/flac.flac", "sha256": digest(b"flac")},
            "merged_wav": str(self.merged),
            "tag_merge_report": str(self.report_path),
        }

    @patch.object(preflight, "pcm_signature")
    @patch.object(preflight, "probe_stream")
    def test_collects_read_only_references_and_validates_report_and_pcm(self, probe, pcm) -> None:
        stream = {"sample_rate": 44100, "channels": 2}
        probe.return_value = stream
        pcm.return_value = {**stream, "frames": 8, "bytes": 64, "sha256": digest(b"same pcm"), "normalization": "test"}
        input_hashes = {path: digest(path.read_bytes()) for path in (self.db_path, self.wav, self.flac, self.merged, self.report_path)}
        db = preflight.open_snapshot(self.db_path)
        try:
            result = preflight.preflight_pair(db, self.pair(), "ffmpeg", "ffprobe")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0], 2)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("DELETE FROM storage_objects")
        finally:
            db.close()
        self.assertEqual(result["status"], "ready_for_manual_review")
        refs = result["d1_references"]
        self.assertEqual({row["id"] for row in refs["song_instances"]}, {"inst-wav", "inst-flac"})
        self.assertEqual({row["id"] for row in refs["song_masters"]}, {"master-1"})
        self.assertEqual({row["id"] for row in refs["storage_entries"]}, {"entry-wav", "entry-flac", "entry-share"})
        self.assertEqual(refs["same_master_ids_between_wav_and_flac"], ["master-1"])
        associations = refs["impacted_associations"]
        self.assertEqual(len(associations["annotations_song_rows"]), 1)
        self.assertEqual(len(associations["play_queues"]), 1)
        self.assertEqual([row["id"] for row in associations["work_queue_rows"]], ["work-1"])
        for path, expected in input_hashes.items():
            self.assertEqual(digest(path.read_bytes()), expected)

    @patch.object(preflight, "pcm_signature")
    @patch.object(preflight, "probe_stream")
    def test_wrong_expected_cache_hash_and_unresolved_conflict_block_candidate(self, probe, pcm) -> None:
        stream = {"sample_rate": 44100, "channels": 2}
        probe.return_value = stream
        pcm.return_value = {**stream, "frames": 4, "bytes": 32, "sha256": digest(b"same"), "normalization": "test"}
        pair = self.pair()
        pair["wav_cache"]["sha256"] = "0" * 64
        report = self.report()
        report["conflicts"] = {"TIT2": {"wav": ["a"], "flac": ["b"]}}
        self.report_path.write_text(json.dumps(report), encoding="utf-8")
        db = preflight.open_snapshot(self.db_path)
        try:
            result = preflight.preflight_pair(db, pair, "ffmpeg", "ffprobe")
        finally:
            db.close()
        self.assertEqual(result["status"], "blocked")
        self.assertIn("wav_cache_sha_matches_expected", result["blockers"])
        self.assertIn("tag_conflicts_resolved", result["blockers"])

    def test_candidate_input_requires_known_physical_key_and_expected_sha(self) -> None:
        db = preflight.open_snapshot(self.db_path)
        try:
            with self.assertRaises(preflight.PreflightError):
                preflight.validate_cache(db, {"path": str(self.wav), "physical_key": "invented", "sha256": digest(b"wav")}, "wav")
        finally:
            db.close()

    def test_manifest_write_is_create_only(self) -> None:
        target = self.root / "manifest.json"
        preflight.write_new_json(target, {"ok": True})
        original = target.read_bytes()
        with self.assertRaises(preflight.PreflightError):
            preflight.write_new_json(target, {"ok": False})
        self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
