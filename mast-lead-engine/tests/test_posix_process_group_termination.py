import errno
import io
import json
import os
import signal
import sys
from unittest.mock import patch, MagicMock

import pytest

# Ensure parent path is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from service import (
    _is_process_group_extinct,
    confirm_and_emit_job_terminated,
    terminate_and_verify_posix_group,
    query_job_active_processes,
)

try:
    from scraper.maps_scraper import MapsScraper
except ImportError:
    class MapsScraper:  # type: ignore
        _last_browser_pgid = None
        _last_driver_pid = None
        _browser_spawn_attempted = False
        _driver_startup_failed = False
        _spawn_failed = False
    import types
    mod = types.ModuleType("scraper.maps_scraper")
    mod.MapsScraper = MapsScraper
    sys.modules["scraper.maps_scraper"] = mod


def test_posix_termination_existing_process_group():
    """Issue 1: Group exists (killpg succeeds) -> _is_process_group_extinct returns False."""
    def mock_kill(pgid, sig):
        assert sig == 0
        return None  # Success means group exists and is alive

    assert _is_process_group_extinct(88888, mock_kill) is False


def test_posix_termination_esrch_confirmation():
    """Issue 1: ESRCH positively confirms process group is extinct."""
    def mock_kill_extinct(pgid, sig):
        assert sig == 0
        err = OSError()
        err.errno = errno.ESRCH
        raise err

    assert _is_process_group_extinct(88888, mock_kill_extinct) is True

    call_counts = {"kill": 0}

    def mock_kill(pid_arg, sig_arg):
        call_counts["kill"] += 1
        if sig_arg == 0:
            if call_counts["kill"] >= 3:
                err = OSError()
                err.errno = errno.ESRCH
                raise err
            return None
        return None

    res = terminate_and_verify_posix_group(pgid=88888, timeout_s=1.0, poll_interval_s=0.01, kill_fn=mock_kill)
    assert res is True


def test_posix_termination_eperm_rejected():
    """Issue 1: EPERM means process group exists (permission denied); must NOT count as termination."""
    def mock_kill_eperm(pgid, sig):
        err = OSError()
        err.errno = errno.EPERM
        raise err

    # Direct existence check must return False
    assert _is_process_group_extinct(88888, mock_kill_eperm) is False

    # Full termination helper must reject and return False
    res = terminate_and_verify_posix_group(pgid=88888, timeout_s=0.1, poll_interval_s=0.02, kill_fn=mock_kill_eperm)
    assert res is False


def test_posix_termination_unexpected_os_error_rejected():
    """Issue 1: Unexpected OS errors (e.g. EINVAL, EIO) must NOT be interpreted as termination."""
    for code in (errno.EINVAL, errno.EIO, errno.EACCES):
        def mock_kill_err(pgid, sig, c=code):
            err = OSError()
            err.errno = c
            raise err

        assert _is_process_group_extinct(88888, mock_kill_err) is False
        res = terminate_and_verify_posix_group(pgid=88888, timeout_s=0.1, poll_interval_s=0.02, kill_fn=mock_kill_err)
        assert res is False


def test_posix_termination_timeout_with_group_alive():
    """Issue 1: When process group remains alive throughout timeout window, termination fails."""
    def mock_kill_always_alive(pgid, sig):
        return None  # Process group exists

    res = terminate_and_verify_posix_group(
        pgid=66666, timeout_s=0.15, poll_interval_s=0.02, kill_fn=mock_kill_always_alive
    )
    assert res is False, "Must return False when process group remains alive throughout timeout"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process group integration test requires Unix platform")
