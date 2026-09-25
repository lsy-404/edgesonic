import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mutagen.flac import FLAC
from mutagen.wave import WAVE


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("merge_flac_tags_to_wav", ROOT / "tools" / "merge_flac_tags_to_wav.py")
merge_tool = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(merge_tool)


def riff_chunk(kind: bytes, data: bytes) -> bytes:
    return kind + len(data).to_bytes(4, "little") + data + (b"\0" if len(data) & 1 else b"")


def write_wav(path: Path, tags: dict[str, str] | None = None, custom: dict[str, list[str]] | None = None,
              sample_rate: int = 48000) -> bytes:
    fmt = struct.pack("<HHIIHH", 1, 2, sample_rate, sample_rate * 4, 4, 16)
    pcm = bytes(range(64))
    chunks = riff_chunk(b"fmt ", fmt) + riff_chunk(b"JUNK", b"keep-this-vendor-data") + riff_chunk(b"data", pcm)
    if tags:
        path.write_bytes(b"RIFF" + (len(b"WAVE") + len(chunks)).to_bytes(4, "little") + b"WAVE" + chunks)
        audio = WAVE(str(path))
        audio.add_tags()
        for key, value in tags.items():
            audio.tags.add(merge_tool.TIT2(encoding=3, text=value))
        for key, values in (custom or {}).items():
            audio.tags.add(merge_tool.TXXX(encoding=3, desc=key, text=values))
        audio.tags.save(str(path), v2_version=4)
    elif custom:
        body = b"WAVE" + chunks
        path.write_bytes(b"RIFF" + len(body).to_bytes(4, "little") + body)
        audio = WAVE(str(path))
        audio.add_tags()
        for key, values in custom.items():
            audio.tags.add(merge_tool.TXXX(encoding=3, desc=key, text=values))
        audio.tags.save(str(path), v2_version=4)
    else:
        body = b"WAVE" + chunks
        path.write_bytes(b"RIFF" + len(body).to_bytes(4, "little") + body)
    return pcm


def flac_block(code: int, payload: bytes, last: bool = False) -> bytes:
    return bytes([(0x80 if last else 0) | code]) + len(payload).to_bytes(3, "big") + payload


def vorbis_comment(comments: list[str]) -> bytes:
    vendor = b"fixture"
    return len(vendor).to_bytes(4, "little") + vendor + len(comments).to_bytes(4, "little") + b"".join(
        len(item.encode()).to_bytes(4, "little") + item.encode() for item in comments
    )


def picture_block(desc: str, data: bytes, picture_type: int = 3) -> bytes:
    mime = b"image/png"
    desc_bytes = desc.encode()
    fields = [picture_type.to_bytes(4, "big"), len(mime).to_bytes(4, "big"), mime,
              len(desc_bytes).to_bytes(4, "big"), desc_bytes,
              (1).to_bytes(4, "big") * 4, len(data).to_bytes(4, "big"), data]
    return b"".join(fields)


def write_flac(path: Path, title: str = "FLAC title", app_block: bool = True, regenerable_blocks: bool = False) -> None:
    streaminfo = bytearray(34)
    sample_rate = 48000
    channels = 2
    bits = 16
    total_samples = 16
    packed = (sample_rate << 44) | ((channels - 1) << 41) | ((bits - 1) << 36) | total_samples
    streaminfo[10:18] = packed.to_bytes(8, "big")
    payload = b"fLaC" + flac_block(0, bytes(streaminfo))
    if app_block:
        payload += flac_block(2, b"APP1vendorpayload")
    if regenerable_blocks:
        payload += flac_block(3, b"\xff" * 8 + b"\0" * 10)
        payload += flac_block(1, b"\0" * 8)
    payload += flac_block(4, vorbis_comment([f"TITLE={title}", "ARTIST=FLAC Artist", "ARTIST=Guest Artist",
                                             "COMMENT=ExactAudioCopy v1.1", "COMMENT=second comment",
                                             "LYRICS=first lyric", "LYRICS=second lyric",
                                             "MOOD=calm", "MOOD=bright"]))
    payload += flac_block(6, picture_block("front", b"png-one"))
    payload += flac_block(6, picture_block("back", b"png-two", 4), last=True)
    payload += b"\xff\xf8\x00\x00"
    path.write_bytes(payload)


class FlacTagsToWavTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.flac = self.root / "source.flac"
        self.wav = self.root / "target.wav"
        self.output = self.root / "merged.wav"
        self.report = self.root / "merged.merge-report.json"
        write_flac(self.flac)
        self.pcm = write_wav(self.wav)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_merge(self, **kwargs):
        return merge_tool.merge(self.flac, self.wav, self.output, self.report, kwargs.get("resolutions", {}))

    def test_merge_round_trips_multivalues_pictures_and_preserves_riff_audio(self):
        status, report = self.run_merge()
        self.assertEqual(status, 0)
        output = WAVE(str(self.output))
        self.assertEqual(list(output.tags["TIT2"].text), ["FLAC title"])
        self.assertEqual(list(output.tags["TPE1"].text), ["FLAC Artist", "Guest Artist"])
        self.assertEqual(merge_tool.canonical_values(output.tags)["COMM"], ["ExactAudioCopy v1.1", "second comment"])
        self.assertEqual(merge_tool.canonical_values(output.tags)["USLT"], ["first lyric", "second lyric"])
        moods = [frame for frame in output.tags.getall("TXXX") if frame.desc == "MOOD"]
        self.assertEqual(moods[0].text, ["calm", "bright"])
        self.assertEqual([frame.data for frame in output.tags.getall("APIC")], [b"png-one", b"png-two"])
        self.assertEqual(merge_tool.audio_data_signature(merge_tool.riff_chunks(self.wav)),
                         merge_tool.audio_data_signature(merge_tool.riff_chunks(self.output)))
        self.assertEqual(merge_tool.non_id3_signature(merge_tool.riff_chunks(self.wav)),
                         merge_tool.non_id3_signature(merge_tool.riff_chunks(self.output)))
        self.assertFalse(report["flac_retention"]["metadata_preserved"])
        self.assertNotIn("can_delete", report["flac_retention"])
        self.assertTrue(report["flac_retention"]["external_pcm_match_required"])
        self.assertIn("APPLICATION", [b["name"] for b in report["unpreserved_flac_blocks"]])
        self.assertEqual(report["verification"]["passed"], True)
        self.assertTrue(self.report.exists())

    def test_conflict_aborts_audio_output_and_explicit_resolution_allows_it(self):
        self.pcm = write_wav(self.wav, {"title": "WAV title"})
        status, report = self.run_merge()
        self.assertEqual(status, 2)
        self.assertFalse(self.output.exists())
        self.assertEqual(report["conflicts"]["TIT2"], {"wav": ["WAV title"], "flac": ["FLAC title"]})
        self.assertFalse(report["flac_retention"]["metadata_preserved"])
        self.assertEqual(json.loads(self.report.read_text(encoding="utf-8"))["verification"]["status"], "aborted_unresolved_conflicts")

        resolved_output = self.root / "resolved.wav"
        resolved_report = self.root / "resolved.merge-report.json"
        status, report = merge_tool.merge(self.flac, self.wav, resolved_output, resolved_report, {"TIT2": "flac"})
        self.assertEqual(status, 0)
        self.assertEqual(WAVE(str(resolved_output)).tags["TIT2"].text, ["FLAC title"])

    def test_verification_failure_rolls_back_partial_output_and_records_report(self):
        original = merge_tool.riff_chunks
        calls = 0

        def fail_after_write(path):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise merge_tool.MergeError("injected verification failure")
            return original(path)

        with patch.object(merge_tool, "riff_chunks", side_effect=fail_after_write):
            with self.assertRaisesRegex(merge_tool.MergeError, "injected verification failure"):
                self.run_merge()
        self.assertFalse(self.output.exists())
        self.assertTrue(self.report.exists())
        data = json.loads(self.report.read_text(encoding="utf-8"))
        self.assertEqual(data["verification"]["status"], "failed_and_rolled_back")
        self.assertEqual(list(self.root.glob(".*.tmp.wav")), [])

    def test_existing_output_is_never_overwritten(self):
        self.output.write_bytes(b"keep")
        with self.assertRaisesRegex(merge_tool.MergeError, "refusing to overwrite"):
            self.run_merge()
        self.assertEqual(self.output.read_bytes(), b"keep")

    def test_streaminfo_equivalence_and_regenerable_blocks_are_reported(self):
        write_flac(self.flac, app_block=False, regenerable_blocks=True)
        status, report = self.run_merge()
        self.assertEqual(status, 0)
        self.assertTrue(report["audio_format_comparison"]["matches"])
        self.assertTrue(report["flac_retention"]["metadata_preserved"])
        self.assertTrue(report["flac_retention"]["external_pcm_match_required"])
        self.assertEqual(report["unpreserved_flac_blocks"], [])
        self.assertNotIn("can_delete", report["flac_retention"])

    def test_streaminfo_mismatch_prevents_metadata_preserved(self):
        write_wav(self.wav, sample_rate=44100)
        write_flac(self.flac, app_block=False, regenerable_blocks=True)
        status, report = self.run_merge()
        self.assertEqual(status, 0)
        self.assertFalse(report["audio_format_comparison"]["matches"])
        self.assertFalse(report["flac_retention"]["metadata_preserved"])
        self.assertIn("STREAMINFO", [block["name"] for block in report["unpreserved_flac_blocks"]])

    def test_custom_comment_conflict_also_requires_resolution(self):
        self.pcm = write_wav(self.wav, custom={"MOOD": ["quiet"]})
        status, report = self.run_merge()
        self.assertEqual(status, 2)
        self.assertIn("TXXX:MOOD", report["custom_comment_conflicts"])
        self.assertFalse(self.output.exists())

        resolved_output = self.root / "custom-resolved.wav"
        resolved_report = self.root / "custom-resolved.merge-report.json"
        status, report = merge_tool.merge(self.flac, self.wav, resolved_output, resolved_report,
                                          {"TXXX:MOOD": "flac"})
        self.assertEqual(status, 0)
        values = [frame.text for frame in WAVE(str(resolved_output)).tags.getall("TXXX") if frame.desc == "MOOD"]
        self.assertEqual(values, [["calm", "bright"]])


if __name__ == "__main__":
    unittest.main()
