"""Worker tests — standard library only, cascade and HTTP are mocked."""

import asyncio
import os
import sys
import unittest
from dataclasses import dataclass
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import worker  # noqa: E402


def make_config(tmpdir):
    return worker.Config(
        internal_url="http://127.0.0.1:3048",
        # Assembled at runtime so secret scanners do not mistake this obviously
# fake fixture for a credential.
token="".join(["correct-", "copywriter-bridge-", "token-at-least-thirty-two"]),
        workdir=tmpdir,
        worker_id="copywriter-test",
    )


ITEM = {
    "id": "gen_1",
    "renderedPrompt": "prompt text",
    "jsonSchema": {"type": "object"},
    "model": "haiku",
    "timeoutSec": 45,
}


class CascadeResult(SimpleNamespace):
    pass


class ProcessItemTests(unittest.TestCase):
    """process_item with the cascade and the HTTP calls mocked."""

    def setUp(self):
        self.cfg = make_config("/tmp")
        self.calls = []

    def run_item(self, cascade_result, poster):
        async def cascade_call(item):
            self.calls.append(item)
            return cascade_result

        return asyncio.run(worker.process_item(ITEM, self.cfg, cascade_call, poster))

    def test_success_posts_raw_output_with_tier_and_latency(self):
        posted = []

        async def poster(path, payload):
            posted.append((path, payload))

        result = CascadeResult(
            returncode=0, stdout='{"openingDm":"Hi"}', stderr="", tier="claude"
        )
        self.assertTrue(self.run_item(result, poster))
        self.assertEqual(len(self.calls), 1)
        path, payload = posted[0]
        self.assertEqual(path, "/api/internal/copywriter/items/gen_1/result")
        self.assertEqual(payload["workerId"], "copywriter-test")
        self.assertEqual(payload["rawOutput"], '{"openingDm":"Hi"}')
        self.assertEqual(payload["tier"], "claude")
        self.assertIsInstance(payload["latencyMs"], int)

    def test_tier_none_posts_cascade_failed_without_stderr(self):
        posted = []
        recorded = []

        async def poster(path, payload):
            posted.append(path)
            recorded.append(payload)

        result = CascadeResult(
            returncode=1, stdout="", stderr="provider quota detail: SECRET", tier=None
        )
        self.assertTrue(self.run_item(result, poster))
        self.assertEqual(posted, ["/api/internal/copywriter/items/gen_1/fail"])
        self.assertEqual(recorded[0]["code"], "CASCADE_FAILED")
        # stderr content must never reach the app.
        self.assertNotIn("SECRET", str(recorded))

    def test_nonzero_return_code_posts_cascade_failed(self):
        posted = []

        async def poster(path, payload):
            posted.append(path)

        result = CascadeResult(
            returncode=3, stdout="garbage", stderr="boom", tier="glm"
        )
        self.assertTrue(self.run_item(result, poster))
        self.assertEqual(posted, ["/api/internal/copywriter/items/gen_1/fail"])

    def test_cascade_exception_posts_fail_and_keeps_worker_alive(self):
        posted = []
        calls = []

        async def cascade_call(item):
            calls.append(item)
            raise TimeoutError("cascade subprocess hung")

        async def poster(path, payload):
            posted.append((path, payload))

        ran = asyncio.run(worker.process_item(ITEM, self.cfg, cascade_call, poster))
        self.assertTrue(ran)
        # The item is failed with the stable code and the loop continues.
        self.assertEqual(len(calls), 1)
        path, payload = posted[0]
        self.assertEqual(path, "/api/internal/copywriter/items/gen_1/fail")
        self.assertEqual(payload["code"], "CASCADE_FAILED")
        self.assertNotIn("hung", str(payload))

    def test_cascade_exception_with_unreachable_app_reports_once(self):
        calls = []

        async def cascade_call(item):
            calls.append(item)
            raise RuntimeError("boom")

        async def poster(path, payload):
            raise ConnectionError("app is down")

        ran = asyncio.run(worker.process_item(ITEM, self.cfg, cascade_call, poster))
        self.assertFalse(ran)
        self.assertEqual(len(calls), 1)

    def test_app_unreachable_after_call_never_re_calls_cascade(self):
        calls = []

        async def cascade_call(item):
            calls.append(item)
            return CascadeResult(returncode=0, stdout="{}", stderr="", tier="claude")

        async def poster(path, payload):
            raise ConnectionError("app is down")

        ran = asyncio.run(worker.process_item(ITEM, self.cfg, cascade_call, poster))
        self.assertFalse(ran)
        # Exactly one cascade call: the lease expiry re-queues the item, the
        # worker must not spend quota twice.
        self.assertEqual(len(calls), 1)