def test_genuine_posix_subprocess_process_group_termination():
    """Issue 1 & 2: Genuine POSIX subprocess integration test verifying actual OS-level behavior.
    Demonstrates:
    - Spawning a real detached subprocess with start_new_session=True.
    - Exercising os.killpg(pgid, 0) against the live process group.
    - Exercising terminate_and_verify_posix_group(pgid) which sends SIGTERM/SIGKILL.
    - Observing genuine ESRCH from os.killpg(pgid, 0) after process group extinction.
    """
    import subprocess
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        start_new_session=True,
    )
    try:
        pgid = os.getpgid(proc.pid)
        assert pgid > 0
        # Genuine OS check: live process group is not extinct
        assert not _is_process_group_extinct(pgid, os.killpg)

        # Terminate and positively verify extinction via os.killpg(pgid, 0) -> ESRCH
        confirmed = terminate_and_verify_posix_group(pgid, timeout_s=3.0)
        assert confirmed is True
        assert _is_process_group_extinct(pgid, os.killpg) is True
    finally:
        try:
            proc.kill()
            proc.wait(timeout=1.0)
        except Exception:
            pass


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Object test")
def test_windows_job_empty_pid_list_with_assigned_processes_fails_confirmation():
    """Item 1: NumberOfProcessIdsInList == 0 but NumberOfAssignedProcesses > 0 must fail verification."""
    import service
    service._MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    with patch("sys.platform", "win32"):
        with patch("service.query_job_process_id_list", return_value=(2, 0, [])):
            with patch("service.kernel32.QueryInformationJobObject", return_value=True):
                # query_job_active_processes must report >= 2, never 0
                active = query_job_active_processes(123456)
                assert active == 2, "Must report NumberOfAssignedProcesses count, not 0"

                res = confirm_and_emit_job_terminated(
                    out_stream=out_s,
                    h_job=123456,
                    scout_id="scout_assigned_non_zero",
                    nonce="nonce_assigned_non_zero",
                )
                assert res is False, "Confirmation must fail when NumberOfAssignedProcesses > 0"
                assert out_s.getvalue() == "", "Must suppress MAST_JOB_TERMINATED"


def test_missing_ownership_identity_cannot_produce_confirmation():
    """Item 3: Missing ownership identity cannot produce successful confirmation."""
    import service
    service._MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    # Case A: Windows with missing Job Object handle
    with patch("sys.platform", "win32"):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            h_job=None,
            scout_id="scout_no_ident_win",
            nonce="nonce_no_ident_win",
        )
        assert res is False
        assert out_s.getvalue() == ""

    # Case B: POSIX with uninitialized identity and empty browser state
    MapsScraper._last_browser_pgid = None
    MapsScraper._last_driver_pid = None
    MapsScraper._browser_spawn_attempted = False
    MapsScraper._driver_startup_failed = False
    MapsScraper._spawn_failed = False
    service._MAST_POSIX_BOOTSTRAP_CONFIRMED = False

    with patch("sys.platform", "linux"):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            scout_id="scout_no_ident_posix",
            nonce="nonce_no_ident_posix",
            posix_identity_confirmed=False,
        )
        assert res is False
        assert out_s.getvalue() == ""


def test_posix_empty_ownership_failed_driver_startup_fails_confirmation():
    """Item 3: Failed driver startup must leave empty ownership unconfirmed."""
    import service
    service._MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    MapsScraper._last_browser_pgid = None
    MapsScraper._last_driver_pid = None
    MapsScraper._browser_spawn_attempted = False
    MapsScraper._driver_startup_failed = True
    MapsScraper._spawn_failed = False

    with patch("sys.platform", "linux"):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            scout_id="scout_failed_startup",
            nonce="nonce_failed_startup",
            posix_identity_confirmed=True,
        )
        assert res is False, "Must fail confirmation when driver startup failed"
        assert out_s.getvalue() == "", "Must suppress MAST_JOB_TERMINATED"

    MapsScraper._driver_startup_failed = False


def test_posix_empty_ownership_spawn_attempted_fails_confirmation():
    """Item 3: If browser spawn was attempted, empty ownership branch cannot be used."""
    import service
    service._MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    MapsScraper._last_browser_pgid = None
    MapsScraper._last_driver_pid = None
    MapsScraper._browser_spawn_attempted = True
    MapsScraper._driver_startup_failed = False
    MapsScraper._spawn_failed = False

    with patch("sys.platform", "linux"):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            scout_id="scout_spawn_attempted",
            nonce="nonce_spawn_attempted",
            posix_identity_confirmed=True,
        )
        assert res is False, "Must fail confirmation when spawn was attempted"
        assert out_s.getvalue() == "", "Must suppress MAST_JOB_TERMINATED"

    MapsScraper._browser_spawn_attempted = False


