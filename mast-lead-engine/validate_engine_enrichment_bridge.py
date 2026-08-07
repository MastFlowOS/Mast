"""
Ad-hoc validation for the Milestone 2 Engine 2.0 Enrichment Bridge, run
directly:

    python3 validate_engine_enrichment_bridge.py

Not part of the permanent pytest suite (matching validate_storage_backend.py
/ validate_fan_in_runtime.py's own precedent). Exercises:

    - enrich_business() with only a website -> runs Website+Contact,
      skips Instagram, returns the expected flat-dict field names.
    - enrich_business() with only an instagram handle -> runs Instagram
      only, Website/Contact fields come back None.
    - enrich_business() with neither -> returns an all-None/empty dict,
      never raises.
    - Fields this bridge intentionally does not produce (seo, blog,
      signals.tech_stack, on-page social-link discovery) are absent from
      the result entirely, not present-and-null — so callers relying on
      `field: value || undefined` truly leave existing DB values alone.
    - service.py's `enrich` CLI mode round-trips stdin JSON -> stdout JSON
      the same way `verify` already does.

No live network is reachable from this environment, so WebsiteWorker /
ContactWorker / InstagramWorker's urllib calls are monkeypatched, exactly
as validate_storage_backend.py monkeypatches urlopen for the same reason.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import urllib.request
from io import BytesIO
from unittest.mock import patch

from pathlib import Path
from engine_enrichment_bridge import enrich_business

engine_dir = Path(__file__).resolve().parent



class _FakeHeaders:
    def get_content_charset(self):
        return "utf-8"

    def get(self, *_a, **_kw):
        return None


class _FakeHTTPResponse:
    def __init__(self, body: bytes, url: str, status: int = 200) -> None:
        self._buf = BytesIO(body)
        self._url = url
        self.status = status
        self.headers = _FakeHeaders()

    def read(self) -> bytes:
        return self._buf.read()

    def geturl(self) -> str:
        return self._url

    def getheader(self, *_a, **_kw):
        return None

    def info(self):
        return self.headers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


_FAKE_HTML = b"""
<html><head><title>Test Biz</title>
<meta name="description" content="A test business"></head>
<body>Contact us at hello@testbiz.example or call 555-0100.
<a href="mailto:hello@testbiz.example">Email</a>
</body></html>
"""


def _fake_opener_open(_self_or_opener, request, timeout=None):
    return _FakeHTTPResponse(_FAKE_HTML, url=request.full_url if hasattr(request, "full_url") else str(request))


def check(label: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        raise SystemExit(1)


def main() -> None:
    with patch.object(urllib.request.OpenerDirector, "open", _fake_opener_open), \
         patch.object(urllib.request, "urlopen", lambda req, timeout=None: _FakeHTTPResponse(_FAKE_HTML, url=req.full_url)):

        # 1. Website-only business.
        result = enrich_business({"name": "Test Biz", "website": "https://testbiz.example"})
        check("website_reachable present", result.get("website_reachable") is True)
        check("title extracted", result.get("title") == "Test Biz")
        check("instagram fields absent when no handle given", result.get("instagram_username") is None)
        check(
            "no fabricated seo/blog/tech_stack keys",
            "seo" not in result and "blog" not in result and "tech_stack" not in result,
        )

        # 2. Instagram-only business (no website) -> Website/Contact skipped.
        result2 = enrich_business({"name": "IG Only Biz", "instagram": "https://instagram.com/testbiz"})
        check("website_reachable is None when no website given", result2.get("website_reachable") is None)
        check("contact_form_url is None when no website given", result2.get("contact_form_url") is None)

        # 3. Neither website nor instagram -> no exception, all-empty result.
        result3 = enrich_business({"name": "Ghost Biz"})
        check("no exception for empty business", isinstance(result3, dict))
        check("website_reachable None for ghost business", result3.get("website_reachable") is None)
        check("instagram_username None for ghost business", result3.get("instagram_username") is None)

    # 4. CLI round-trip (subprocess, same invocation shape pythonBridge.ts uses).
    proc = subprocess.run(
        [sys.executable, str(engine_dir / "service.py"), "enrich"],
        input=json.dumps({"name": "CLI Biz"}),

        capture_output=True,
        text=True,
        timeout=30,
    )
    check("enrich CLI exits 0", proc.returncode == 0)
    try:
        cli_result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        cli_result = None
    check("enrich CLI returns valid JSON", isinstance(cli_result, dict))

    print("\nAll engine_enrichment_bridge validations passed.")


if __name__ == "__main__":
    main()
