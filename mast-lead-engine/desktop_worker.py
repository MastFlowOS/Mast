"""
Mast Lead Engine — Desktop Worker Prototype (Phase 3 / 3.5).

Self-contained local desktop worker for Windows.
Connects to MAST Cloud coordination endpoints (/v1/desktop/tasks/{claim,heartbeat,ingest,complete})
and executes the existing Python discovery engine (service.run_query) locally on the user's machine.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import platform
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

# Ensure mast-lead-engine root is in sys.path
_ENGINE_DIR = Path(__file__).resolve().parent
if str(_ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(_ENGINE_DIR))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [desktop-worker] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("desktop_worker")


def get_desktop_data_dir() -> Path:
    """Safe writable local directory for logs, cache, dedup, and provisioned browsers."""
    if platform.system() == "Windows":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            data_dir = Path(base) / "MAST"
        else:
            data_dir = Path.home() / ".mast"
    else:
        data_dir = Path.home() / ".mast"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def is_chromium_installed(browsers_path: Path | str) -> bool:
    """Checks whether a valid Chromium binary exists in browsers_path."""
    bp = Path(browsers_path)
    if not bp.exists():
        return False
    chrome_exes = (
        list(bp.glob("chromium-*/chrome-win64/chrome.exe"))
        + list(bp.glob("chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe"))
        + list(bp.glob("chromium-*/chrome.exe"))
        + list(bp.glob("chromium-*/chrome-linux/chrome"))
        + list(bp.glob("chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"))
    )
    return any(p.is_file() for p in chrome_exes)


def ensure_playwright_browser_provisioned(browsers_path: Path | str, timeout_s: float = 300.0) -> Path:
    """
    Ensures that a compatible Chromium browser binary exists in browsers_path.
    If missing, provisions it using Playwright's bundled driver without requiring developer tools.
    Handles partial/interrupted downloads and validates successful installation.
    """
    bp = Path(browsers_path).resolve()
    bp.mkdir(parents=True, exist_ok=True)

    if is_chromium_installed(bp):
        log.info("Playwright Chromium browser verified at %s", bp)
        return bp

    log.info("Playwright Chromium browser not found at %s. Provisioning compatible browser...", bp)

    from playwright._impl._driver import compute_driver_executable
    node_exe, cli_js = compute_driver_executable()

    if not Path(node_exe).exists():
        raise RuntimeError(f"Playwright driver node executable not found at: {node_exe}")
    if not Path(cli_js).exists():
        raise RuntimeError(f"Playwright driver CLI not found at: {cli_js}")

    env = os.environ.copy()
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(bp)

    log.info("Downloading Chromium via Playwright driver: %s %s install chromium", node_exe, cli_js)
    cmd = [node_exe, cli_js, "install", "chromium"]

    try:
        proc = subprocess.run(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout_s,
            check=False,
        )
        if proc.returncode != 0:
            log.error("Playwright browser installation failed (exit code %d):\n%s", proc.returncode, proc.stdout)
            raise RuntimeError(
                f"Failed to provision Playwright Chromium browser (exit code {proc.returncode}).\n"
                f"Recovery: Please check your internet connection or firewall. You can also manually configure a browser by setting the PLAYWRIGHT_BROWSERS_PATH environment variable to an existing Chromium installation directory.\n"
                f"Details:\n{proc.stdout}"
            )
        log.info("Playwright driver provisioning completed successfully.")
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"Timed out after {timeout_s}s while provisioning Playwright Chromium browser.\n"
            f"Recovery: Please check your network connection speed, or pre-install Chromium into %LOCALAPPDATA%\\MAST\\browsers or %LOCALAPPDATA%\\ms-playwright."
        ) from exc

    if not is_chromium_installed(bp):
        raise RuntimeError(
            f"Playwright reported success, but no compatible Chromium binary was found in {bp} after installation.\n"
            f"Recovery: Please verify write permissions for {bp} or restart the application to complete first-run setup."
        )

    log.info("Playwright Chromium browser provisioned successfully at %s", bp)
    return bp


def setup_playwright_browsers_path(provision_if_missing: bool = True) -> str:
    """
    Ensures PLAYWRIGHT_BROWSERS_PATH points to a valid location.
    Checks:
    1. PLAYWRIGHT_BROWSERS_PATH env var if set and already populated with a browser.
    2. Bundled executable browsers/ folder (for standalone installer releases).
    3. %LOCALAPPDATA%\\ms-playwright if already populated.
    4. %LOCALAPPDATA%\\MAST\\browsers (provisioned automatically if missing).
    """
    # 1. Explicit environment variable override
    env_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if env_path and is_chromium_installed(env_path):
        return env_path

    # 2. Bundled alongside frozen executable (PyInstaller onedir mode)
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).parent
        bundled_browsers = exe_dir / "browsers"
        if is_chromium_installed(bundled_browsers):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(bundled_browsers)
            return str(bundled_browsers)

    # 3. Standard Windows LocalAppData
    if platform.system() == "Windows":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            standard_ms = Path(local_app_data) / "ms-playwright"
            if is_chromium_installed(standard_ms):
                os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(standard_ms)
                return str(standard_ms)

    # 4. Local application data directory (provisioned if missing)
    target_dir = get_desktop_data_dir() / "browsers"
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(target_dir)

    if provision_if_missing and not is_chromium_installed(target_dir):
        ensure_playwright_browser_provisioned(target_dir)

    return str(target_dir)


def normalize_candidate_for_ingest(lead: dict, task: dict) -> dict:
    """Normalizes an engine lead dictionary to match server-side CandidateSchema."""
    return {
        "name": str(lead.get("name") or "Unknown Business").strip(),
        "query": str(lead.get("query") or task.get("niche") or "").strip(),
        "city": str(lead.get("city") or task.get("city") or "").strip(),
        "country": str(lead.get("country") or task.get("countryName") or "United States").strip(),
        "country_code": str(lead.get("country_code") or task.get("countryCode") or "US").strip(),
        "niche": str(lead.get("niche") or task.get("niche") or "").strip(),
        "region": str(lead.get("region") or task.get("region") or "").strip(),
        "address": str(lead.get("address") or "").strip(),
        "phone": str(lead.get("phone") or "").strip(),
        "email": str(lead.get("email") or "").strip(),
        "website": str(lead.get("website") or "").strip(),
        "instagram": str(lead.get("instagram") or "").strip(),
        "facebook": str(lead.get("facebook") or "").strip(),
        "linkedin": str(lead.get("linkedin") or "").strip(),
        "contact_form": str(lead.get("contact_form") or "").strip(),
        "maps_link": str(lead.get("maps_link") or "").strip(),
        "rating": float(lead["rating"]) if lead.get("rating") is not None else None,
        "reviews": int(lead.get("reviews") or 0),
        "category": str(lead.get("category") or "").strip(),
        "price_range": str(lead.get("price_range") or "").strip(),
        "has_photos": bool(lead.get("has_photos", False)),
        "has_popular_times": bool(lead.get("has_popular_times", False)),
        "owner_responds_to_reviews": bool(lead.get("owner_responds_to_reviews", False)),
        "is_google_verified": bool(lead.get("is_google_verified", False)),
        "multi_location": bool(lead.get("multi_location", False)),
        "closed": bool(lead.get("closed", False)),
        "ig_followers": int(lead["ig_followers"]) if lead.get("ig_followers") is not None else None,
        "ig_bio": str(lead.get("ig_bio") or "").strip(),
        "ig_activity": str(lead.get("ig_activity") or "").strip(),
        "ig_last_post_days": int(lead["ig_last_post_days"]) if lead.get("ig_last_post_days") is not None else None,
        "ig_legitimacy": float(lead.get("ig_legitimacy") or 0.0),
        "tech_stack": lead.get("tech_stack") if isinstance(lead.get("tech_stack"), dict) else {},
        "score": float(lead.get("score") or 0.0),
        "quality": str(lead.get("quality") or "").strip(),
        "tier": str(lead.get("tier") or "").strip(),
        "action": str(lead.get("action") or "").strip(),
        "fingerprints": list(lead.get("fingerprints") or []),
        "is_disqualified": bool(lead.get("is_disqualified", False)),
    }


class DesktopCoordinatorClient:
    """HTTP client communicating with the MAST Cloud coordination endpoints."""

    worker_id: str = ""
    auth_token: str = ""

    last_auth_error: bool = False
    _last_token_mtime: float = 0.0

    def __init__(self, api_base_url: str, auth_token: str, worker_id: str, session: Any):
        self.api_base_url = api_base_url.rstrip("/")
        self.auth_token = auth_token
        self.worker_id = worker_id
        self.session = session
        self.last_auth_error = False
        self._last_token_mtime = 0.0

    def _get_token(self) -> str:
        """Dynamically retrieves the latest authentication token from disk or initial config."""
        try:
            token_path = get_desktop_data_dir() / "auth.token"
            if token_path.is_file():
                mtime = token_path.stat().st_mtime
                if mtime > self._last_token_mtime or not self.auth_token:
                    self._last_token_mtime = mtime
                    tok = token_path.read_text(encoding="utf-8").strip()
                    if tok and tok != self.auth_token:
                        self.auth_token = tok
                        self.last_auth_error = False
        except Exception as exc:
            log.debug("Could not read auth.token from disk: %s", exc)
        return self.auth_token

    def _headers(self) -> Dict[str, str]:
        token = self._get_token()
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def claim_task(self, preferred_task_id: Optional[str] = None) -> Optional[dict]:
        token = self._get_token()
        if not token:
            log.error("claim_task aborted: No authentication token provided. A valid user JWT token is required.")
            return None

        url = f"{self.api_base_url}/v1/desktop/tasks/claim"
        payload: Dict[str, Any] = {"workerId": self.worker_id}
        if preferred_task_id:
            payload["preferredTaskId"] = preferred_task_id

        async with self.session.post(url, json=payload, headers=self._headers()) as resp:
            if resp.status == 200:
                self.last_auth_error = False
                data = await resp.json()
                return data.get("task")
            if resp.status == 401:
                log.error("claim_task failed: Authentication rejected (401 Unauthorized). Provided token is invalid or expired.")
                self.last_auth_error = True
                return None
            error_text = await resp.text()
            log.warning("claim_task returned status %d: %s", resp.status, error_text)
            return None

    async def heartbeat(self, task_id: str, lease_token: str, metrics: Optional[dict] = None) -> bool:
        url = f"{self.api_base_url}/v1/desktop/tasks/{task_id}/heartbeat"
        payload = {"leaseToken": lease_token}
        if metrics:
            payload["metrics"] = metrics

        try:
            async with self.session.post(url, json=payload, headers=self._headers()) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data.get("renewed") is False:
                        log.info("Heartbeat stopped by server for task %s (stopReason=%s)", task_id, data.get("stopReason"))
                        return False
                    return True
                if resp.status in (404, 409):
                    log.warning("Heartbeat rejected (status %d): lease expired or reassigned", resp.status)
                    return False
                error_text = await resp.text()
                log.warning("Heartbeat unexpected status %d: %s", resp.status, error_text)
                return False
        except Exception as exc:
            log.warning("Heartbeat request failed: %s", exc)
            return False

    async def ingest_batch(
        self,
        task_id: str,
        lease_token: str,
        batch_id: str,
        candidates: List[dict],
        max_retries: int = 3,
    ) -> Optional[dict]:
        url = f"{self.api_base_url}/v1/desktop/tasks/{task_id}/ingest"
        payload = {
            "leaseToken": lease_token,
            "batchId": batch_id,
            "candidates": candidates,
        }

        for attempt in range(1, max_retries + 1):
            try:
                async with self.session.post(url, json=payload, headers=self._headers()) as resp:
                    if resp.status == 200:
                        return await resp.json()
                    if resp.status in (404, 409):
                        error_text = await resp.text()
                        log.error("Ingest rejected by server (status %d): %s", resp.status, error_text)
                        return None
                    if resp.status == 401:
                        log.error("Ingest authentication rejected (401 Unauthorized). Checking for refreshed token...")
                        old_tok = self.auth_token
                        new_tok = self._get_token()
                        if new_tok and new_tok != old_tok:
                            log.info("Refreshed token available. Retrying batch %s...", batch_id)
                            continue
                        self.last_auth_error = True
                        return None
                    error_text = await resp.text()
                    log.warning("Ingest attempt %d returned %d: %s", attempt, resp.status, error_text)
            except Exception as exc:
                log.warning("Ingest attempt %d network error: %s", attempt, exc)

            if attempt < max_retries:
                await asyncio.sleep(attempt * 1.5)

        return None

    async def complete_task(
        self,
        task_id: str,
        lease_token: str,
        status: str,
        discovered: int = 0,
        accepted: int = 0,
        rejected: int = 0,
        duplicates: int = 0,
        exhausted: bool = False,
        completion_reason: str = "exhausted",
        termination_reason: Optional[str] = None,
        error: Optional[str] = None,
    ) -> bool:
        url = f"{self.api_base_url}/v1/desktop/tasks/{task_id}/complete"
        payload: Dict[str, Any] = {
            "leaseToken": lease_token,
            "status": status,
            "discovered": discovered,
            "accepted": accepted,
            "rejected": rejected,
            "duplicates": duplicates,
            "exhausted": exhausted,
            "completionReason": completion_reason,
        }
        if termination_reason:
            payload["terminationReason"] = termination_reason
        if error:
            payload["error"] = error

        try:
            async with self.session.post(url, json=payload, headers=self._headers()) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    log.info("Task %s completed: planDrained=%s", task_id, data.get("planDrained"))
                    return True
                error_text = await resp.text()
                log.error("complete_task failed (status %d): %s", resp.status, error_text)
                return False
        except Exception as exc:
            log.error("complete_task request failed: %s", exc)
            return False


class DesktopWorker:
    """Orchestrates local discovery execution and cloud coordination."""

    def __init__(
        self,
        client: DesktopCoordinatorClient,
        batch_size: int = 10,
        heartbeat_interval_s: float = 15.0,
        engine_runner: Optional[Callable[..., AsyncIterator[dict]]] = None,
    ):
        self.client = client
        self.batch_size = batch_size
        self.heartbeat_interval_s = heartbeat_interval_s
        self._engine_runner = engine_runner
        self._shutdown_event = asyncio.Event()

    async def execute_task(self, task: dict) -> bool:
        task_id = task["id"]
        lease_token = task["leaseToken"]
        niche = task.get("niche") or "general"
        city = task.get("city") or ""
        country_code = task.get("countryCode") or "US"
        candidate_budget = task.get("candidateBudget") or 20
        channels = task.get("channels") or []

        log.info(
            "Executing task %s: niche=%r city=%r budget=%d channels=%s",
            task_id, niche, city, candidate_budget, channels,
        )

        metrics = {"discovered": 0, "accepted": 0, "rejected": 0, "duplicates": 0}
        stop_heartbeat = asyncio.Event()
        task_abort = asyncio.Event()

        # Background heartbeat loop
        async def _heartbeat_worker():
            while not stop_heartbeat.is_set() and not task_abort.is_set():
                try:
                    await asyncio.sleep(self.heartbeat_interval_s)
                except asyncio.CancelledError:
                    break
                if stop_heartbeat.is_set() or task_abort.is_set():
                    break
                ok = await self.client.heartbeat(task_id, lease_token, metrics=metrics)
                if not ok:
                    log.warning("Heartbeat failed or lease expired/cancelled for task %s; aborting task", task_id)
                    task_abort.set()
                    break

        hb_task = asyncio.create_task(_heartbeat_worker())

        # Resolve engine runner
        runner = self._engine_runner
        if runner is None:
            if os.environ.get("MAST_MOCK_DISCOVERY") == "1":
                async def _mock_query(**kwargs):
                    target = min(kwargs.get("deliver_target", 2), 2)
                    log.info("Running controlled mock discovery (target=%d)", target)
                    for i in range(target):
                        await asyncio.sleep(0.3)
                        yield {
                            "name": f"Controlled Desktop Lead {i + 1}",
                            "city": kwargs.get("city", "TestCity"),
                            "country": "United States",
                            "country_code": kwargs.get("country", "US"),
                            "query": kwargs.get("query", "test"),
                            "niche": kwargs.get("query", "test"),
                            "address": f"{100 + i} Test St, TestCity, US",
                            "phone": f"+1555555010{i}",
                            "website": f"https://test-controlled-discovery-{i}.example.com",
                            "rating": 4.5,
                            "reviews": 10,
                        }
                runner = _mock_query
            else:
                from service import run_query
                runner = run_query

        batch_buffer: List[dict] = []
        batch_index = 0
        exhausted = False
        termination_reason = "SUCCESS_TARGET_REACHED"
        task_status = "completed"
        task_error: Optional[str] = None

        data_dir = get_desktop_data_dir()
        db_path = str(data_dir / "cache" / "local_dedup.db")
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        try:
            query_params = {
                "query": niche,
                "city": city,
                "country": country_code,
                "required_channels": channels,
                "deliver_target": candidate_budget,
                "max_results": candidate_budget * 2,
                "db_path": db_path,
            }

            async for raw_lead in runner(**query_params):
                if self._shutdown_event.is_set() or task_abort.is_set():
                    log.info("Task %s aborted via cancellation or shutdown", task_id)
                    termination_reason = "CANCELLED"
                    break

                metrics["discovered"] += 1
                normalized = normalize_candidate_for_ingest(raw_lead, task)
                batch_buffer.append(normalized)

                if len(batch_buffer) >= self.batch_size:
                    batch_index += 1
                    batch_id = f"{task_id}-batch-{batch_index}"
                    to_send = list(batch_buffer)
                    res = await self.client.ingest_batch(task_id, lease_token, batch_id, to_send)
                    if res is not None:
                        metrics["accepted"] += res.get("accepted", len(to_send))
                        metrics["duplicates"] += res.get("duplicates", 0)
                        metrics["rejected"] += res.get("rejected", 0)
                        batch_buffer.clear()
                        if res.get("planTargetReached"):
                            log.info("Parent plan target reached or cancelled for task %s. Stopping execution.", task_id)
                            termination_reason = "PLAN_TARGET_REACHED"
                            task_abort.set()
                            break
                    else:
                        log.error("Ingest failed for batch %s of task %s after retries. Aborting task.", batch_id, task_id)
                        task_status = "failed"
                        task_error = f"Ingestion failed for batch {batch_id}"
                        termination_reason = "FAILURE"
                        task_abort.set()
                        break

                if metrics["accepted"] >= candidate_budget:
                    log.info("Task %s reached candidate budget %d", task_id, candidate_budget)
                    termination_reason = "SUCCESS_TARGET_REACHED"
                    break

            # Flush remaining candidates in buffer
            if batch_buffer and not (self._shutdown_event.is_set() or task_abort.is_set()):
                batch_index += 1
                batch_id = f"{task_id}-batch-{batch_index}"
                to_send = list(batch_buffer)
                res = await self.client.ingest_batch(task_id, lease_token, batch_id, to_send)
                if res is not None:
                    metrics["accepted"] += res.get("accepted", len(to_send))
                    metrics["duplicates"] += res.get("duplicates", 0)
                    metrics["rejected"] += res.get("rejected", 0)
                    batch_buffer.clear()
                else:
                    log.error("Ingest failed for final batch %s of task %s. Aborting task.", batch_id, task_id)
                    task_status = "failed"
                    task_error = f"Ingestion failed for final batch {batch_id}"
                    termination_reason = "FAILURE"

            if metrics["accepted"] < candidate_budget and not (self._shutdown_event.is_set() or task_abort.is_set()):
                exhausted = True
                termination_reason = "SUCCESS_EXHAUSTED"

        except Exception as exc:
            log.exception("Engine failure during task %s: %s", task_id, exc)
            task_status = "failed"
            task_error = str(exc)
            termination_reason = "FAILURE"
        finally:
            stop_heartbeat.set()
            hb_task.cancel()
            try:
                await hb_task
            except (asyncio.CancelledError, Exception):
                pass

            await self.client.complete_task(
                task_id=task_id,
                lease_token=lease_token,
                status=task_status,
                discovered=metrics["discovered"],
                accepted=metrics["accepted"],
                rejected=metrics["rejected"],
                duplicates=metrics["duplicates"],
                exhausted=exhausted,
                completion_reason="target_reached" if metrics["accepted"] >= candidate_budget else ("cancelled" if task_abort.is_set() else "exhausted"),
                termination_reason=termination_reason,
                error=task_error,
            )

        return task_status == "completed"

    async def run_loop(self, poll_interval_s: float = 5.0, once: bool = False) -> None:
        """Main polling loop claiming and executing discovery tasks."""
        if hasattr(self.client, "_get_token"):
            try:
                self.client._get_token()
            except Exception:
                pass
        if not getattr(self.client, "auth_token", None):
            log.error("Desktop worker cannot run: No user authentication token provided (--auth-token or MAST_AUTH_TOKEN).")
            return

        log.info("Desktop worker loop started (worker_id=%s, once=%s)", self.client.worker_id, once)

        while not self._shutdown_event.is_set():
            try:
                task = await self.client.claim_task()
                if task:
                    await self.execute_task(task)
                    if once:
                        log.info("Single-task mode (--once) completed, exiting.")
                        break
                else:
                    if once:
                        log.info("No task available in single-task mode (--once), exiting.")
                        break
                    if getattr(self.client, "last_auth_error", False):
                        # Avoid aggressive polling when unauthenticated; back off until token refreshes
                        await asyncio.sleep(min(poll_interval_s * 4, 30.0))
                    else:
                        await asyncio.sleep(poll_interval_s)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.warning("Unexpected error in worker loop: %s", exc)
                if once:
                    break
                await asyncio.sleep(poll_interval_s)


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="MAST Desktop Discovery Worker")
    p.add_argument("--api-url", default=os.environ.get("MAST_API_URL", "http://localhost:3000"),
                   help="MAST Cloud API Base URL (default: http://localhost:3000)")
    p.add_argument("--auth-token", default=os.environ.get("MAST_AUTH_TOKEN", ""),
                   help="MAST User JWT Bearer Token")
    p.add_argument("--worker-id", default="",
                   help="Unique worker identifier (defaults to desktop-<hostname>-<shortid>)")
    p.add_argument("--batch-size", type=int, default=10,
                   help="Batch size for lead ingestion (default: 10)")
    p.add_argument("--poll-interval", type=float, default=5.0,
                   help="Polling interval when idle in seconds (default: 5.0)")
    p.add_argument("--heartbeat-interval", type=float, default=15.0,
                   help="Heartbeat renewal interval in seconds (default: 15.0)")
    p.add_argument("--once", action="store_true",
                   help="Run at most one task and exit")
    p.add_argument("--skip-browser-check", action="store_true",
                   help="Skip automatic Chromium provisioning check (for dry-run/testing)")
    p.add_argument("--test-browser", action="store_true",
                   help="Test launching and closing Chromium via Playwright, then exit")
    return p


async def run_browser_test(browsers_path: str) -> int:
    log.info("Testing Playwright Chromium launch from %s...", browsers_path)
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto("about:blank")
        content = await page.evaluate("() => document.title || 'OK'")
        log.info("Browser launch and execution verified! Evaluated title: %s", content)
        await browser.close()
    log.info("Playwright Chromium browser closed cleanly.")
    return 0


async def async_main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    # Configure Playwright browsers path
    browsers_path = setup_playwright_browsers_path(provision_if_missing=not args.skip_browser_check)
    log.info("Configured Playwright browsers path: %s", browsers_path)

    if args.test_browser:
        return await run_browser_test(browsers_path)

    worker_id = args.worker_id or f"desktop-{socket.gethostname()}-{uuid.uuid4().hex[:6]}"

    import aiohttp
    async with aiohttp.ClientSession() as session:
        client = DesktopCoordinatorClient(
            api_base_url=args.api_url,
            auth_token=args.auth_token,
            worker_id=worker_id,
            session=session,
        )
        worker = DesktopWorker(
            client=client,
            batch_size=args.batch_size,
            heartbeat_interval_s=args.heartbeat_interval,
        )
        await worker.run_loop(poll_interval_s=args.poll_interval, once=args.once)

    return 0


def main():
    try:
        sys.exit(asyncio.run(async_main()))
    except KeyboardInterrupt:
        log.info("Desktop worker interrupted by user, exiting.")
        sys.exit(0)


if __name__ == "__main__":
    main()
