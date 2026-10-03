import importlib.util
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("stage_yequ_wav_native_union_v2.py")


class SourceDriveGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old_audit = os.environ.get("YEQ_AUDIT_DIR")
        with tempfile.TemporaryDirectory() as temporary:
            os.environ["YEQ_AUDIT_DIR"] = temporary
            spec = importlib.util.spec_from_file_location("yequ_stage", SCRIPT)
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)
        if cls._old_audit is None:
            os.environ.pop("YEQ_AUDIT_DIR", None)
        else:
            os.environ["YEQ_AUDIT_DIR"] = cls._old_audit

    def test_approved_path_stays_lexical_on_z(self):
        result = self.module.lexical_z_path(
            r"Z:\approved\collection\release\audio.zip",
            r"Z:\approved\collection",
        )
        self.assertEqual(result.drive.upper(), "Z:")
        self.assertTrue(str(result).casefold().startswith(r"z:\approved\collection".casefold()))

    def test_wrong_drive_is_rejected_before_any_filesystem_probe(self):
        with patch.object(Path, "is_file", side_effect=AssertionError("filesystem probe happened before guard")):
            with self.assertRaises(SystemExit):
                self.module.archive_members(Path(r"F:\private\source.zip"), Path(r"Z:\approved"), ".wav")

    def test_zip_reader_receives_the_literal_z_path(self):
        class FakeArchive:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def infolist(self):
                return [zipfile.ZipInfo(f"{track:02d} track.wav") for track in range(1, 13)]

        raw_archive = r"Z:\approved\collection\release.zip"
        with patch.object(Path, "is_file", return_value=True):
            with patch.object(self.module.zipfile, "ZipFile", return_value=FakeArchive()) as reader:
                found = self.module.archive_members(
                    Path(raw_archive),
                    Path(r"Z:\approved\collection"),
                    ".wav",
                )
        self.assertEqual(set(found), set(range(1, 13)))
        opened_path = reader.call_args.args[0]
        self.assertEqual(opened_path.drive.upper(), "Z:")
        self.assertEqual(str(opened_path), os.path.normpath(os.path.abspath(raw_archive)))

    def test_parent_traversal_is_rejected(self):
        with self.assertRaises(SystemExit):
            self.module.lexical_z_path(r"Z:\approved\..\outside\source.zip", r"Z:\approved")

    def test_path_outside_approved_z_root_is_rejected(self):
        with self.assertRaises(SystemExit):
            self.module.lexical_z_path(r"Z:\other\source.zip", r"Z:\approved")


if __name__ == "__main__":
    unittest.main()