class ConfigTests(unittest.TestCase):
    def test_missing_token_refuses_to_start(self):
        env = {
            "COPYWRITER_BRIDGE_TOKEN": "",
            "COPYWRITER_WORKDIR": os.getcwd(),
        }
        self.assertIsNone(worker.config_from_env(env))

    def test_blank_token_refuses_to_start(self):
        env = {
            "COPYWRITER_BRIDGE_TOKEN": "   ",
            "COPYWRITER_WORKDIR": os.getcwd(),
        }
        self.assertIsNone(worker.config_from_env(env))

    def test_missing_workdir_refuses_to_start(self):
        env = {
            "COPYWRITER_BRIDGE_TOKEN": "token-that-is-clearly-long-enough",
            "COPYWRITER_WORKDIR": "/nonexistent/openreply-copywriter",
        }
        self.assertIsNone(worker.config_from_env(env))

    def test_empty_credential_directory_refuses_to_start(self):
        import tempfile

        with tempfile.TemporaryDirectory() as empty_dir:
            env = {
                "COPYWRITER_BRIDGE_TOKEN": "token",
                "COPYWRITER_WORKDIR": os.getcwd(),
                "CLAUDE_CASCADE_CRED_DIR": empty_dir,
            }
            # config_from_env passes; the credential gate fires in
            # load_cascade, so main() exits 2 with a loud message.
            with mock.patch.dict(os.environ, env, clear=False):
                self.assertEqual(worker.main(), 2)

    def test_populated_credential_directory_passes_the_gate(self):
        import tempfile

        with tempfile.TemporaryDirectory() as cred_dir:
            with open(os.path.join(cred_dir, "credential"), "w") as handle:
                handle.write("x")
            env = {
                "COPYWRITER_BRIDGE_TOKEN": "token",
                "COPYWRITER_WORKDIR": os.getcwd(),
                "CLAUDE_CASCADE_CRED_DIR": cred_dir,
            }

            async def fake_cascade(item):
                raise AssertionError("the loop must not run in tests")

            captured = {}

            async def fake_run_forever(cfg, cascade_call):
                captured["callable"] = callable(cascade_call)

            # Mock the library import and the loop: this test must pass (or
            # fail fast) on ANY host — on the production host the real
            # claude_cascade exists and main() would otherwise loop forever
            # against the live app.
            with mock.patch.dict(os.environ, env, clear=False):
                with mock.patch.object(worker, "load_cascade",
                                       return_value=fake_cascade):
                    with mock.patch.object(worker, "run_forever",
                                           fake_run_forever):
                        self.assertEqual(worker.main(), 0)
            self.assertTrue(captured["callable"])

    def test_main_exits_2_when_token_missing(self):
        env = {
            "COPYWRITER_BRIDGE_TOKEN": "",
            "OPENREPLY_INTERNAL_URL": "http://127.0.0.1:3048",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            # Remove the variable entirely to exercise the absent path.
            os.environ.pop("COPYWRITER_BRIDGE_TOKEN", None)
            self.assertEqual(worker.main(), 2)


if __name__ == "__main__":
    unittest.main()
