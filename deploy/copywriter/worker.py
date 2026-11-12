"""OpenReply copywriter host worker.

The app container cannot run the subscription cascade; this host service
does. It claims CopyGeneration rows over the loopback-only internal API,
calls the cascade once per item, and posts the raw answer back. It is pure
transport: the prompt text, the JSON schema, validation, the repair attempt
and the standard-copy fallback all live in the app
(`lib/copywriter/service.ts`), so editing the prompt from the dashboard
never needs a worker deploy.

Failure discipline:
- cascade failed (non-zero return code or `tier is None`) → post `fail` with
  the code CASCADE_FAILED. stderr is NEVER logged or forwarded: it can
  contain provider details. Only the code and the tier are logged.
- network error toward the app AFTER the cascade call → log it, never re-call
  the cascade for that item. The app's lease expiry re-queues it.
- SIGTERM → finish the current item, then exit.

Python 3.12 standard library only.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

DEFAULT_INTERNAL_URL = "http://127.0.0.1:3048"
CLAIM_PATH = "/api/internal/copywriter/claim"
RESULT_PATH = "/api/internal/copywriter/items/{id}/result"
FAIL_PATH = "/api/internal/copywriter/items/{id}/fail"

# The app long-polls a claim for up to 20 s; leave headroom on the client.
CLAIM_TIMEOUT_S = 30
POST_TIMEOUT_S = 15
# One item per claim. A 60 s lease against a 45 s cascade timeout means a
# batch of 5 processed serially could outlive items' leases and pay for
# cascade calls whose results are then rejected. This worker is a pure
# transport; the long-poll keeps throughput without batches.
CLAIM_LIMIT = 1
CLAIM_RETRY_S = 5


def log_event(code: str, tier: str | None = None) -> None:
    """Log only the event code and the tier. Never stderr, never payloads."""
    if tier is None:
        print(f"[copywriter] {code}", flush=True)
    else:
        print(f"[copywriter] {code} tier={tier}", flush=True)


@dataclass
class Config:
    internal_url: str
    token: str
    workdir: str
    worker_id: str


def config_from_env(env: dict[str, str] | None = None) -> Config | None:
    """Build the config from the environment. None when misconfigured.

    Exit contract: a missing (or blank) COPYWRITER_BRIDGE_TOKEN, or a
    missing COPYWRITER_WORKDIR, refuses to start.
    """
    source = os.environ if env is None else env
    token = (source.get("COPYWRITER_BRIDGE_TOKEN") or "").strip()
    if not token:
        print(
            "[copywriter] COPYWRITER_BRIDGE_TOKEN missing; refusing to start",
            file=sys.stderr,
            flush=True,
        )
        return None
    workdir = (source.get("COPYWRITER_WORKDIR") or "").strip()
    if not workdir or not os.path.isdir(workdir):
        print(
            "[copywriter] COPYWRITER_WORKDIR must be an existing directory",
            file=sys.stderr,
            flush=True,
        )
        return None
    internal_url = (
        source.get("OPENREPLY_INTERNAL_URL") or DEFAULT_INTERNAL_URL
    ).rstrip("/")
    return Config(
        internal_url=internal_url,
        token=token,
        workdir=workdir,
        worker_id=f"copywriter-{socket.gethostname()}",
    )


def http_json(
    cfg: Config, path: str, payload: dict, timeout: float
) -> tuple[int, dict]:
    """POST one JSON payload to the app. Raises on any network error."""
    request = urllib.request.Request(
        cfg.internal_url + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg.token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read().decode("utf-8"))
        return response.status, body


async def claim(cfg: Config) -> list[dict]:
    status, body = await asyncio.to_thread(
        http_json,
        cfg,
        CLAIM_PATH,
        {"workerId": cfg.worker_id, "limit": CLAIM_LIMIT},
        CLAIM_TIMEOUT_S,
    )
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError("claim request failed")
    items = body.get("data", {}).get("items", [])
    return items if isinstance(items, list) else []


async def post_json(cfg: Config, path: str, payload: dict) -> None:
    await asyncio.to_thread(
        http_json, cfg, path, payload, POST_TIMEOUT_S
    )


def load_cascade(cfg: Config):
    """Return the cascade call bound to this worker, or None when the shared
    library is unavailable. Imported lazily so the module stays importable
    (and testable) on hosts without /opt/shared-libs."""
    if "/opt/shared-libs" not in sys.path:
        sys.path.insert(0, "/opt/shared-libs")
    try:
        from claude_cascade import call_claude_cascade
    except Exception as error:  # noqa: BLE001 — any import failure is fatal here
        print(
            f"[copywriter] cascade library unavailable: {type(error).__name__}",
            file=sys.stderr,
            flush=True,
        )
        return None

    async def cascade_call(item: dict):
        return await call_claude_cascade(
            item["renderedPrompt"],
            model=item["model"],
            max_turns=1,
            available_tools="",
            allowed_tools="",
            isolated_context=True,
            json_schema=item["jsonSchema"],
            timeout=item["timeoutSec"],
            provider_policy="max-first",
            cwd=cfg.workdir,
        )

    return cascade_call


async def process_item(
    item: dict,
    cfg: Config,
    cascade_call,
    poster=None,
) -> bool:
    """Run one claimed item end to end. Returns True when the app accepted a
    result or a failure; False when the app was unreachable (the lease
    expiry re-queues the item)."""
    if poster is None:
        poster = lambda path, payload: post_json(cfg, path, payload)  # noqa: E731

    started = time.monotonic()
    try:
        res = await cascade_call(item)
    except Exception as error:  # noqa: BLE001
        # A cascade crash (timeout, subprocess failure, malformed item) must
        # not take the worker down: the other claimed items would sit on
        # expired leases and systemd would restart into a crash loop. The
        # code only — never the exception text, it can name providers.
        log_event(
            f"CASCADE_RAISED: {type(error).__name__}",
            None,
        )
        try:
            await poster(
                FAIL_PATH.format(id=item["id"]),
                {"workerId": cfg.worker_id, "code": "CASCADE_FAILED"},
            )
        except Exception as post_error:  # noqa: BLE001
            log_event(f"APP_UNREACHABLE: {type(post_error).__name__}")
            return False
        return True
    latency_ms = int((time.monotonic() - started) * 1000)

    tier = getattr(res, "tier", None)
    returncode = getattr(res, "returncode", 1)
    if tier is None or returncode != 0:
        # Every tier failed, or the cascade itself failed. The code only —
        # stderr can contain provider details and never leaves this process.
        log_event("CASCADE_FAILED", tier)
        try:
            await poster(
                FAIL_PATH.format(id=item["id"]),
                {"workerId": cfg.worker_id, "code": "CASCADE_FAILED"},
            )
        except Exception as error:  # noqa: BLE001
            log_event(f"APP_UNREACHABLE: {type(error).__name__}")
            return False
        return True

    try:
        await poster(
            RESULT_PATH.format(id=item["id"]),
            {
                "workerId": cfg.worker_id,
                "rawOutput": res.stdout,
                "tier": tier,
                "latencyMs": latency_ms,
            },
        )
    except Exception as error:  # noqa: BLE001
        # The cascade already ran for this item. Log and move on: the app's
        # lease expiry re-queues it, and a second cascade call would spend
        # quota on a row another worker may already own.
        log_event(f"APP_UNREACHABLE: {type(error).__name__}")
        return False
    return True


async def run_forever(cfg: Config, cascade_call) -> None:
    """Claim-and-work loop. SIGTERM (or SIGINT) finishes the current item
    then exits cleanly."""
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover — non-Unix test hosts
            pass

    while not stop.is_set():
        try:
            items = await claim(cfg)
        except Exception as error:  # noqa: BLE001
            log_event(f"CLAIM_FAILED: {type(error).__name__}")
            try:
                await asyncio.wait_for(stop.wait(), timeout=CLAIM_RETRY_S)
            except asyncio.TimeoutError:
                pass
            continue

        for item in items:
            await process_item(item, cfg, cascade_call)
            if stop.is_set():
                break

    log_event("WORKER_STOPPED")


def main(argv: list[str] | None = None) -> int:
    del argv  # no flags on purpose: everything comes from the environment
    cfg = config_from_env()
    if cfg is None:
        return 2
    cascade_call = load_cascade(cfg)
    if cascade_call is None:
        return 2
    asyncio.run(run_forever(cfg, cascade_call))
    return 0


if __name__ == "__main__":
    sys.exit(main())
