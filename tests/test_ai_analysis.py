import os
import sys
import tempfile
import unittest
from pathlib import Path


class SourceAnalysisPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls._env_keys = ["NEKO_CONFIG_DIR", "NEKO_CONFIG_FILE", "NEKO_DATA_DIR", "NEKO_LOGS_DIR", "NEKO_CACHE_DIR"]
        cls._previous_env = {key: os.environ.get(key) for key in cls._env_keys}
        tmp_root = Path(cls.tmp.name)
        os.environ["NEKO_CONFIG_DIR"] = str(tmp_root / "config")
        os.environ["NEKO_CONFIG_FILE"] = str(tmp_root / "config" / "settings.json")
        os.environ["NEKO_DATA_DIR"] = str(tmp_root / "data")
        os.environ["NEKO_LOGS_DIR"] = str(tmp_root / "logs")
        os.environ["NEKO_CACHE_DIR"] = str(tmp_root / "cache")
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

    @classmethod
    def tearDownClass(cls):
        for key, value in cls._previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.tmp.cleanup()

    def test_trace_moe_scene_is_saved_without_a_prompt(self):
        from app.services.ai_analysis import _analysis_payloads

        description = "Even the Student Council Has Its Holes — Season 1, Episode 1, at 00:09:32–00:09:34 of 00:23:40."
        suggestion = {
            "model": "trace.moe",
            "evidence": {
                "kind": "trace_moe",
                "modelId": "trace_moe",
                "parsed": {"summary": description, "rationale": description, "tags": ["season_1", "episode_1", "s01e01"]},
                "raw": "Even.the.Student.Council.Has.Its.Holes.S01E01.720p.mkv",
            },
        }
        opts = type("Opts", (), {"semanticPromptEnabled": True, "semanticPrompt": "describe it"})()
        payloads = _analysis_payloads(suggestion, opts=opts, profile="trace_moe")

        self.assertEqual(len(payloads), 1)
        payload = payloads[0]
        self.assertEqual(payload["model_id"], "trace_moe")
        self.assertEqual(payload["model_name"], "trace.moe")
        self.assertEqual(payload["summary"], description)
        self.assertEqual(payload["semantic_tags"], ["season_1", "episode_1", "s01e01"])
        self.assertEqual(payload["prompt"], "")
        self.assertIsNone(payload["prompt_hash"])
        self.assertIn("s01e01", payload["search_text"])
        self.assertIn("S01E01.720p.mkv", payload["search_text"])

    def test_other_non_semantic_kinds_are_still_skipped(self):
        from app.services.ai_analysis import _analysis_payloads

        suggestion = {"model": "WD", "evidence": {"kind": "wd", "parsed": {"summary": "x"}}}
        self.assertEqual(_analysis_payloads(suggestion, profile="x"), [])


if __name__ == "__main__":
    unittest.main()
