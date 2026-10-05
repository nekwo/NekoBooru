import asyncio
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


class PerformancePathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)

    def test_vocabulary_thresholds_per_category_in_one_pass(self):
        from app.services.auto_tagger import _TagVocabulary

        vocab = _TagVocabulary(
            ["blue_eyes", "hatsune_miku", None, "explicit", "best quality", "weak"],
            ["general", "character", "general", "rating", "quality", "general"],
        )
        limits = {"general": 0.5, "character": 0.9, "rating": 0.01, "quality": None}
        passing = vocab.passing([0.6, 0.95, 0.99, 0.02, 0.99, 0.4], limits.get)

        # The missing name never passes, nor does a category with no limit.
        self.assertEqual(passing, [0, 1, 3])
        self.assertEqual(vocab.tags[1], "hatsune_miku")
        self.assertEqual(vocab.qualified[0], None)

    def test_vocabulary_handles_more_scores_than_tags(self):
        from app.services.auto_tagger import _TagVocabulary

        vocab = _TagVocabulary(["a", "b"], ["general", "general"])
        self.assertEqual(vocab.passing([0.9, 0.9, 0.9, 0.9], lambda _category: 0.5), [0, 1])

    def test_source_image_is_shrunk_once_and_shared(self):
        from PIL import Image
        from app.services import auto_tagger

        with tempfile.TemporaryDirectory() as tmp:
            panorama = Path(tmp) / "panorama.png"
            Image.new("RGB", (9000, 2400), (10, 120, 200)).save(panorama)
            first = auto_tagger._source_rgb(panorama)
            second = auto_tagger._source_rgb(panorama)

            self.assertIs(first, second)
            # Shrunk, but the short side stays above what a squashing model needs.
            self.assertLessEqual(max(first.size), 9000)
            self.assertGreaterEqual(min(first.size), auto_tagger.TAGGER_SOURCE_MIN_SIDE)
            self.assertEqual(first.mode, "RGB")

            small = Path(tmp) / "small.png"
            Image.new("RGBA", (300, 200), (0, 0, 0, 0)).save(small)
            self.assertEqual(auto_tagger._source_rgb(small).size, (300, 200))

            # A rewritten file is decoded again, not served from the cache.
            Image.new("RGB", (640, 480), "white").save(small)
            self.assertEqual(auto_tagger._source_rgb(small).size, (640, 480))

    def test_restart_waiter_returns_when_the_old_process_exits(self):
        from app.process_wait import wait_for_exit

        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.5)"])
        start = time.monotonic()
        self.assertTrue(wait_for_exit(proc.pid, timeout=10))
        self.assertLess(time.monotonic() - start, 5)
        proc.wait()

        lingering = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
        try:
            self.assertFalse(wait_for_exit(lingering.pid, timeout=0.3))
        finally:
            lingering.kill()
            lingering.wait()

    def test_progress_stream_ends_with_its_job(self):
        from app.services import upload_jobs

        async def collect():
            with patch.object(upload_jobs, "snapshot", AsyncMock(return_value={"id": "j", "status": "completed"})):
                return [payload async for payload in upload_jobs.subscribe("j")]

        self.assertEqual(asyncio.run(collect()), [{"id": "j", "status": "completed"}])

    def test_ytdlp_startup_update_runs_at_most_daily(self):
        from app.services import ytdlp_manager

        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "ytdlp-startup-update"
            with patch.object(ytdlp_manager, "_startup_marker", return_value=marker):
                self.assertTrue(ytdlp_manager._startup_update_due("latest"))
                ytdlp_manager._record_startup_update("latest")
                self.assertFalse(ytdlp_manager._startup_update_due("latest"))
                # A different pin is a reason to run again straight away.
                self.assertTrue(ytdlp_manager._startup_update_due("2025.01.01"))
                marker.write_text(f"latest\n{time.time() - 25 * 3600}", encoding="utf-8")
                self.assertTrue(ytdlp_manager._startup_update_due("latest"))


if __name__ == "__main__":
    unittest.main()