def test_posix_invalid_identity_values_fails_confirmation():
    """Item 3: Invalid / corrupted identity values (e.g. <= 0 or non-int) must fail confirmation."""
    import service

    for invalid_val in [0, -1, -999, "invalid", False]:
        service._MAST_TERMINATED_EMITTED = False
        out_s = io.StringIO()

        MapsScraper._last_browser_pgid = invalid_val
        MapsScraper._last_driver_pid = None
        MapsScraper._browser_spawn_attempted = False
        MapsScraper._driver_startup_failed = False
        MapsScraper._spawn_failed = False

        with patch("sys.platform", "linux"):
            res = confirm_and_emit_job_terminated(
                out_stream=out_s,
                scout_id=f"scout_invalid_{invalid_val}",
                nonce="nonce_invalid",
                posix_identity_confirmed=True,
            )
            assert res is False, f"Must reject invalid identity value {invalid_val!r}"
            assert out_s.getvalue() == ""

    MapsScraper._last_browser_pgid = None


def test_initialized_empty_ownership_context_confirms_termination():
    """Item 3: Genuinely initialized but empty ownership context can produce confirmation."""
    import service
    service._MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    # Case A: Windows with initialized Job Object where ActiveProcesses == 0
    with patch("sys.platform", "win32"):
        with patch("service.terminate_and_verify_windows_job", return_value=True):
            with patch("service.close_windows_job_handle", return_value=True):
                res = confirm_and_emit_job_terminated(
                    out_stream=out_s,
                    h_job=123456,
                    scout_id="scout_empty_win",
                    nonce="nonce_empty_win",
                )
                assert res is True
                msg = json.loads(out_s.getvalue().strip())
                assert msg["type"] == "MAST_JOB_TERMINATED"
                assert msg["scoutId"] == "scout_empty_win"
                assert msg["nonce"] == "nonce_empty_win"
                assert msg["status"] == "CONFIRMED"

    # Case B: POSIX with confirmed bootstrap identity and empty browser state
    service._MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()
    MapsScraper._last_browser_pgid = None
    MapsScraper._last_driver_pid = None
    MapsScraper._browser_spawn_attempted = False
    MapsScraper._driver_startup_failed = False
    MapsScraper._spawn_failed = False

    with patch("sys.platform", "linux"):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            scout_id="scout_empty_posix",
            nonce="nonce_empty_posix",
            posix_identity_confirmed=True,
        )
        assert res is True
        msg = json.loads(out_s.getvalue().strip())
        assert msg["type"] == "MAST_JOB_TERMINATED"
        assert msg["scoutId"] == "scout_empty_posix"
        assert msg["nonce"] == "nonce_empty_posix"
        assert msg["status"] == "CONFIRMED"


def test_uncoordinated_legacy_does_not_falsely_report_termination():
    """Item 3: Uncoordinated legacy session does not falsely report coordinated termination."""
    import service
    service._MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    old_scout = service._MAST_SCOUT_SESSION_ID
    old_nonce = service._MAST_STARTUP_NONCE
    service._MAST_SCOUT_SESSION_ID = None
    service._MAST_STARTUP_NONCE = None

    old_env_scout = os.environ.pop("MAST_SCOUT_SESSION_ID", None)
    old_env_nonce = os.environ.pop("MAST_STARTUP_NONCE", None)
    old_env_req = os.environ.pop("MAST_COORDINATION_REQUIRED", None)

    try:
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            scout_id=None,
            nonce=None,
        )
        assert res is False
        assert out_s.getvalue() == "", "Uncoordinated legacy must never emit MAST_JOB_TERMINATED"
    finally:
        service._MAST_SCOUT_SESSION_ID = old_scout
        service._MAST_STARTUP_NONCE = old_nonce
        if old_env_scout:
            os.environ["MAST_SCOUT_SESSION_ID"] = old_env_scout
        if old_env_nonce:
            os.environ["MAST_STARTUP_NONCE"] = old_env_nonce
        if old_env_req:
            os.environ["MAST_COORDINATION_REQUIRED"] = old_env_req
