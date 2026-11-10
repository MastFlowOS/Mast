"""
Mast Lead Engine — Service Entrypoint (Part 3 / Phase 2 addition, extended
in Phase 6 and Phase 7).

This is the ONLY new file added to the engine. It does not modify
scraper/, enrichment/, storage/, scoring/, or utils/ in any way — it only
imports and orchestrates them, the same way main.py already does.

Two operations, both usable as a library or as a subprocess:

1. SEARCH (Phase 2) — finds new places for a niche/city, streaming
   enriched, scored leads as they clear the pipeline:

       from service import run_query
       async for lead_dict in run_query(query="yoga studios", city="Austin"):
           ...

       echo '{"query":"yoga studios","city":"Austin","max_results":20}' \\
           | python service.py

2. VERIFY (Phase 7) — re-checks a single, already-known business's website
   and/or Instagram directly, with NO Maps search involved:

       from service import verify_business
       result = await verify_business(website="https://example.com", instagram="https://instagram.com/example")

       echo '{"website":"https://example.com","instagram":"https://instagram.com/example"}' \\
           | python service.py verify

Search mode is the default (no mode argument) for backward compatibility
with the Phase 2 Node bridge, which spawns `python service.py` with no
argv and writes params to stdin.
"""

from __future__ import annotations

import sys as _sys

# Milestone 2 (Engine 2.0 Enrichment Bridge): the `enrich` CLI mode's
# entire contract, like `verify`'s before it, is "stdout is exactly one
# JSON line" for pythonBridge.ts to JSON.parse() directly. utils/runtime.py
# — imported transitively by every project import below — configures
# `logging.basicConfig(stream=sys.stdout, ...)` at IMPORT TIME, so
# redirecting sys.stdout has to happen here, before that import runs, to
# have any effect; doing it inside _enrich_cli() (after imports already
# completed) is too late. `_REAL_STDOUT` is where _enrich_cli() writes its
# actual JSON result once everything else has finished logging to the now-
# redirected sys.stdout. Search/verify mode (no "enrich" argv) are
# unaffected — this only swaps sys.stdout under `enrich`.
_REAL_STDOUT = _sys.stdout
_JSON_CLI_MODES = ("enrich", "enrich-daemon", "score", "qualify", "prioritize", "workflow", "crm", "analytics", "ai_coach", "mission_intelligence", "feedback", "street_inventory")
if len(_sys.argv) > 1 and _sys.argv[1] in _JSON_CLI_MODES:
    _sys.stdout = _sys.stderr


import time as _time
# Phase 2A instrumentation: approximates the "Python imports" stage the
# audit asked for — the delta between this line (as early as the module
# can record a timestamp) and the point right after every project import
# below finishes. This does NOT capture interpreter startup itself (process
# spawn -> first bytecode of this file), which can only be measured from
# outside the process (e.g. at the Node bridge's spawn() call) — that
# boundary is out of scope for this phase (no TS changes), so it's reported
# as unmeasured rather than guessed at.
_IMPORTS_START_TS = _time.perf_counter()

import asyncio
import json
import logging
import os
import queue as thread_queue
import signal
import sys
import tempfile
import threading
import time
from typing import Any, AsyncIterator, Callable, Optional

SIGKILL = getattr(signal, "SIGKILL", 9)
SIGTERM = getattr(signal, "SIGTERM", 15)
import errno
import io

# Point 2: Prevent duplicate module loading when service.py is executed as __main__
if __name__ == "__main__":
    sys.modules.setdefault("service", sys.modules["__main__"])

# ==============================================================================
# Phase 7.3: OS-Level Process Ownership, Job Object, & Browser Session Identity
# ==============================================================================

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32

    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.GetCurrentProcess.argtypes = []

    kernel32.GetLastError.restype = wintypes.DWORD
    kernel32.GetLastError.argtypes = []

    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]

    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]

    kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    kernel32.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]

    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]

    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]

    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", wintypes.ULARGE_INTEGER),
            ("WriteOperationCount", wintypes.ULARGE_INTEGER),
            ("OtherOperationCount", wintypes.ULARGE_INTEGER),
            ("ReadTransferCount", wintypes.ULARGE_INTEGER),
            ("WriteTransferCount", wintypes.ULARGE_INTEGER),
            ("OtherTransferCount", wintypes.ULARGE_INTEGER),
        ]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
            ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryLimit", ctypes.c_size_t),
            ("PeakJobMemoryLimit", ctypes.c_size_t),
        ]

    class JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("TotalUserTime", wintypes.LARGE_INTEGER),
            ("TotalKernelTime", wintypes.LARGE_INTEGER),
            ("ThisPeriodTotalUserTime", wintypes.LARGE_INTEGER),
            ("ThisPeriodTotalKernelTime", wintypes.LARGE_INTEGER),
            ("TotalPageFaultCount", wintypes.DWORD),
            ("TotalProcesses", wintypes.DWORD),
            ("ActiveProcesses", wintypes.DWORD),
            ("TotalTerminatedProcesses", wintypes.DWORD),
        ]

    class JOBOBJECT_BASIC_PROCESS_ID_LIST(ctypes.Structure):
        _fields_ = [
            ("NumberOfAssignedProcesses", wintypes.DWORD),
            ("NumberOfProcessIdsInList", wintypes.DWORD),
            ("ProcessIdList", ctypes.c_size_t * 64),
        ]

    PROCESS_SET_QUOTA = 0x0100
    PROCESS_TERMINATE = 0x0001
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    JobObjectBasicAccountingInformation = 1
    JobObjectBasicProcessIdList = 3
    JobObjectExtendedLimitInformation = 9
    ERROR_ALREADY_EXISTS = 183
    ERROR_MORE_DATA = 234
else:
    # POSIX / fallback dummy classes for non-Windows test execution
    PROCESS_SET_QUOTA = 0x0100
    PROCESS_TERMINATE = 0x0001
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    JobObjectBasicAccountingInformation = 1
    JobObjectBasicProcessIdList = 3
    JobObjectExtendedLimitInformation = 9
    ERROR_ALREADY_EXISTS = 183
    ERROR_MORE_DATA = 234

    class JOBOBJECT_BASIC_PROCESS_ID_LIST:
        pass

    class DummyKernel32:
        def GetLastError(self): return 0
        def QueryInformationJobObject(self, *a, **k): return False
        def CreateJobObjectW(self, *a, **k): return None
        def SetInformationJobObject(self, *a, **k): return False
        def AssignProcessToJobObject(self, *a, **k): return False
        def OpenProcess(self, *a, **k): return None
        def TerminateJobObject(self, *a, **k): return False
        def CloseHandle(self, *a, **k): return False

    kernel32 = DummyKernel32()

_MAST_JOB_HANDLE: Any = None
_MAST_JOB_NAME: str | None = None
_MAST_SCOUT_SESSION_ID: str | None = None
_MAST_STARTUP_NONCE: str | None = None
_MAST_JOB_BOOTSTRAP_CONFIRMED: bool = False
_MAST_POSIX_BOOTSTRAP_CONFIRMED: bool = False
_MAST_TERMINATED_EMITTED: bool = False


def query_job_process_id_list(h_job: Any) -> tuple[int, int, list[int]]:
    """Query JobObjectBasicProcessIdList from the Windows Job Object.

    Returns:
    - (NumberOfAssignedProcesses, NumberOfProcessIdsInList, list_of_pids)
    - If the query fails or on non-Windows, returns (-1, -1, []).

    Invariants:
    - NumberOfAssignedProcesses is the true total count of processes assigned to the Job Object.
    - If the buffer is smaller than the assigned processes, QueryInformationJobObject fails with
      ERROR_MORE_DATA (234), but still populates NumberOfAssignedProcesses with the true count.
    - NumberOfProcessIdsInList is ONLY the count returned in this buffer.
    - An empty PID list (NumberOfProcessIdsInList == 0) MUST NEVER be treated as proof of 0 processes
      if NumberOfAssignedProcesses > 0.
    """
    if sys.platform != "win32" or not h_job:
        return -1, -1, []

    pid_list = JOBOBJECT_BASIC_PROCESS_ID_LIST()
    ret_len = wintypes.DWORD()
    ok = kernel32.QueryInformationJobObject(
        h_job,
        JobObjectBasicProcessIdList,
        ctypes.byref(pid_list),
        ctypes.sizeof(pid_list),
        ctypes.byref(ret_len),
    )
    if not ok:
        err = kernel32.GetLastError()
        if err == ERROR_MORE_DATA:
            # Buffer was too small to hold all PIDs, but NumberOfAssignedProcesses
            # contains the true total number of assigned processes!
            return int(pid_list.NumberOfAssignedProcesses), 0, []
        return -1, -1, []

    assigned = int(pid_list.NumberOfAssignedProcesses)
    in_list = int(pid_list.NumberOfProcessIdsInList)
    pids = [int(pid_list.ProcessIdList[i]) for i in range(min(in_list, 64))]
    return assigned, in_list, pids


def query_job_active_processes(h_job: Any, pid_list_query_fn: Any = None) -> int:
    """Return the current number of active processes in the Windows Job Object.

    Invariants:
    - Queries JobObjectBasicAccountingInformation for ActiveProcesses.
    - Queries JobObjectBasicProcessIdList for NumberOfAssignedProcesses and NumberOfProcessIdsInList.
    - Strictly requires NumberOfAssignedProcesses == 0. Never treats NumberOfAssignedProcesses >= 0 as sufficient.
    - Never treats NumberOfProcessIdsInList == 0 alone as proof if NumberOfAssignedProcesses > 0.
    - Returns 0 if and only if BOTH ActiveProcesses == 0 AND NumberOfAssignedProcesses == 0.
    - Returns -1 if any query fails or on non-Windows.
    """
    if sys.platform != "win32" or not h_job:
        return -1

    # 1. Query JobObjectBasicAccountingInformation
    acct = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
    ret_len = wintypes.DWORD()
    success = kernel32.QueryInformationJobObject(
        h_job,
        JobObjectBasicAccountingInformation,
        ctypes.byref(acct),
        ctypes.sizeof(acct),
        ctypes.byref(ret_len),
    )
    if not success:
        return -1
    active_acct = int(acct.ActiveProcesses)

    # 2. Query JobObjectBasicProcessIdList
    _pid_query = pid_list_query_fn or query_job_process_id_list
    assigned_count, in_list_count, _ = _pid_query(h_job)
    if assigned_count < 0:
        return -1

    # Invariant: If NumberOfAssignedProcesses > 0, processes remain assigned.
    # An empty returned PID list (in_list_count == 0) cannot bypass assigned_count > 0!
    if assigned_count > 0:
        return max(active_acct, assigned_count)

    if active_acct > 0:
        return active_acct

    # Strictly verified: ActiveProcesses == 0 AND NumberOfAssignedProcesses == 0
    return 0


def assign_pid_to_windows_job(h_job: Any, pid: int) -> bool:
    """Assign an external process (e.g. Playwright driver) to the Windows Job Object.
    Opens the process with PROCESS_SET_QUOTA | PROCESS_TERMINATE rights, assigns it,
    and closes the temporary process handle.
    Returns True if successfully assigned, False otherwise.
    """
    if sys.platform != "win32" or not h_job or pid <= 0:
        return False
    h_proc = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, wintypes.DWORD(pid))
    if not h_proc:
        return False
    try:
        ok = kernel32.AssignProcessToJobObject(h_job, h_proc)
        return bool(ok)
    finally:
        kernel32.CloseHandle(h_proc)


def close_windows_job_handle(h_job: Any = None) -> bool:
    """Safely close a Windows Job Object handle and reset the global state."""
    global _MAST_JOB_HANDLE
    target = h_job if h_job is not None else _MAST_JOB_HANDLE
    if sys.platform != "win32" or not target:
        return False
    try:
        res = kernel32.CloseHandle(target)
        if target == _MAST_JOB_HANDLE:
            _MAST_JOB_HANDLE = None
        return bool(res)
    except Exception:
        return False


def get_current_job_handle() -> Any:
    """Return the active Windows Job Object handle for this process, or None."""
    global _MAST_JOB_HANDLE
    return _MAST_JOB_HANDLE


def confirm_and_emit_job_terminated(
    out_stream: Any = None,
    err_stream: Any = None,
    h_job: Any = None,
    scout_id: str | None = None,
    nonce: str | None = None,
    posix_identity_confirmed: bool | None = None,
) -> bool:
    """Authoritatively verify that the browser process tree has terminated,
    and if verified, emit the authenticated MAST_JOB_TERMINATED message.

    Windows Invariant:
    - Coordinated session requires a valid initialized Job Object handle.
    - Missing Job Object handle leaves termination unconfirmed (returns False).
    - Positively verifies the Job Object reports ActiveProcesses == 0.
    - If ActiveProcesses > 0, attempts TerminateJobObject and verifies ActiveProcesses == 0.
    - If Job Object verification fails, never emits MAST_JOB_TERMINATED.

    POSIX Invariant:
    - Coordinated session requires a valid initialized process ownership identity.
    - If a browser/driver was launched, verifies process group extinction via os.killpg(pgid, 0) -> ESRCH.
    - EPERM and unexpected OS errors are never treated as successful termination.
    - If no browser was launched (empty launch), confirms termination ONLY IF process ownership
      identity was genuinely initialized and browser/driver ownership state is confirmed empty.
    - Missing process ownership identity leaves termination unconfirmed (returns False).

    Common Invariants:
    - Preserves uncoordinated legacy behavior without falsely reporting coordinated termination.
    - Only emits for coordinated sessions (where scoutId and nonce are present).
    - Includes scoutId and nonce for Node authentication.
    - Idempotent: emits at most once per process.
    - Flushes the message immediately to stdout.
    """
    global _MAST_TERMINATED_EMITTED, _MAST_JOB_HANDLE, _MAST_SCOUT_SESSION_ID, _MAST_STARTUP_NONCE, _MAST_POSIX_BOOTSTRAP_CONFIRMED

    if _MAST_TERMINATED_EMITTED:
        return True

    resolved_scout_id = scout_id or _MAST_SCOUT_SESSION_ID or os.environ.get("MAST_SCOUT_SESSION_ID")
    resolved_nonce = nonce or _MAST_STARTUP_NONCE or os.environ.get("MAST_STARTUP_NONCE")
    coordination_required = (os.environ.get("MAST_COORDINATION_REQUIRED") in ("1", "true", "TRUE"))
    is_coordinated = coordination_required or bool(resolved_scout_id and resolved_nonce)

    if not is_coordinated:
        # Uncoordinated legacy session: do not emit MAST_JOB_TERMINATED
        return False

    if not resolved_scout_id or not resolved_nonce:
        if err_stream:
            err_stream.write("[MAST_FATAL] Coordinated session missing scout ID or nonce at termination\n")
            err_stream.flush()
        return False

    verified = False
    if sys.platform == "win32":
        target_job = h_job if h_job is not None else _MAST_JOB_HANDLE
        if target_job is not None:
            verified = terminate_and_verify_windows_job(target_job, timeout_s=5.0)
            if target_job == _MAST_JOB_HANDLE:
                close_windows_job_handle(target_job)
        else:
            # Coordinated on Windows requires a valid initialized Job Object handle.
            # Missing handle means ownership identity is missing -> unconfirmed.
            verified = False
    else:
        # POSIX
        ms = sys.modules.get("scraper.maps_scraper")
        if ms is not None and hasattr(ms, "MapsScraper"):
            ScraperCls = getattr(ms, "MapsScraper")
        else:
            try:
                from scraper.maps_scraper import MapsScraper as ScraperCls
            except ImportError:
                ScraperCls = None

        pgid = getattr(ScraperCls, "_last_browser_pgid", None) if ScraperCls else None
        driver_pid = getattr(ScraperCls, "_last_driver_pid", None) if ScraperCls else None
        failed_startup = getattr(ScraperCls, "_driver_startup_failed", False) if ScraperCls else False
        spawn_failed = getattr(ScraperCls, "_spawn_failed", False) if ScraperCls else False
        spawn_attempted = getattr(ScraperCls, "_browser_spawn_attempted", False) if ScraperCls else False

        posix_init = (
            posix_identity_confirmed
            if posix_identity_confirmed is not None
            else _MAST_POSIX_BOOTSTRAP_CONFIRMED
        )

        has_invalid_ident = (
            (pgid is not None and (not isinstance(pgid, int) or pgid <= 0))
            or (driver_pid is not None and (not isinstance(driver_pid, int) or driver_pid <= 0))
        )
        if ScraperCls is None:
            # Cannot establish scraper process tracking state; fail closed
            verified = False
        elif has_invalid_ident:
            # Corrupted / invalid process identity cannot be verified
            verified = False
        elif pgid is not None and pgid > 0:
            verified = terminate_and_verify_posix_group(pgid, timeout_s=5.0)
        elif driver_pid is not None and driver_pid > 0:
            verified = terminate_and_verify_posix_pid(driver_pid, timeout_s=5.0)
        elif posix_init is True:
            # Empty-launch ownership state verification:
            # Explicit evidence required:
            # 1. POSIX ownership initialization succeeded (posix_init is True).
            # 2. Both retained process identities are genuinely absent (pgid is None and driver_pid is None).
            # 3. No driver or browser process was spawned during this lifecycle (not spawn_attempted).
            # 4. No failed spawn or PID-discovery operation could have left an untracked process
            #    (not failed_startup and not spawn_failed).
            if (
                pgid is None
                and driver_pid is None
                and not spawn_attempted
                and not failed_startup
                and not spawn_failed
            ):
                verified = True
            else:
                verified = False
        else:
            # Missing process ownership identity; cannot confirm termination
            verified = False

    if not verified:
        log.warning(f"[service] Process-tree termination UNCONFIRMED for scout {resolved_scout_id} — suppressing MAST_JOB_TERMINATED")
        if err_stream:
            err_stream.write(f"[service] Process-tree termination UNCONFIRMED for scout {resolved_scout_id}\n")
            err_stream.flush()
        return False

    target_out = out_stream if out_stream is not None else getattr(sys, "_REAL_STDOUT", sys.stdout)
    term_msg = {
        "type": "MAST_JOB_TERMINATED",
        "scoutId": resolved_scout_id,
        "nonce": resolved_nonce,
        "status": "CONFIRMED",
    }
    try:
        target_out.write(json.dumps(term_msg) + "\n")
        target_out.flush()
        _MAST_TERMINATED_EMITTED = True
        return True
    except Exception as exc:
        log.warning(f"[service] Failed to write MAST_JOB_TERMINATED: {exc}")
        return False



def terminate_and_verify_windows_job(
    h_job: Any,
    timeout_s: float = 5.0,
    poll_interval_s: float = 0.05,
    query_fn: Any = None,
) -> bool:
    """Terminate all processes in the Windows Job Object and poll until ActiveProcesses == 0.
    Never reports True merely because TerminateJobObject succeeded.
    Returns True if and only if ActiveProcesses is confirmed to be 0 within timeout_s.
    """
    if sys.platform != "win32" or not h_job:
        return False

    _query = query_fn or query_job_active_processes
    active = _query(h_job)
    if active == 0:
        return True

    kernel32.TerminateJobObject(h_job, 1)

    deadline = time.monotonic() + max(0.05, timeout_s)
    while time.monotonic() < deadline:
        active = _query(h_job)
        if active == 0:
            return True
        time.sleep(poll_interval_s)

    active = _query(h_job)
    return active == 0


def _is_process_group_extinct(pgid: int, killpg_fn: Any) -> bool:
    """Positive POSIX process group absence verification via os.killpg(pgid, 0).

    Returns:
    - True if and only if errno.ESRCH is raised (process group does not exist).
    - False if killpg(pgid, 0) succeeds (group exists and is alive).
    - False if errno.EPERM is raised (group exists, permission denied; NOT terminated).
    - False on any other OSError or unexpected error.
    """
    try:
        killpg_fn(pgid, 0)
        return False  # Succeeded: group exists and is alive
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return True  # ESRCH: Process group positively confirmed extinct
        elif exc.errno == errno.EPERM:
            return False  # EPERM: Process group exists, not terminated
        else:
            return False  # Unexpected OS errors must not be treated as termination
    except Exception:
        return False


def terminate_and_verify_posix_group(
    pgid: int,
    timeout_s: float = 5.0,
    poll_interval_s: float = 0.05,
    graceful_signal: int = SIGTERM,
    grace_period_s: float = 0.1,
    kill_fn: Any = None,
) -> bool:
    """Terminate a detached POSIX process group and poll until ESRCH confirms that
    zero processes remain in that process group.

    Uses os.killpg(pgid, 0) for existence checks:
    - ESRCH means the process group no longer exists.
    - EPERM means the process group exists but permission denied (must NOT count as termination).
    - Other errors are not interpreted as successful termination.
    - Preserves bounded waiting and SIGTERM/SIGKILL escalation.
    - Never reports True merely because a signal was sent.
    """
    if pgid <= 0:
        return False

    if kill_fn is not None:
        _killpg = kill_fn
    elif hasattr(os, "killpg"):
        _killpg = os.killpg
    else:
        # Fallback on non-POSIX platforms when unmocked
        _killpg = lambda p, s: False

    def _try_reap() -> None:
        if hasattr(os, "waitpid") and hasattr(os, "WNOHANG"):
            try:
                os.waitpid(-pgid, os.WNOHANG)
            except OSError:
                pass

    _try_reap()
    # 1. Initial check: Is the process group already extinct?
    if _is_process_group_extinct(pgid, _killpg):
        return True

    # 2. Graceful termination stage (SIGTERM)
    if graceful_signal and grace_period_s > 0:
        try:
            _killpg(pgid, graceful_signal)
        except OSError as exc:
            if exc.errno == errno.ESRCH:
                return True
        except Exception:
            pass

        grace_deadline = time.monotonic() + grace_period_s
        while time.monotonic() < grace_deadline:
            time.sleep(poll_interval_s)
            _try_reap()
            if _is_process_group_extinct(pgid, _killpg):
                return True

    # 3. Forced termination stage (SIGKILL)
    try:
        _killpg(pgid, SIGKILL)
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return True
    except Exception:
        pass

    # 4. Bounded polling until ESRCH
    deadline = time.monotonic() + max(0.05, timeout_s)
    while time.monotonic() < deadline:
        time.sleep(poll_interval_s)
        _try_reap()
        if _is_process_group_extinct(pgid, _killpg):
            return True

    # Final positive verification
    _try_reap()
    return _is_process_group_extinct(pgid, _killpg)


def terminate_and_verify_windows_pid(
    pid: int,
    timeout_s: float = 5.0,
    poll_interval_s: float = 0.05,
    wait_fn: Any = None,
) -> bool:
    """Explicitly terminate an unassigned Windows process by PID and verify OS-level exit.
    Returns True if and only if the process is confirmed to have exited within timeout_s.
    """
    if sys.platform != "win32" or pid <= 0:
        return False

    if wait_fn is not None:
        return bool(wait_fn(pid, timeout_s))

    SYNCHRONIZE = 0x00100000
    PROCESS_TERMINATE = 0x0001
    h_proc = kernel32.OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, False, wintypes.DWORD(pid))
    if not h_proc:
        try:
            os.kill(pid, 0)
            return False
        except OSError as exc:
            if getattr(exc, "winerror", None) == 87 or exc.errno == errno.ESRCH:
                return True
            return False

    try:
        kernel32.TerminateProcess(h_proc, 1)
        timeout_ms = int(max(0.05, timeout_s) * 1000)
        res = kernel32.WaitForSingleObject(h_proc, wintypes.DWORD(timeout_ms))
        return res == 0
    finally:
        kernel32.CloseHandle(h_proc)


def _is_pid_extinct(pid: int, kill_fn: Any) -> bool:
    """Check if a POSIX process PID no longer exists using kill(pid, 0)."""
    try:
        kill_fn(pid, 0)
        return False
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return True
        elif exc.errno == errno.EPERM:
            return False
        else:
            return False
    except Exception:
        return False


def terminate_and_verify_posix_pid(
    pid: int,
    timeout_s: float = 5.0,
    poll_interval_s: float = 0.05,
    graceful_signal: int = SIGTERM,
    grace_period_s: float = 0.1,
    kill_fn: Any = None,
) -> bool:
    """Explicitly terminate an individual POSIX process by PID and poll until ESRCH confirms exit.
    Returns True if and only if ESRCH is observed within timeout_s.
    """
    if pid <= 0:
        return False
    _kill = kill_fn or os.kill

    if _is_pid_extinct(pid, _kill):
        return True

    if graceful_signal and grace_period_s > 0:
        try:
            _kill(pid, graceful_signal)
        except OSError as exc:
            if exc.errno == errno.ESRCH:
                return True
        except Exception:
            pass

        grace_deadline = time.monotonic() + grace_period_s
        while time.monotonic() < grace_deadline:
            if _is_pid_extinct(pid, _kill):
                return True
            time.sleep(poll_interval_s)

    try:
        _kill(pid, SIGKILL)
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return True
    except Exception:
        pass

    deadline = time.monotonic() + max(0.05, timeout_s)
    while time.monotonic() < deadline:
        if _is_pid_extinct(pid, _kill):
            return True
        time.sleep(poll_interval_s)

    return _is_pid_extinct(pid, _kill)


def bootstrap_windows_job_object(
    job_name: str | None = None,
    scout_id: str | None = None,
    nonce: str | None = None,
    in_stream: Any = None,
    out_stream: Any = None,
    err_stream: Any = None,
    assign_self: bool = False,
) -> bool:
    """Bootstrap a Windows Job Object with KILL_ON_JOB_CLOSE and execute
    the MAST_JOB_READY / MAST_JOB_ACK handshake with Node.

    CRITICAL Phase 7.3 Ownership Model:
    Python creates and owns the named Job Object, but Python MUST NOT assign itself
    to the Job Object. The Job Object is dedicated to the browser process tree
    (Playwright driver and Chromium child processes). Terminating the Job Object
    kills the browser processes while Python survives to confirm ActiveProcesses == 0.

    Returns True if Job Object bootstrap was successfully executed and confirmed.
    Returns False if required environment variables are absent (legacy / uncoordinated mode).
    Exits with code 78 (EX_CONFIG) on Job Object configuration failure.
    Exits with code 79 on handshake failure / invalid ACK.
    """
    global _MAST_JOB_HANDLE, _MAST_JOB_NAME, _MAST_SCOUT_SESSION_ID, _MAST_STARTUP_NONCE, _MAST_JOB_BOOTSTRAP_CONFIRMED

    if _MAST_JOB_BOOTSTRAP_CONFIRMED:
        return True

    if in_stream is None:
        in_stream = sys.stdin
    if out_stream is None:
        out_stream = _REAL_STDOUT
    if err_stream is None:
        err_stream = sys.stderr

    resolved_job_name = job_name or os.environ.get("MAST_JOB_NAME")
    resolved_scout_id = scout_id or os.environ.get("MAST_SCOUT_SESSION_ID")
    resolved_nonce = nonce or os.environ.get("MAST_STARTUP_NONCE")

    # Point 1: Missing coordination configuration cannot silently bypass containment
    coordination_indicated = (
        bool(job_name or os.environ.get("MAST_JOB_NAME"))
        or bool(scout_id or os.environ.get("MAST_SCOUT_SESSION_ID"))
        or bool(nonce or os.environ.get("MAST_STARTUP_NONCE"))
        or (os.environ.get("MAST_COORDINATION_REQUIRED") in ("1", "true", "TRUE"))
    )

    if coordination_indicated:
        if not (resolved_job_name and resolved_scout_id and resolved_nonce):
            err_stream.write(
                f"[MAST_FATAL] Incomplete Job Object coordination parameters: "
                f"job_name={resolved_job_name!r}, scout_id={resolved_scout_id!r}, nonce={resolved_nonce!r}\n"
            )
            err_stream.flush()
            sys.exit(78)
    else:
        return False

    if sys.platform != "win32":
        err_stream.write("[MAST_FATAL] MAST_JOB_NAME configured on non-Windows platform.\n")
        err_stream.flush()
        sys.exit(78)

    # 1. Validate Job Object naming prefix (reject unauthorized namespaces)
    if not resolved_job_name.startswith("Local\\MAST_JOB_"):
        err_stream.write(f"[MAST_FATAL] Invalid Job Object prefix: {resolved_job_name}\n")
        err_stream.flush()
        sys.exit(78)

    # 2. Create Job Object
    h_job = kernel32.CreateJobObjectW(None, resolved_job_name)
    if not h_job:
        err = kernel32.GetLastError()
        err_stream.write(f"[MAST_FATAL] CreateJobObjectW failed with error {err}\n")
        err_stream.flush()
        sys.exit(78)

    # 3. Reject reuse of already-existing Job Object (prevent name hijacking / process reuse)
    if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(h_job)
        err_stream.write(f"[MAST_FATAL] Job Object {resolved_job_name} already exists! Aborting.\n")
        err_stream.flush()
        sys.exit(78)

    # 4. Configure JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(
        h_job,
        JobObjectExtendedLimitInformation,
        ctypes.byref(limits),
        ctypes.sizeof(limits),
    ):
        err = kernel32.GetLastError()
        kernel32.CloseHandle(h_job)
        err_stream.write(f"[MAST_FATAL] SetInformationJobObject failed: {err}\n")
        err_stream.flush()
        sys.exit(78)

    # Note: Python MUST NOT assign itself to the Job Object. Python remains outside the Job Object.
    # The Job Object starts with ActiveProcesses == 0.

    # Retain handle globally in memory so it remains open for the lifetime of this process
    _MAST_JOB_HANDLE = h_job
    _MAST_JOB_NAME = resolved_job_name
    _MAST_SCOUT_SESSION_ID = resolved_scout_id
    _MAST_STARTUP_NONCE = resolved_nonce

    # 5. Emit MAST_JOB_READY handshake message to stdout
    ready_msg = {
        "type": "MAST_JOB_READY",
        "scoutId": resolved_scout_id,
        "jobName": resolved_job_name,
        "nonce": resolved_nonce,
        "pid": os.getpid(),
    }
    out_stream.write(json.dumps(ready_msg) + "\n")
    out_stream.flush()

    # 6. Await MAST_JOB_ACK from Node on stdin
    ack_line = in_stream.readline()
    if not ack_line:
        close_windows_job_handle(h_job)
        err_stream.write("[MAST_FATAL] EOF received while awaiting MAST_JOB_ACK.\n")
        err_stream.flush()
        sys.exit(79)

    try:
        ack_payload = json.loads(ack_line.strip())
    except Exception as exc:
        close_windows_job_handle(h_job)
        err_stream.write(f"[MAST_FATAL] Failed to parse MAST_JOB_ACK JSON: {exc}\n")
        err_stream.flush()
        sys.exit(79)

    if (
        ack_payload.get("type") != "MAST_JOB_ACK"
        or ack_payload.get("nonce") != resolved_nonce
        or ack_payload.get("status") != "CONFIRMED"
    ):
        close_windows_job_handle(h_job)
        err_stream.write(f"[MAST_FATAL] Invalid or rejected MAST_JOB_ACK: {ack_payload}\n")
        err_stream.flush()
        sys.exit(79)

    _MAST_JOB_BOOTSTRAP_CONFIRMED = True
    return True


def bootstrap_posix_process_identity(
    scout_id: str | None = None,
    nonce: str | None = None,
    in_stream: Any = None,
    out_stream: Any = None,
    err_stream: Any = None,
) -> bool:
    """Bootstrap POSIX process ownership identity and execute the
    MAST_JOB_READY / MAST_JOB_ACK handshake with Node.
    """
    global _MAST_SCOUT_SESSION_ID, _MAST_STARTUP_NONCE, _MAST_POSIX_BOOTSTRAP_CONFIRMED

    if _MAST_POSIX_BOOTSTRAP_CONFIRMED:
        return True

    if in_stream is None:
        in_stream = sys.stdin
    if out_stream is None:
        out_stream = _REAL_STDOUT
    if err_stream is None:
        err_stream = sys.stderr

    resolved_scout_id = scout_id or os.environ.get("MAST_SCOUT_SESSION_ID")
    resolved_nonce = nonce or os.environ.get("MAST_STARTUP_NONCE")
    coordination_indicated = (
        bool(scout_id or os.environ.get("MAST_SCOUT_SESSION_ID"))
        or bool(nonce or os.environ.get("MAST_STARTUP_NONCE"))
        or (os.environ.get("MAST_COORDINATION_REQUIRED") in ("1", "true", "TRUE"))
    )

    if coordination_indicated:
        if not (resolved_scout_id and resolved_nonce):
            err_stream.write(
                f"[MAST_FATAL] Incomplete POSIX coordination parameters: "
                f"scout_id={resolved_scout_id!r}, nonce={resolved_nonce!r}\n"
            )
            err_stream.flush()
            sys.exit(78)
    else:
        return False

    _MAST_SCOUT_SESSION_ID = resolved_scout_id
    _MAST_STARTUP_NONCE = resolved_nonce

    # Emit MAST_JOB_READY handshake message to stdout
    ready_msg = {
        "type": "MAST_JOB_READY",
        "scoutId": resolved_scout_id,
        "jobName": f"POSIX_PID_{os.getpid()}",
        "nonce": resolved_nonce,
        "pid": os.getpid(),
    }
    out_stream.write(json.dumps(ready_msg) + "\n")
    out_stream.flush()

    # Await MAST_JOB_ACK from Node on stdin
    ack_line = in_stream.readline()
    if not ack_line:
        err_stream.write("[MAST_FATAL] EOF received while awaiting MAST_JOB_ACK on POSIX.\n")
        err_stream.flush()
        sys.exit(79)

    try:
        ack_payload = json.loads(ack_line.strip())
    except Exception as exc:
        err_stream.write(f"[MAST_FATAL] Failed to parse MAST_JOB_ACK JSON on POSIX: {exc}\n")
        err_stream.flush()
        sys.exit(79)

    if (
        ack_payload.get("type") != "MAST_JOB_ACK"
        or ack_payload.get("nonce") != resolved_nonce
        or ack_payload.get("status") != "CONFIRMED"
    ):
        err_stream.write(f"[MAST_FATAL] Invalid or rejected MAST_JOB_ACK on POSIX: {ack_payload}\n")
        err_stream.flush()
        sys.exit(79)

    _MAST_POSIX_BOOTSTRAP_CONFIRMED = True
    return True


def bootstrap_process_ownership(
    job_name: str | None = None,
    scout_id: str | None = None,
    nonce: str | None = None,
    in_stream: Any = None,
    out_stream: Any = None,
    err_stream: Any = None,
    assign_self: bool = False,
) -> bool:
    """Bootstrap process ownership identity (Windows Job Object or POSIX session)
    and execute the MAST_JOB_READY / MAST_JOB_ACK handshake with Node.
    """
    if sys.platform == "win32":
        return bootstrap_windows_job_object(
            job_name=job_name,
            scout_id=scout_id,
            nonce=nonce,
            in_stream=in_stream,
            out_stream=out_stream,
            err_stream=err_stream,
            assign_self=assign_self,
        )
    else:
        return bootstrap_posix_process_identity(
            scout_id=scout_id,
            nonce=nonce,
            in_stream=in_stream,
            out_stream=out_stream,
            err_stream=err_stream,
        )


try:
    from exceptions import DiscoveryFailure, DiscoveryFailureReason
    from scraper.maps_scraper import MapsScraper
    from enrichment.site_crawler import SiteCrawler
    from enrichment.ig_intel import IGIntelligence
    from scoring.scorer import is_cannabis, is_chain
    from storage.dedup import LeadStore, fingerprints_for
    from utils.runtime import ProxyManager, RunStats, ScraperConfig, get_logger
    from utils.lifecycle_tracker import log_milestone
    from utils.perf import RunProfiler, NullProfiler
    from utils.pipeline_trace import PipelineTracer
    from utils.parsing import (
        is_valid_email,
        is_valid_phone,
        is_weak_site,
        normalize_phone,
        phone_dedup_key,
        resolve_region,
        select_primary_email,
    )
except ImportError:
    MapsScraper = None  # type: ignore

# Engine 2.0 — production entrypoint now drives discovery / enrichment /
# qualification / storage through the real seven-stage runtime instead of
# the old V1 EnrichmentPipeline (formerly scraper/pipeline.py, removed —
# it had no remaining importers). See the migration notes above
# run_query() for exactly what replaced what.
try:
    from engine.acceptance import LeadAcceptanceGate
    from engine.prune_reason_taxonomy import is_channel_potentially_satisfiable
    from engine.coordinator import EngineCoordinator
    from engine.contracts import QualifiedOpportunity, StoredOpportunity
    from engine.execution_driver import (
        ExecutionDriver,
        build_seven_stage_pipeline,
        run_batch_intelligence,
        DEFAULT_STAGE_CONCURRENCY,
    )
    from storage.early_persistent_dedup import PersistentEarlyDedupChecker, PersistentEarlyDedupError
    from providers.google_maps_provider import GoogleMapsProvider, GoogleMapsDiscoveryRequest
    from providers.overpass_provider import OverpassProvider
    from providers.discovery_composition import compose_discovery, NoRelevantProviderError
    from storage_backends.supabase_backend import SupabaseStorageBackend
    from storage_backends.batch_intelligence_backend import SupabaseBatchIntelligenceBackend
    from engine_enrichment_bridge import enrich_business as _engine_enrich_business
    from opportunity_scoring.service import OpportunityScoringService
    from opportunity_qualification.service import OpportunityQualificationService
    from crm_intelligence.service import CRMIntelligenceService
    from crm_intelligence.models import (
        RelationshipEvaluationRequest as CRMRelationshipRequest,
        InteractionRecord as CRMInteractionRecord,
        ContactPolicy as CRMContactPolicy,
    )
    from workers.scoring_worker import ScoringWorker
except ImportError:
    pass

_IMPORTS_DONE_TS = _time.perf_counter()
_IMPORTS_ELAPSED_MS = (_IMPORTS_DONE_TS - _IMPORTS_START_TS) * 1000.0

if "get_logger" in locals() and get_logger is not None:
    log = get_logger("service")
else:
    log = logging.getLogger("service")

if "EngineCoordinator" in locals() and EngineCoordinator is not None:
    engine_coordinator = EngineCoordinator()
else:
    engine_coordinator = None  # type: ignore

# Phase 2: module-level slot so _main_cli can read the profiler's summary
# after run_query's finally block has populated it.  This avoids changing
# run_query's public async-generator signature.
_last_perf_summary: dict = {}

# P1-A FIX — decouple outcome/progress IPC from the stage execution hot
# path. Root cause (see the accompanying fix report): `_on_progress()`
# below used to call `sys.stdout.write()` + `sys.stdout.flush()`
# synchronously, and it is invoked from inside
# `ExecutionDriver._execute_one()` (via `on_stage_outcome` ->
# `_combined_on_stage_outcome` -> `_emit_stage_outcome` -> `_emit` ->
# `on_progress`), under that method's own `_outcome_lock`.
# `_run_stage_pass()` calls `future.result()` on every `_execute_one()`
# future before advancing to the next pass, so stdout/pipe backpressure
# could gate Future resolution and therefore pass-to-pass throughput —
# even with real Website/Contact worker concurrency configured (=2).
#
# Fix: `_on_progress()` no longer touches stdout itself. It builds the
# exact same payload dict it always has (and still does all of its
# profiler.incr()/_mark() bookkeeping inline, synchronously, exactly as
# before — none of that is IO-bound, so none of it was ever part of the
# problem) and hands the payload to one dedicated `_ProgressEventWriter`
# per `run_query()` call, which owns every stdout write for that run on
# its own background thread. See that class's own docstring for the
# full ordering / overflow / shutdown / failure-handling design.
#
# Nothing in engine/execution_driver.py changes: `_execute_one()`,
# `_outcome_lock`, `_run_stage_pass()`, stage concurrency, PID/resource
# admission, and required-channel semantics are all untouched — this is
# a service.py-only fix, exactly matching "do not redesign the
# pipeline."
_PROGRESS_WRITER_QUEUE_MAXSIZE = 4096
_PROGRESS_WRITER_CRITICAL_ENQUEUE_TIMEOUT_S = 5.0
_PROGRESS_WRITER_SHUTDOWN_JOIN_TIMEOUT_S = 5.0
_PROGRESS_WRITER_DROP_LOG_INTERVAL = 200  # log 1 warning per N drops, not per drop
_PROGRESS_WRITER_STOP = object()  # sentinel; distinct from the pre-existing _SENTINEL below


class _ProgressEventWriter:
    """
    Dedicated single-writer thread that owns every `"type":"progress"`
    stdout write for one `run_query()` call (see the module-level
    comment above for why this exists). `_on_progress()` calls
    `enqueue()` instead of writing to stdout itself; `enqueue()`
    returns immediately in the overwhelmingly common case.

    Ordering
    --------
    One `queue.Queue`, one drainer thread: events are written in the
    exact order `enqueue()` was called, across every calling thread.
    This matches pre-fix behavior — each `_on_progress()` call fully
    completed its own write+flush before returning, so two events
    could never interleave mid-line, and the relative order between
    two DIFFERENT calling threads (e.g. a concurrent Website worker vs.
    the heartbeat ticker) was already whatever order they happened to
    call `_on_progress` in, same as `queue.Queue.put`/`get` preserves
    now. `ExecutionDriver._outcome_lock` still serializes
    `on_stage_outcome`/`on_stage_wallclock` calls for concurrent
    `_execute_one()` invocations of the same stage (unchanged, in
    execution_driver.py), so outcome-event ordering within a stage is
    exactly as deterministic as it was before this fix.

    Overflow behavior (bounded queue)
    ----------------------------------
    The queue is bounded (`maxsize=4096` — generous relative to any
    realistic per-run in-flight event count, so this path is not
    expected to trigger under normal load). Two enqueue paths,
    matching the fix's "distinguish telemetry-only from
    correctness-critical" requirement:

    * Telemetry-only events (ordinary non-terminal stage_completed/
      stage_failed, heartbeats, discovery round/panel telemetry,
      contact/instagram sub-event counters, site_class_* labels —
      i.e. anything with `terminal=False`): `put_nowait()`. On
      `queue.Full`, the event is dropped and a counter incremented; a
      warning logs every `_PROGRESS_WRITER_DROP_LOG_INTERVAL` drops
      (not per-drop, so sustained overflow can't itself become a new
      source of IO-bound backpressure via the logger). Safe because
      overflow only happens while a lot of OTHER traffic is already
      flowing through this same queue — the Node bridge's watchdog
      inactivity timer and `progressMarks` (first-occurrence only;
      see pythonBridge.ts ~L1018-1053) are already being fed by
      whichever events DID get through.

    * Correctness-critical events (`terminal=True` — the single
      candidate-terminal resolution per `pipeline_id`; see
      `_stage_outcome_terminality()` in engine/execution_driver.py):
      NEVER silently dropped. `enqueue()` first tries `put_nowait()`;
      on `queue.Full` it retries with a bounded blocking
      `put(timeout=5.0)` to absorb a transient writer stall. If still
      full after that, it falls back to writing this one event
      directly/synchronously on the calling thread — the same thing
      `_on_progress` always did pre-fix — logged as a degraded-mode
      fallback. This trades away this fix's throughput benefit for
      exactly one event, in an already-pathological situation, rather
      than ever losing a terminal event or blocking indefinitely (the
      5s timeout bounds the wait; this is never an untimed `put()`).

    Shutdown
    --------
    `stop()` enqueues a sentinel after every real event already
    enqueued (FIFO, so nothing queued ahead of it is skipped) and
    joins the drainer thread with a bounded timeout — every event
    queued before `stop()` was called is written before `stop()`
    returns, unless the drainer thread had already died (see below).

    Writer failure
    ---------------
    The drainer wraps each item's write in its own try/except:
    `BrokenPipeError`/`IOError`/`OSError` are swallowed exactly as
    `_on_progress` always swallowed them (a gone consumer is not this
    process's problem); any other unexpected exception is logged once
    and the loop continues with the next item, so one bad event can't
    silently kill the whole drainer (which would otherwise turn every
    later `enqueue()` into the 5s-timeout-then-direct-write fallback
    for critical events, and pure drops for telemetry ones). This
    degrades gracefully — never a deadlock, never a silently lost
    terminal event.
    """

    def __init__(self, *, maxsize: int = _PROGRESS_WRITER_QUEUE_MAXSIZE) -> None:
        self._queue: "thread_queue.Queue" = thread_queue.Queue(maxsize=maxsize)
        self._dropped_telemetry = 0
        self._dropped_heartbeats = 0
        self._drop_count_lock = threading.Lock()  # guards _dropped_telemetry and _dropped_heartbeats
        self._thread = threading.Thread(
            target=self._run, name="progress-event-writer", daemon=True,
        )
        self._thread.start()

    @property
    def dropped_telemetry(self) -> int:
        with self._drop_count_lock:
            return self._dropped_telemetry

    @property
    def dropped_heartbeats(self) -> int:
        with self._drop_count_lock:
            return self._dropped_heartbeats

    @staticmethod
    def _write_now(payload: dict) -> None:
        try:
            sys.stdout.write(json.dumps(payload, default=str) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, IOError, OSError):
            pass

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is _PROGRESS_WRITER_STOP:
                return
            try:
                self._write_now(item)
            except Exception:
                log.debug(
                    "progress-event-writer: unexpected error writing one "
                    "queued event -- dropping just this event, drainer "
                    "thread continues", exc_info=True,
                )

    def enqueue(self, payload: dict, *, critical: bool) -> None:
        try:
            self._queue.put_nowait(payload)
            return
        except thread_queue.Full:
            pass
        if not critical:
            is_heartbeat = payload.get("event") == "heartbeat"
            with self._drop_count_lock:
                self._dropped_telemetry += 1
                if is_heartbeat:
                    self._dropped_heartbeats += 1
                dropped = self._dropped_telemetry
                dropped_hb = self._dropped_heartbeats
            if is_heartbeat:
                log.warning(
                    "progress-event-writer: queue full, dropped heartbeat event (seq=%s, dropped_total=%d) "
                    "-- observable telemetry recorded; liveness monitoring at risk",
                    payload.get("seq"), dropped_hb,
                )
            elif dropped % _PROGRESS_WRITER_DROP_LOG_INTERVAL == 1:
                log.warning(
                    "progress-event-writer: queue full, dropped %d "
                    "telemetry-only progress event(s) so far this run "
                    "(correctness-critical/terminal events are never "
                    "dropped)", dropped,
                )
            return
        # Correctness-critical (terminal=True): give the writer a short
        # window to catch up before falling back to a direct write.
        try:
            self._queue.put(payload, timeout=_PROGRESS_WRITER_CRITICAL_ENQUEUE_TIMEOUT_S)
            return
        except thread_queue.Full:
            log.warning(
                "progress-event-writer: queue still full after %.1fs for "
                "a correctness-critical (terminal) event -- writing it "
                "directly/synchronously as a last-resort fallback rather "
                "than dropping it or blocking indefinitely",
                _PROGRESS_WRITER_CRITICAL_ENQUEUE_TIMEOUT_S,
            )
            self._write_now(payload)

    def stop(self, *, timeout: float = _PROGRESS_WRITER_SHUTDOWN_JOIN_TIMEOUT_S) -> None:
        try:
            self._queue.put(_PROGRESS_WRITER_STOP, timeout=timeout)
        except thread_queue.Full:
            log.warning(
                "progress-event-writer: could not enqueue shutdown "
                "sentinel within %.1fs (queue still full) -- joining the "
                "drainer thread anyway; any events still queued behind "
                "it will not be written before process exit", timeout,
            )
        self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            log.warning(
                "progress-event-writer: drainer thread did not stop "
                "within %.1fs -- leaving it running as a daemon thread "
                "(process exit will reap it; no worker thread is "
                "blocked on this)", timeout,
            )


_SENTINEL = object()

# LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
# module-level cooperative shutdown flag, set by _run_with_graceful_
# shutdown()'s SIGTERM handler and consulted by run_query() at safe
# checkpoints (between ExecutionDriver.run_once() passes, and once per
# discovered candidate via GoogleMapsDiscoveryRequest.should_stop) instead
# of the previous behavior of hard-cancelling the asyncio task.
#
# WHY NOT task.cancel(): run_query()'s production path drives
# ExecutionDriver.run_once() via `asyncio.to_thread(...)`, which runs on a
# real OS thread. asyncio.Task.cancel() cannot actually interrupt code
# already executing on that thread — it can only make the *awaiting*
# coroutine stop waiting for it. The previous implementation did exactly
# that: cancelling the outer task made `await asyncio.to_thread(...)`
# raise CancelledError immediately, while the underlying thread (Discovery
# stage -> GoogleMapsProvider -> MapsScraper, holding an open Playwright
# browser/context/page) kept running, orphaned, completely detached from
# the coroutine that was "waiting" for it. The main coroutine would then
# proceed straight into run_query()'s cleanup (and, if the process didn't
# exit fast enough, the Node bridge's escalation from SIGTERM to SIGKILL —
# see src/scraperBridge/pythonBridge.ts's gracefulKillProcessTree) while
# that orphaned thread was still actively calling into Playwright — the
# exact "Target page, context or browser has been closed" race reported
# from the live test.
#
# This flag fixes that at the root: nothing here ever force-interrupts
# in-flight thread work. Instead, discovery is given a cheap, frequent
# checkpoint (after every candidate it already streamed) to notice a stop
# request and simply stop asking Maps for more — the current
# `driver.run_once()` call is then allowed to return *normally*, at which
# point no thread is touching Playwright anymore and cleanup (including
# closing the browser) is safe. See `_run_with_graceful_shutdown` below
# for the (bounded) hard-cancel fallback kept as a last resort for a run
# that doesn't check this flag often enough to wind down in time.
_shutdown_event = threading.Event()
_shutdown_reason: Optional[str] = None


def _cleanup_stop_sentinel_file(pid: Optional[int] = None) -> bool:
    """Delete any stale or completed `mast_stop_<pid>.txt` sentinel file at startup or exit."""
    target_pid = pid if pid is not None else os.getpid()
    stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{target_pid}.txt")
    if os.path.exists(stop_file):
        try:
            os.remove(stop_file)
            return True
        except Exception:
            return False
    return False


def _get_shutdown_reason() -> Optional[str]:
    """
    Returns the cooperative shutdown reason if one was signaled by the parent
    process (via IPC stop-reason file or internal setter).
    """
    global _shutdown_reason
    if _shutdown_reason is not None:
        return _shutdown_reason
    stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{os.getpid()}.txt")
    if os.path.exists(stop_file):
        try:
            with open(stop_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    _shutdown_reason = content
                    return content
        except Exception:
            pass
    return None


def _set_shutdown_reason(reason: Optional[str]) -> None:
    """Explicit setter for in-process lifecycle tests."""
    global _shutdown_reason
    _shutdown_reason = reason


# LIFECYCLE FIX (FINAL SHUTDOWN LATENCY + CONSUMER_STOPPED FIX): both of
# these reasons mean "this run stopped on request, not because anything
# went wrong" — TARGET_REACHED (the parent request's target was already
# satisfied by a sibling) and CONSUMER_STOPPED (the Node bridge's own
# consumer, e.g. area rotation hitting its streaming batch quota, simply
# stopped iterating early; see pythonBridge.ts's `consumerStoppedEarly`).
# Previously only TARGET_REACHED was recognized here, so a plain area-
# worker rotation SIGTERM (reason=CONSUMER_STOPPED) fell through to the
# `else` branch at every call site below and was misreported as
# `DiscoveryFailure(CANCELLED)` — a normal, expected termination surfaced
# as a failure. USER_CANCELLED/WATCHDOG_TIMEOUT/unspecified are
# deliberately NOT included here: those must keep raising
# DiscoveryFailure(CANCELLED) unchanged (see module docstring — "Keep real
# crash/watchdog/user-cancelled semantics unchanged").
_NON_FAILURE_SHUTDOWN_REASONS = frozenset({"TARGET_REACHED", "CONSUMER_STOPPED"})


def _is_non_failure_shutdown(reason: Optional[str]) -> bool:
    return reason in _NON_FAILURE_SHUTDOWN_REASONS


# How long _run_with_graceful_shutdown waits for the cooperative shutdown
# above to finish on its own before escalating to a forced task
# cancellation (the old, unconditional behavior). Comfortably shorter than
# the Node bridge's own SIGTERM->SIGKILL grace period
# (GRACEFUL_SHUTDOWN_MS / SCRAPER_GRACEFUL_SHUTDOWN_MS in
# pythonBridge.ts — kept above this value there) so Python's own graceful
# path (which still gets to write __done__ and close resources in order)
# has a real chance to win the race before Node's hard kill would fire.
COOPERATIVE_SHUTDOWN_GRACE_S = 12.0

# LIFECYCLE FIX (FAST TARGET CLEANUP — FINAL SHUTDOWN LATENCY +
# CONSUMER_STOPPED FIX): the live run this fix responds to spent ~20s
# after TARGET_REACHED just waiting out this escalation window on unused
# sibling workers, even though `should_stop`/`_should_stop_discovery` were
# already true and there was no useful work left to wind down. That full
# 12s window exists to protect a run that's still actively finishing
# meaningful work (a genuine watchdog/user-cancel mid-scrape) — it is
# unnecessary generosity for a reason that already means "nothing useful
# is left to do", so those two reasons get a much shorter fuse before
# falling back to forced cancellation. Not zero: `run_query`'s own
# checkpoints (should_stop / the between-pass shutdown_event check) are
# frequent but not synchronous with an in-flight Playwright call, so a
# short window still lets an already-cheap checkpoint fire and exit
# cleanly instead of hitting the forced-cancellation path on every run.
FAST_SHUTDOWN_GRACE_S = 2.0


def _shutdown_grace_period_s(reason: Optional[str]) -> float:
    return FAST_SHUTDOWN_GRACE_S if _is_non_failure_shutdown(reason) else COOPERATIVE_SHUTDOWN_GRACE_S


def _build_storage_backend() -> SupabaseStorageBackend:
    """
    Engine 2.0 composition-root wiring for the Storage stage.
    SupabaseStorageBackend (storage_backends/supabase_backend.py) is the
    one concrete `_StoragePersistenceProtocol` implementation that exists
    today; it reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
    environment by default (see its own constructor docstring) — no new
    env var names invented here.
    """
    return SupabaseStorageBackend()


#: Phase 3C-4B — cached once per process. `_build_early_dedup_checker()`
#: is called on every `run_query()` invocation (unlike `_build_storage_backend`,
#: this one is optional and allowed to fail), so the attempt-and-log-once
#: behavior lives here rather than being repeated at every call site.
_early_dedup_checker_cache: "dict[str, Optional[PersistentEarlyDedupChecker]]" = {}


def _build_early_dedup_checker() -> Optional[PersistentEarlyDedupChecker]:
    """
    Composition-root wiring for Phase 3C-4B's early dedup stage. Same
    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env-var convention as
    `_build_storage_backend()` above — no new config surface. Unlike
    Storage, this is optional: a missing/invalid config must never break
    `run_query()`, since early dedup is a fast-reject optimization, not a
    required stage (Step 4). Constructed at most once per process and
    cached (including the "not configured" outcome) so a missing config
    doesn't get silently re-attempted (and re-logged) on every run_query()
    call within a long-lived worker process.
    """
    if "checker" in _early_dedup_checker_cache:
        return _early_dedup_checker_cache["checker"]
    try:
        checker: Optional[PersistentEarlyDedupChecker] = PersistentEarlyDedupChecker()
    except PersistentEarlyDedupError:
        log.info(
            "[early-dedup] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured — "
            "early persistent dedup disabled for this process; every candidate "
            "will still go through the existing final dedup unchanged."
        )
        checker = None
    _early_dedup_checker_cache["checker"] = checker
    return checker


def _build_batch_intelligence_backend() -> SupabaseBatchIntelligenceBackend:
    """
    Composition-root wiring for the Persistence Integration milestone's
    batch intelligence backend (storage_backends/batch_intelligence_backend.py).
    Identical env-var convention to `_build_storage_backend()` above —
    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, no new names invented.
    """
    return SupabaseBatchIntelligenceBackend()


class _StreamingStorageBackend:
    """
    Composition-root-only wrapper around the real
    `_StoragePersistenceProtocol` backend. StorageWorker (unmodified)
    only ever sees this wrapper's `persist()` — it has no idea a
    generator on the other side of a thread boundary is waiting for its
    result. This is the seam that lets run_query() stream a lead the
    moment it's actually persisted, without StorageWorker/ExecutionDriver
    knowing anything about asyncio, queues, or the Node bridge.

    INCIDENT FIX (qualified-but-never-delivered leads): `self._inner`
    (SupabaseStorageBackend) writes only an audit-trail row — pipeline_id
    plus a mint-on-insert id — into the provisional `qualified_opportunities`
    table (see migrations/021_qualified_opportunities.sql's own "FLAGGED,
    NOT AN ARCHITECTURE DECISION" header: that table is explicitly NOT the
    `leads` table the frontend reads). Node/the frontend never read that
    table directly — user-visible delivery happens entirely through
    `self._on_persisted` -> `result_q` -> `lead_dict` -> stdout -> Node's
    `deliverLead()` -> the real `leads` table (see service.py module
    docstring / run_query()'s drain loop).

    Before this fix, `self._inner.persist()` raising (bad table config,
    RLS/permission denial, wrong SUPABASE_URL/SERVICE_ROLE_KEY for this
    process, transient network failure — `SupabaseStorageBackend.persist()`
    is documented to never catch or retry) propagated out of this method,
    which `workers/storage_worker.py::StorageWorker.process()` also never
    catches. `engine/runtime.py::execute_stage()` then treated it as an
    ORDINARY worker failure — retried once, then silently dead-lettered —
    so `_on_persisted` was never called for that pipeline_id. The pipeline
    kept running and kept logging `candidate_qualified` for every later
    candidate, but zero leads were ever streamed to Node: the audit-row
    insert had become a single point of failure for delivery it was never
    supposed to gate.

    Fix: the audit-trail insert and the delivery signal are now
    independent. `self._inner.persist()` is attempted and its real
    `StoredOpportunity` is used when it succeeds; if it raises, that is
    logged loudly (so a real Supabase misconfiguration is visible instead
    of hiding behind a routine per-item dead-letter) and a fallback
    `StoredOpportunity` is synthesized from data already fully in hand
    (`opportunity.pipeline_id` — `opportunity_id` cannot be left None,
    since `StoredOpportunity.opportunity_id` is a required `str` field;
    see engine/contracts.py) so `_on_persisted` still fires and the
    already-qualified lead still reaches Node/the `leads` table. Storage
    audit-row failures no longer silently block delivery.
    """

    def __init__(self, inner: SupabaseStorageBackend, on_persisted) -> None:
        self._inner = inner
        self._on_persisted = on_persisted

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        try:
            stored = self._inner.persist(opportunity)
        except Exception as exc:  # noqa: BLE001 - audit-row failure must
            # never silently swallow a qualified lead's delivery; see this
            # class's own docstring, "INCIDENT FIX", for the full rationale.
            log.error(
                "[_StreamingStorageBackend] qualified_opportunities audit "
                "insert FAILED for pipeline_id=%s — delivering this lead to "
                "Node anyway from the in-memory QualifiedOpportunity, but "
                "this audit-trail failure needs investigating (it will "
                "recur for every subsequent qualified candidate until "
                "fixed): %s",
                opportunity.pipeline_id, exc, exc_info=True,
            )
            stored = StoredOpportunity(
                opportunity_id=f"unpersisted:{opportunity.pipeline_id}",
                pipeline_id=opportunity.pipeline_id,
                created_at=None,
            )
        self._on_persisted(opportunity, stored)
        return stored


def _first_unsatisfiable_channel(candidate, required_channels) -> Optional[str]:
    """
    Discovery-time early channel check for the discovery_only path.

    Delegates to the EXISTING `is_channel_potentially_satisfiable` rule
    (engine/prune_reason_taxonomy.py) — the same rule family
    ExecutionDriver._on_candidate applies — instead of re-implementing it.
    Returns the first required channel that is PROVEN unsatisfiable from
    discovery-time data (e.g. 'website' required but the candidate has none,
    which also covers the minimal stub MapsScraper yields when its detail
    panel fast-abort fires), or None when the candidate must proceed.

    No required_channels (the default) -> None: behavior is unchanged for
    every caller that does not opt in. Unknown channels never prune.
    """
    if not required_channels:
        return None
    for ch in required_channels:
        if not is_channel_potentially_satisfiable(candidate, ch):
            return ch
    return None


def _candidate_dict(candidate) -> dict:
    """BusinessCandidate -> plain dict, field-for-field, no new facts."""
    return {
        "pipeline_id": candidate.pipeline_id,
        "provider": candidate.provider,
        "maps_link": candidate.maps_url,
        "name": candidate.name,
        "category": candidate.category,
        "address": candidate.address,
        "city": candidate.city,
        "country": candidate.country,
        "website": candidate.website,
        "phone": candidate.phone,
        "rating": candidate.rating,
        "review_count": candidate.review_count,
        "reviews": candidate.review_count,
        "has_photos": getattr(candidate, "has_photos", None),
        "is_google_verified": getattr(candidate, "is_google_verified", None),
        "discovered_at": candidate.discovered_at,
    }


def _resolve_instagram_url(candidate, instagram_intel, contact_intel) -> str | None:
    """
    SCHEMA MISMATCH FIX (Node channelFilter vs Python Qualification):
    QualificationWorker's "instagram" required-channel rule
    (workers/qualification_worker.py) treats the channel as satisfied
    by ANY of three independent sources, in this priority order:

        1. business.instagram_url    — an authoritative URL a discovery
                                        provider (e.g. a future Maps
                                        variant) attached directly to
                                        the BusinessCandidate.
        2. instagram_intel           — InstagramWorker actually reached
                                        a live, reachable profile
                                        (`profile_reachable is True`).
        3. contact_intel.instagram_url — ContactWorker found an
                                        Instagram link on the business's
                                        own website/contact page (the
                                        "4-channel blocker fix" — see
                                        ContactIntel's docstring).

    `_opportunity_to_lead_dict` previously only ever read
    `instagram_intel.profile_url`, ignoring sources 1 and 3 entirely.
    That meant a candidate qualified by ContactWorker's site-discovered
    Instagram link (source 3 — the common real-world case once a
    profile itself is private/rate-limited/unreachable) was PASSED by
    QualificationWorker but then reached Node's `channelFilter.ts`
    (src/lib/channelFilter.ts, which independently re-checks
    `lead.instagram`) with an empty `instagram` field, and was silently
    rejected downstream with `channel_filter:[...]` even though
    Qualification had already said all four channels were satisfied.

    This resolver mirrors QualificationWorker's exact source priority
    and boolean semantics so the `instagram` value handed to Node is
    non-empty in precisely the cases QualificationWorker already
    counted as "has Instagram" — no channel semantics change, only the
    lead_dict's field now agrees with the decision already made.
    """
    if candidate is not None and getattr(candidate, "instagram_url", None):
        return candidate.instagram_url
    if (
        instagram_intel is not None
        and instagram_intel.profile_reachable is True
        and instagram_intel.profile_url
    ):
        return instagram_intel.profile_url
    if contact_intel is not None and getattr(contact_intel, "instagram_url", None):
        return contact_intel.instagram_url
    return None


def _build_field_provenance(
    *,
    candidate: Any,
    website_intel: Any,
    contact_intel: Any,
    email_sources: dict[str, str],
    phone_sources: dict[str, str],
    emails: list[str],
    phones: list[str],
) -> dict[str, dict[str, Any]]:
    """Per-field attribution in the shape the Node gateway's
    `buildFieldTrust` reads: ``{field: {value, source, method}}`` with
    ``method`` one of google_maps / website_crawl / schema_org / unknown.
    Only fields we actually have attribution for are emitted; nothing is
    fabricated. `source` is a real URL (the page the value came from)
    where one is known, else a provider id."""
    out: dict[str, dict[str, Any]] = {}
    provider = getattr(candidate, "provider", None) or "unknown"
    is_maps = "maps" in str(provider).lower()
    site_url = getattr(website_intel, "final_url", None) or getattr(candidate, "website", None) or ""
    contact_url = getattr(website_intel, "contact_page", None) or site_url

    def _page_url(role: str) -> str:
        return contact_url if role == "contact_page" else site_url

    def _entry(value: str, role: str) -> dict[str, Any]:
        if role == "provider":
            return {
                "value": value,
                "source": str(provider),
                "method": "google_maps" if is_maps else "unknown",
            }
        if role == "jsonld":
            return {"value": value, "source": site_url, "method": "schema_org"}
        return {"value": value, "source": _page_url(role), "method": "website_crawl"}

    if emails:
        out["email"] = _entry(emails[0], email_sources.get(emails[0], "website"))
    if phones:
        out["phone"] = _entry(phones[0], phone_sources.get(phones[0], "website"))
    if candidate is not None and getattr(candidate, "website", None):
        out["website"] = {
            "value": candidate.website,
            "source": str(provider),
            "method": "google_maps" if is_maps else "unknown",
        }
    return out


def _opportunity_to_lead_dict(
    opportunity: QualifiedOpportunity, stored: StoredOpportunity
) -> dict[str, Any]:
    """
    QualifiedOpportunity + StoredOpportunity -> the flat lead dict shape
    run_query() has always yielded, keeping the Node bridge's existing
    field names wherever an Engine 2.0 contract has an equivalent field
    (name/website/phone/rating/etc.), and adding the new engine's own
    identifiers (opportunity_id, pipeline_id, session_id) alongside them.
    """
    enriched = opportunity.business
    candidate = enriched.business if enriched else None
    website_intel = enriched.website_intel if enriched else None
    instagram_intel = enriched.instagram_intel if enriched else None
    contact_intel = enriched.contact_intel if enriched else None
    qualification = opportunity.qualification
    score = opportunity.score

    region = resolve_region(candidate.country) if candidate else None
    site_host = ""
    if candidate and candidate.website:
        site_host = candidate.website.split("//")[-1].split("/")[0].lower()

    # --- emails: provider-published + extracted, valid only, best first.
    email_sources: dict[str, str] = {}
    provider_email = getattr(candidate, "provider_email", None) if candidate else None
    if provider_email and is_valid_email(provider_email):
        email_sources[provider_email.strip().lower()] = "provider"
    if contact_intel and contact_intel.emails:
        _prov = dict(contact_intel.email_provenance or ())
        for e in contact_intel.emails:
            if is_valid_email(e):
                email_sources.setdefault(e.strip().lower(), _prov.get(e, "website"))
    emails = select_primary_email(list(email_sources), site_host)

    # --- phones: the provider's own number first (authoritative), then
    # extracted ones, normalized with the business's country and
    # de-duplicated on their canonical key (so one number written two
    # ways is never listed twice).
    phone_sources: dict[str, str] = {}
    seen_phone_keys: set[str] = set()

    def _add_phone(raw: Optional[str], source: str) -> None:
        if not raw:
            return
        norm = normalize_phone(raw, region) or (raw.strip() if is_valid_phone(raw) else "")
        key = phone_dedup_key(norm)
        if norm and key and key not in seen_phone_keys:
            seen_phone_keys.add(key)
            phone_sources[norm] = source

    _add_phone(candidate.phone if candidate else None, "provider")
    if contact_intel and contact_intel.phones:
        _pprov = dict(contact_intel.phone_provenance or ())
        for ph in contact_intel.phones:
            _add_phone(ph, _pprov.get(ph, "website"))
    phones = list(phone_sources)

    lead_dict: dict[str, Any] = {
        "pipeline_id": opportunity.pipeline_id,
        "session_id": opportunity.session_id,
        "opportunity_id": stored.opportunity_id,
        "stored_at": stored.created_at,
        "name": candidate.name if candidate else None,
        "category": candidate.category if candidate else None,
        "address": candidate.address if candidate else None,
        "city": candidate.city if candidate else None,
        "country": candidate.country if candidate else None,
        "website": candidate.website if candidate else None,
        "maps_link": candidate.maps_url if candidate else None,
        "rating": candidate.rating if candidate else None,
        "review_count": candidate.review_count if candidate else None,
        "reviews": candidate.review_count if candidate else None,
        "has_photos": getattr(candidate, "has_photos", None) if candidate else None,
        "is_google_verified": getattr(candidate, "is_google_verified", None) if candidate else None,
        "phone": phones[0] if phones else (candidate.phone if candidate else None),
        "phones": phones,
        "email": emails[0] if emails else None,
        "emails": emails,
        "website_reachable": website_intel.website_reachable if website_intel else None,
        # SCHEMA MISMATCH FIX: was `instagram_intel.profile_url if instagram_intel
        # else None`, which silently dropped the ContactWorker-discovered and
        # BusinessCandidate-level sources QualificationWorker's "instagram"
        # required-channel rule already accepts — see
        # `_resolve_instagram_url`'s own docstring above for the full
        # production trace (candidate_qualified -> storage success ->
        # NODE_RECEIVED -> REJECTED reason=channel_filter:[...]).
        "instagram": _resolve_instagram_url(candidate, instagram_intel, contact_intel),
        # Other channels ContactWorker extracts. Previously dropped here
        # even though the gateway / data model can carry them.
        "linkedin": contact_intel.linkedin_url if contact_intel else None,
        "whatsapp": contact_intel.whatsapp_link if contact_intel else None,
        "messenger": contact_intel.messenger_link if contact_intel else None,
        "telegram": contact_intel.telegram_link if contact_intel else None,
        "contact_form_url": contact_intel.contact_form_url if contact_intel else None,
        "field_provenance": _build_field_provenance(
            candidate=candidate,
            website_intel=website_intel,
            contact_intel=contact_intel,
            email_sources=email_sources,
            phone_sources=phone_sources,
            emails=emails,
            phones=phones,
        ),
        "ig_username": instagram_intel.username if instagram_intel else None,
        "ig_followers": instagram_intel.followers if instagram_intel else None,
        "ig_verified": instagram_intel.verified if instagram_intel else None,
        "score": score.opportunity_score if score else None,
        "tier": score.tier if score else None,
        "business_health_score": score.business_health_score if score else None,
        "qualified": qualification.qualified if qualification else None,
        "reasons": list(qualification.reasons) if qualification else [],
        "business_problems": list(qualification.business_problems) if qualification else [],
        "needed_services": list(qualification.needed_services) if qualification else [],
    }
    return lead_dict


async def run_query(
    *,
    query: str,
    city: str,
    country: str = "US",
    niche: str = "",
    region: str = "",
    area: str = "",
    max_results: int = 60,
    deliver_target: int | None = None,
    max_ig_followers: int = 5000,
    max_reviews: int = 500,
    min_score: int = 0,
    fast: bool = False,
    skip_ig: bool = False,
    skip_site_crawl: bool = False,
    require_viability: bool = True,
    discovery_only: bool = False,
    db_path: str = "data/leads.db",
    required_channels: Optional[list[str] | tuple[str, ...]] = None,
    # Phase 1A — the real requesting user_id for live discovery (threaded
    # from discoverJob.ts's `payload.userId` through pythonBridge.ts's
    # stdin JSON, via `_main_cli`'s `run_query(**params, ...)`). Optional
    # and defaults to None: any caller that doesn't pass it (pool-building,
    # tests, library use) gets the exact prior global-dedup behavior
    # unchanged. See build_seven_stage_pipeline's own `requesting_user_id`
    # param and storage/early_persistent_dedup.py's module docstring.
    user_id: Optional[str] = None,
    # LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
    # optional cooperative shutdown flag — see the module-level
    # `_shutdown_event` docstring above for why this replaced hard task
    # cancellation. `_main_cli` always passes the module-level event;
    # `None` (the default) preserves old behavior for any other caller
    # (library use, tests/validate_service_run_query.py) that doesn't
    # pass one — such a caller simply never requests early shutdown.
    known_place_ids: Optional[list[str]] = None,
    street_mode: bool = False,
    street: Optional[str] = None,
    shutdown_event: Optional[threading.Event] = None,
    shutdown_reason: Optional[str] = None,
) -> AsyncIterator[dict[str, Any]]:
    """
    Async generator now driven by Engine 2.0 instead of the V1
    MapsScraper -> EnrichmentPipeline asyncio-queue pipeline:

        discovery_only=True:
            GoogleMapsProvider.discover() (Engine 2.0's
            DiscoveryProviderInterface implementation, replacing this
            branch's former direct MapsScraper.search() call) streamed
            through a background thread, chain/cannabis-filtered and
            fingerprinted here exactly as before (see
            providers/google_maps_provider.py's own docstring, Ambiguity
            1/2, for why that filtering stays a caller/service.py
            responsibility rather than moving into the provider).

        discovery_only=False (production search):
            EngineCoordinator.create_session() -> start_session() ->
            build_seven_stage_pipeline() -> mark_running() assembles the
            full Discovery -> Website/Instagram/Contact -> Merge ->
            Qualification -> (Scoring, called synchronously) -> Storage
            graph (engine/execution_driver.py, unmodified). This
            generator then drives ExecutionDriver.run_once() itself, one
            pass at a time, off the event loop thread
            (asyncio.to_thread), and streams a lead dict the moment
            StorageWorker actually persists a QualifiedOpportunity (via
            _StreamingStorageBackend below) — the same "stream as it
            clears the pipeline" contract this generator has always had.

    Still yields one lead dict at a time, with `fingerprints` /
    `is_disqualified` attached the same way as before (LeadStore /
    fingerprints_for are V1 dedup-cache modules that Engine 2.0's
    StorageWorker deliberately does not replace — see
    workers/storage_worker.py / providers/google_maps_provider.py, both
    explicit that deduplication is not this milestone's job — so
    service.py, as composition root, keeps applying it exactly as
    before).

    `area` — AREA-SCOPE OVERPASS FIX (Phase 13C). Optional, more
    specific sub-city scope (e.g. a curated borough/neighborhood name
    such as "Brooklyn") already known by the caller for this run,
    forwarded unchanged to `compose_discovery()` -> `DiscoveryQueryContext`.
    Today this is consumed only by Overpass's own request translation
    (see providers/provider_request_translation.py), which prefers it
    over `city`/`country` for its `area_name` when present. Every
    other provider (including Google Maps), qualification, scoring,
    dedup, worker counts, and resource capacity are untouched by this
    parameter. Omitted (the default, `""`) preserves the exact prior
    city/country-scoped Overpass behavior for any existing caller that
    doesn't pass it — see providers/provider_request_translation.py's
    own docstring for the fallback rule.

    Known, intentional behavior changes from V1 (not bugs — see the
    accompanying migration review):
      * `fast`, `skip_ig`, `skip_site_crawl`, `max_ig_followers`,
        `max_reviews`, `require_viability` have no Engine 2.0 equivalent
        yet (WebsiteWorker/InstagramWorker/ContactWorker always run;
        QualificationWorker's only configuration is `niche` /
        `required_categories`). They are still accepted here so
        existing callers don't break, but are currently no-ops for the
        production (non discovery_only) path.
      * STALE NOTE, corrected (Phase 2B): this paragraph previously
        claimed discovery does not overlap with enrichment because
        DiscoveryWorker.process() blocks until its provider is
        exhausted. That was true of the ORIGINAL inline scheduling
        this driver used, but is no longer true of the pipeline this
        function actually drives. `ExecutionDriver` now runs every
        producer StageConfig (today: only Discovery) on its own
        dedicated thread, started as soon as this driver begins
        producing passes at all, decoupled from the transformer-stage
        pass loop (engine/execution_driver.py, "PHASE 2B FIX
        (continuous pipeline flow)"). `DiscoveryWorker.process()`
        still blocks its own thread until the provider is exhausted —
        that part of the quoted claim above was correct and remains
        unchanged (workers/discovery_worker.py, "Revision history,
        v3") — but that thread is no longer the same thread the
        Website/Instagram/Contact/Merge/Qualification/Storage passes
        run on, so it no longer blocks them. Each candidate is handed
        to `website_in`/`instagram_in` via `on_candidate` the instant
        it streams in (engine/execution_driver.py's `_on_candidate`),
        and the transformer-stage loop dequeues it immediately,
        concurrently with discovery still producing more candidates.
        `driver.producers_finished()` — not "every queue empty" — is
        what `_fully_drained()` below now checks before declaring
        genuine exhaustion, precisely because discovery may simply be
        between candidates. See tests/test_pipeline_continuous_flow.py
        for the regression coverage (including an instrumentation
        report asserting first_candidate_enqueued < discovery_complete)
        proving this actually holds for the real, unmodified
        `ExecutionDriver` + `build_seven_stage_pipeline()` this
        function drives.
    """
    _legacy_knobs_ignored = {
        k: v for k, v in {
            "fast": fast, "skip_ig": skip_ig, "skip_site_crawl": skip_site_crawl,
            "max_ig_followers": max_ig_followers if max_ig_followers != 5000 else None,
            "max_reviews": max_reviews if max_reviews != 500 else None,
            "require_viability": require_viability if require_viability is not True else None,
        }.items() if v
    }
    if _legacy_knobs_ignored and not discovery_only:
        log.warning(
            "[run_query] legacy knobs %s have no Engine 2.0 equivalent yet "
            "and are currently no-ops for the production pipeline",
            sorted(_legacy_knobs_ignored),
        )

    stats = RunStats()

    # Phase 2: create profiler for this run. Created before LeadStore
    # (Phase 2A reorder) so the fingerprint cache load (audit §3.7) can be
    # timed instead of running invisibly before any timer exists.
    profiler = RunProfiler()
    profiler.mark("python_imports_done")  # see _IMPORTS_ELAPSED_MS below

    def _google_maps_factory() -> Any:
        # PHASE 2B ROOT CAUSE FIX: threads this run's real `profiler`
        # into GoogleMapsProvider (see that class's own docstring) —
        # but via a `try/except TypeError` fallback rather than a bare
        # `GoogleMapsProvider(profiler=profiler)` call, because
        # `GoogleMapsProvider` here is looked up from THIS module's
        # global namespace at call time, and several existing tests
        # (e.g. tests/test_run_query_target_reached_lifecycle.py)
        # deliberately monkeypatch `service.GoogleMapsProvider` with a
        # zero-arg `lambda: fake_provider` to inject a fake — the
        # pre-existing test seam `compose_discovery()`'s own docstring
        # documents. A real `GoogleMapsProvider` accepts `profiler=`;
        # a zero-arg test fake does not, so the fallback preserves
        # that seam exactly as it worked before this phase.
        try:
            return GoogleMapsProvider(profiler=profiler)
        except TypeError:
            return GoogleMapsProvider()

    def _overpass_factory() -> Any:
        # PHASE 2B: same fix, same reasoning, for Overpass.
        try:
            return OverpassProvider(profiler=profiler)
        except TypeError:
            return OverpassProvider()

    store = LeadStore(db_path, profiler=profiler)

    # Phase S1: one PipelineTracer per run_query() call — lives entirely in
    # memory for the duration of this single engine run, discarded when
    # this generator returns. See utils/pipeline_trace.py.
    tracer = PipelineTracer()

    # _deliver_target is the number of qualified leads to yield before
    # declaring ourselves done.  It is always <= max_results (the raw
    # scan budget given to the discovery provider).  When the caller
    # passes deliver_target explicitly, we stop at that number;
    # otherwise we fall back to max_results for backward compatibility.
    _deliver_target: int = deliver_target if deliver_target is not None else max_results

    # Phase 1A (authoritative target/acceptance state): `gate` is the one
    # source of truth for requested/accepted/target-reached for this
    # request — see engine/acceptance.py. It replaces the old bare
    # `delivered` int, which every stop decision below used to read and
    # increment directly with no atomicity guarantee at all (safe only
    # because exactly one coroutine ever touched it). `gate.accepted` is
    # the drop-in equivalent of the old `delivered` value; nothing else in
    # this function tracks "how many leads have been accepted" anymore.
    gate = LeadAcceptanceGate(_deliver_target)
    _last_lead_time: float | None = None   # for inter-lead gap tracking
    log_milestone("Before run_query discovery starts")

    # PART E (Phase 2B — truthful first-lead latency): recorded once each,
    # the first time they happen, in wall-clock seconds since this
    # run_query() call started. Previously the only comparable metric was
    # the bridge's own (Node-side) firstLeadMs, which — per the Phase 2
    # forensic audit — actually measured "how long until the watchdog
    # forced a shutdown that then burst-processed one candidate", not a
    # real first-lead time. These marks are additive; nothing existing is
    # removed. `_mark()` only ever records the FIRST call for a given
    # name — later calls are no-ops — so these always reflect the first
    # occurrence even though multiple candidates/stages produce the same
    # event repeatedly over the run.
    _request_started_ts = time.perf_counter()
    _latency_marks: dict[str, float] = {}

    def _mark(name: str) -> None:
        if name not in _latency_marks:
            _latency_marks[name] = time.perf_counter() - _request_started_ts

    # P1-A FIX: one dedicated stdout-writer thread for this run_query()
    # call's entire `"type":"progress"` protocol -- see
    # `_ProgressEventWriter`'s own docstring above. `_on_progress()`
    # below enqueues onto this instead of writing to stdout itself.
    _progress_writer = _ProgressEventWriter()

    def _on_progress(
        stage: str,
        event: str,
        item_id: str | None,
        *,
        terminal: bool = False,
        dead_lettered: bool = False,
        pipeline_id: str | None = None,
        terminal_reason: str | None = None,
        seq: int | None = None,
        status: str | None = None,
        new_unique_ids: int | None = None,
        critical: bool = False,
    ) -> None:
        # PART C (Phase 2B — watchdog progress protocol): every one of
        # these events is written to the SAME stdout the lead dicts and
        # the __done__ sentinel already use, as its own one-line JSON
        # object, distinguished by `"type": "progress"` so
        # pythonBridge.ts can tell it apart from a real lead or the
        # __done__ sentinel without any ambiguity. This is deliberately
        # NOT routed through stderr (which the Node bridge already
        # ignores for watchdog purposes — stderr volume is not evidence
        # of protocol-level progress) and deliberately does not touch
        # sys.stdout redirection (that only happens for the separate
        # `enrich`/`score`/... JSON-CLI modes — see the top of this
        # file — never for this, the default search/production mode).
        # P1-A FIX: this used to be a synchronous `sys.stdout.write()` +
        # `sys.stdout.flush()` right here -- see the module-level
        # `_ProgressEventWriter` docstring for why that was gating
        # `ExecutionDriver._execute_one()` Future resolution and
        # therefore pass-to-pass throughput. The payload contents and
        # shape are byte-for-byte unchanged; only the delivery
        # mechanism (enqueue-and-return vs. write-and-flush-inline) is
        # different. `critical=terminal` is what lets the writer never
        # silently drop the one candidate-terminal event per
        # pipeline_id even under queue backpressure -- see that
        # docstring's "Overflow behavior" section.
        payload = {
            "type": "progress",
            "session_id": session_id,
            "stage": stage,
            "event": event,
            "item_id": item_id,
            # PHASE 5B-2 — additive lifecycle-accounting fields. A Node
            # bridge/consumer built against the pre-5B-2 protocol simply
            # never reads these keys; nothing about the pre-existing
            # "type"/"stage"/"event"/"item_id" fields changed.
            "pipeline_id": pipeline_id,
            "terminal": terminal,
            "dead_lettered": dead_lettered,
            "terminal_reason": terminal_reason,
            "timestamp": time.time(),
        }
        if seq is not None:
            payload["seq"] = seq
        if status is not None:
            payload["status"] = status
        if new_unique_ids is not None:
            payload["new_unique_ids"] = new_unique_ids
        _progress_writer.enqueue(payload, critical=(critical or terminal))

        if stage == "discovery" and event == "candidate_discovered":
            _mark("first_candidate_discovered")
            profiler.incr("raw_candidates")
        elif stage == "discovery" and event == "candidate_queued":
            _mark("first_candidate_accepted")
            profiler.incr("early_new")
        elif stage == "discovery" and event == "candidate_early_duplicate":
            profiler.incr("early_duplicates")
        elif event == "candidate_early_channel_pruned":
            # Emitted by discovery (pre-enqueue) and by website/contact
            # (post-enqueue, once a channel becomes provably unsatisfiable)
            # — see engine/execution_driver.py's `_on_candidate` /
            # `_on_enrichment_failure_outcome`. All three count toward the
            # same "early_pruned" area-sla figure; this stage never gets
            # fully enriched either way, so the distinction between
            # pre-enqueue and post-enqueue pruning doesn't change what the
            # figure is meant to answer ("how many candidates did the
            # pipeline give up on early").
            profiler.incr("early_pruned")
        elif event == "stage_completed" and stage in ("website", "instagram", "contact"):
            _mark("first_enrichment_completed")
        elif event == "stage_failed" and stage == "contact":
            profiler.incr("contact_failures")
        # Phase 8.1 (ContactWorker resilience fix) — additive per-page
        # counters, emitted alongside (never instead of) the existing
        # contact_stage_failed / contact_failures counters above. See
        # engine/execution_driver.py's `_contact_downstream`.
        elif stage == "contact" and event == "contact_page_fetch_failed":
            profiler.incr("contact_page_fetch_failures")
        elif stage == "contact" and event == "homepage_fetch_failed":
            profiler.incr("homepage_fetch_failures")
        elif stage == "contact" and event == "mailto_link_extracted":
            profiler.incr("mailto_links_extracted")
        elif stage == "contact" and event == "tel_link_extracted":
            profiler.incr("tel_links_extracted")
        elif stage == "contact" and event == "partial_contact_success":
            profiler.incr("partial_contact_successes")
        # Phase 14.2 (Instagram acquisition, quality-preserving) —
        # "Make Instagram telemetry truthful". Additive counters only;
        # never gate/prune anything. See engine/execution_driver.py's
        # `_instagram_downstream` / `_contact_downstream` for what each
        # event means and the InstagramIntel/ContactIntel fields it's
        # derived from.
        elif stage == "instagram" and event == "instagram_attempted":
            profiler.incr("instagram_attempted")
        elif stage == "instagram" and event == "instagram_url_input_present":
            profiler.incr("instagram_url_input_present")
        elif stage == "instagram" and event == "instagram_profile_reachable":
            profiler.incr("instagram_profile_reachable")
        elif stage == "instagram" and event == "instagram_short_circuited":
            profiler.incr("instagram_short_circuited")
        elif stage == "contact" and event.startswith("instagram_discovery_found:"):
            profiler.incr("instagram_discovery_found")
            profiler.incr(f"instagram_source_{event.rsplit(':', 1)[1]}")
        elif stage == "contact" and event == "instagram_discovery_invalid":
            profiler.incr("instagram_discovery_invalid")
        elif stage == "contact" and event == "instagram_discovery_missing":
            profiler.incr("instagram_discovery_missing")
        # Phase 15 (Email / Contact Acquisition telemetry)
        elif stage == "contact" and event == "email_secondary_page_fetched":
            profiler.incr("email_secondary_page_fetched")
        elif stage == "contact" and event == "email_secondary_page_found":
            profiler.incr("email_secondary_page_found")
        elif stage == "contact" and event == "email_acquired":
            profiler.incr("email_acquired")
        elif stage == "contact" and event == "email_missing_after_scan":
            profiler.incr("email_missing_after_scan")
        elif stage == "contact" and event == "phone_secondary_page_fetched":
            profiler.incr("phone_secondary_page_fetched")
        elif stage == "contact" and event == "phone_acquired":
            profiler.incr("phone_acquired")
        elif stage == "contact" and event == "phone_missing_after_scan":
            profiler.incr("phone_missing_after_scan")
        elif stage == "contact" and event == "secondary_page_fetch_failures":
            profiler.incr("secondary_page_fetch_failures")
        elif stage == "contact" and event == "secondary_fallback_attempted":
            profiler.incr("secondary_fallback_attempted")
        elif stage == "contact" and event == "secondary_fallback_success":
            profiler.incr("secondary_fallback_success")
        elif stage == "contact" and event == "secondary_fallback_fetch_failed":
            profiler.incr("secondary_fallback_fetch_failed")
        # Phase 9.1 (audit follow-up) — additive, observational only:
        # which broadened contact-page hint keyword WebsiteWorker's
        # secondary-page match used (contact/help/support/about/press/
        # careers/wholesale/partners/terms/policy/policies/locations).
        # Never gates anything; see engine/execution_driver.py's
        # `_website_downstream`.
        elif stage == "website" and event.startswith("contact_page_hint:"):
            profiler.incr(f"contact_page_hint_{event.rsplit(':', 1)[1]}")
        elif stage == "qualification" and event in (
            "niche_relevance_checked",
            "niche_relevance_passed",
            "niche_relevance_mismatch",
            "niche_relevance_ambiguous",
            "instagram_followers_over_limit",
        ):
            profiler.incr(event)
        elif stage == "qualification" and event == "candidate_qualified":
            _mark("first_candidate_qualified")
            profiler.incr("qualified")
        # Phase 3B-VALIDATION (observability only): these `site_class_*`
        # events are new, additive labels emitted alongside the existing
        # events above (see engine/execution_driver.py's `_site_class`
        # usages) — they never replace or gate anything already handled
        # above; they only route into their own, separately-summed
        # `*_weak_site`/`*_normal_site` counters so §Task 1-4 of the
        # Phase 3B audit can be answered from real run telemetry instead
        # of a one-off log query.
        elif stage == "discovery" and event.startswith("site_class_queued:"):
            profiler.incr(f"early_new_{event.rsplit(':', 1)[1]}_site")
        elif stage == "website" and event.startswith("site_class_stage_completed:"):
            profiler.incr(f"website_reached_{event.rsplit(':', 1)[1]}_site")
        elif stage == "website" and event.startswith("site_class_stage_failed:"):
            profiler.incr(f"website_failed_{event.rsplit(':', 1)[1]}_site")
        elif stage == "contact" and event.startswith("site_class_stage_completed:"):
            profiler.incr(f"contact_reached_{event.rsplit(':', 1)[1]}_site")
        elif stage == "contact" and event.startswith("site_class_stage_failed:"):
            profiler.incr(f"contact_failures_{event.rsplit(':', 1)[1]}_site")
        elif stage == "qualification" and event.startswith("site_class_qualified:"):
            profiler.incr(f"qualified_{event.rsplit(':', 1)[1]}_site")

    def _on_stage_timing(outcome) -> None:
        # PHASE 2 (per-area latency profiling): route each stage's
        # `EngineRuntime.execute_stage()` timing into the profiler's
        # existing StageTimer machinery under a `<stage>_worker` name, so
        # `area_sla_line()` can read it back via `_sum("website_worker")`
        # etc. Deliberately named `<stage>_worker` rather than bare
        # `<stage>` so it can never collide with a scraper-side stage name
        # (e.g. a hypothetical future "storage" timer inside a worker
        # itself) sharing the same StageTimer dict. Never allowed to raise
        # — `build_seven_stage_pipeline()` already wraps this call in its
        # own try/except, but a defensive check here costs nothing.
        try:
            profiler.record_stage_duration(f"{outcome.stage_name}_worker", outcome.duration_ms)
        except Exception:
            pass

    # LIFECYCLE FIX (target reached / graceful shutdown): a single
    # cooperative check, shared by both branches below, threaded into
    # GoogleMapsDiscoveryRequest.should_stop (see providers/
    # google_maps_provider.py) so discovery stops asking Maps for more raw
    # candidates the moment either condition is true, instead of always
    # running to `max_results`/raw_supply_cap. Reads `gate` and
    # `shutdown_event` from this closure's enclosing scope live, at call
    # time — ordinary Python closure semantics, not a snapshot — so it
    # always reflects the current state even though it's constructed once,
    # here, before `gate` has accepted any leads yet.
    def _should_stop_discovery() -> bool:
        return gate.target_reached or (
            shutdown_event is not None and shutdown_event.is_set()
        )

    # PHASE 37: max_results passed from caller represents the bounded scan budget.
    # Do not inflate max_results with an artificial 20x multiplier, ensuring discovery
    # budget matches actual Maps results and candidate telemetry.
    raw_supply_cap = max_results

    # DETAIL-PANEL WEBSITE FAST-ABORT:
    # If required_channels contains 'website' or 'email', enable MapsScraper detail website probe
    require_website = bool(required_channels and any(ch in required_channels for ch in ("website", "email")))

    session_id: Optional[str] = None
    driver: Optional[ExecutionDriver] = None
    _stopped_by_shutdown: bool = False

    # Phase 2 Watchdog Architecture:
    # Common periodic heartbeat ticker runs for BOTH discovery_only=True and
    # enrichment (discovery_only=False). Emits initial service_ready event
    # immediately so Node transitions from startup grace to liveness monitoring,
    # then ticks every 15s with monotonic seq and timestamp.
    hb_stop = asyncio.Event()
    hb_seq = 0

    _on_progress("engine", "service_ready", None, seq=0, critical=True)

    async def _hb_ticker() -> None:
        nonlocal hb_seq
        while not hb_stop.is_set():
            try:
                await asyncio.sleep(15.0)
            except asyncio.CancelledError:
                break
            if hb_stop.is_set():
                break
            hb_seq += 1
            _on_progress("engine", "heartbeat", None, seq=hb_seq, critical=True)

    hb_task = asyncio.create_task(_hb_ticker())
    try:
        if discovery_only:
            # PROVIDER PARALLELISM v1: composes every relevant, configured
            # provider (see providers/discovery_composition.py) instead of
            # constructing a bare GoogleMapsProvider directly. With no
            # provider API keys configured in the environment (today's
            # actual deployment state), this resolves to exactly
            # {"google_maps"} plus, when a niche keyword matches
            # provider_request_translation.py's small OSM tag table,
            # "overpass" — i.e. behavior is unchanged from before this
            # phase for a deployment with no additional credentials set.
            # `should_stop`/`on_progress` are threaded through exactly as
            # they were passed directly to GoogleMapsDiscoveryRequest
            # before this phase — see DiscoveryQueryContext.
            composed = compose_discovery(
                session_id=str(_time.time_ns()),  # no session/pipeline is created in this mode
                query=query, city=city, country=country,
                niche=niche, region=region, area=area, max_results=raw_supply_cap,
                should_stop=_should_stop_discovery,
                # MINIMAL FIX (discovery liveness — forensic audit §9):
                # `_on_progress` already exists and already writes the
                # stdout `"type":"progress"` line pythonBridge.ts's
                # watchdog resets on — this is the discovery_only branch's
                # own equivalent of the `on_progress=_on_progress` already
                # passed to `build_seven_stage_pipeline()` in the other
                # branch below, so both code paths get the same liveness
                # heartbeat from MapsScraper.search().
                on_progress=_on_progress,
                # PHASE 2B ROOT CAUSE FIX — see the matching comment in
                # the non-discovery_only branch below for the full
                # explanation. This is very likely the exact branch the
                # Phase 2B production log evidence (discovery_worker
                # consuming 100% of Bronx/Queens/Staten Island/Manhattan
                # runtime, [area-sla] fields all reading 0) was captured
                # from: `discovery_only=True` runs no enrichment stage at
                # all, so "discovery is the dominant stage" is trivially
                # true here, not merely observed.
                google_maps_factory=_google_maps_factory,
                overpass_factory=_overpass_factory,
                profiler=profiler,
                require_website=require_website,
                known_place_ids=known_place_ids,
                street_mode=bool(street_mode or street),
            )
            provider, request = composed.provider, composed.request
            log.info(
                "[provider] discovery_only composed providers=%s",
                composed.selected_provider_ids,
            )
            result_q: "thread_queue.Queue" = thread_queue.Queue(maxsize=20)

            def _discover_worker() -> None:
                # PHASE 2B (discovery wall-clock instrumentation):
                # this thread's entire body IS discovery, start to
                # finish (this branch runs no enrichment stage at
                # all — see the composition call above) — so timing
                # its full lifetime directly is authoritative
                # discovery_total_ms, not a derived/summed value.
                profiler.mark("discovery_worker_start")
                _t0 = _time.perf_counter()
                try:
                    for candidate in provider.discover(request):
                        result_q.put(candidate)
                except BaseException as exc:  # noqa: BLE001 - forwarded below
                    result_q.put(exc)
                finally:
                    profiler.record_stage_duration(
                        "discovery_total_ms", (_time.perf_counter() - _t0) * 1000.0
                    )
                    profiler.mark("discovery_worker_end")
                    result_q.put(_SENTINEL)

            thread = threading.Thread(
                target=_discover_worker, name="mast-discovery-only", daemon=True
            )
            thread.start()
            try:
                while not gate.target_reached:
                    # LIFECYCLE FIX: checked *before* the next (blocking)
                    # queue read, not just relied upon inside the worker
                    # thread — if shutdown was requested while this
                    # coroutine was doing something else entirely (e.g.
                    # between candidates), stop draining immediately
                    # instead of waiting on one more `result_q.get()`.
                    if shutdown_event is not None and shutdown_event.is_set():
                        _stopped_by_shutdown = True
                        log.info(
                            "[run_query] discovery_only: shutdown requested — "
                            "stopping early (delivered=%d/%d so far)",
                            gate.accepted, _deliver_target,
                        )
                        break
                    item = await asyncio.to_thread(result_q.get)
                    if item is _SENTINEL:
                        if shutdown_event is not None and shutdown_event.is_set():
                            _stopped_by_shutdown = True
                            log.info("[run_query] discovery_only: stopped by shutdown before provider exhaustion")
                        else:
                            log.info("[run_query] discovery_only: provider exhausted")
                        break
                    if isinstance(item, BaseException):
                        if shutdown_event is not None and shutdown_event.is_set():
                            _stopped_by_shutdown = True
                            log.info("[run_query] discovery_only: stopped by shutdown (suppressed %s: %s)", type(item).__name__, item)
                            break
                        raise item
                    candidate = item
                    pid = tracer.discover(candidate.name or "<unnamed>")
                    raw_dict = _candidate_dict(candidate)
                    if is_chain(candidate.name) or is_cannabis(raw_dict):
                        tracer.reject(pid, "chain_or_cannabis")
                        continue
                    # Early channel prune. MUST run before try_accept_lead():
                    # the website fast-abort yields a minimal stub, and a
                    # stub must never be accepted/delivered or counted toward
                    # the target. Rejected here => never yielded to Node, so
                    # Node cannot upsert/enqueue/charge it or count it again.
                    _unsat = _first_unsatisfiable_channel(candidate, required_channels)
                    if _unsat is not None:
                        tracer.reject(pid, f"early_channel_pruned:{_unsat}")
                        continue
                    raw_dict["fingerprints"] = sorted(fingerprints_for(raw_dict))
                    raw_dict["is_disqualified"] = False
                    raw_dict["_pipeline_id"] = pid
                    # Phase 1A: the authoritative accept/reject decision.
                    # Under the current single-consumer architecture this
                    # can only fail if the target was already reached on a
                    # prior iteration (the `while not gate.target_reached`
                    # guard above already covers that) — checked explicitly
                    # anyway so this remains correct if a second concurrent
                    # producer is ever added without this loop changing.
                    if not gate.try_accept_lead():
                        tracer.reject(pid, "target_already_reached")
                        break
                    tracer.transition(pid, "YIELDED_TO_NODE")
                    tracer.deliver(pid)
                    yield raw_dict
            finally:
                # Best-effort: nothing to cancel (provider.discover() runs on
                # a daemon thread with its own private event loop — see
                # GoogleMapsProvider's own docstring, Ambiguity 4), but drain
                # the sentinel so the thread is never left blocked on a full
                # queue if we broke out early.
                try:
                    while thread.is_alive():
                        try:
                            result_q.get_nowait()
                        except thread_queue.Empty:
                            break
                except Exception:
                    pass
                tracer.sweep_incomplete("run_ended_before_business_finished (discovery_only)")
            if _stopped_by_shutdown and not gate.target_reached:
                effective_reason = shutdown_reason or _get_shutdown_reason()
                if _is_non_failure_shutdown(effective_reason):
                    log.info(
                        "[run_query] discovery_only: cooperative shutdown stopped this run due to "
                        "%s — completing as successful early stop (delivered=%d/%d)",
                        effective_reason, gate.accepted, _deliver_target,
                    )
                elif effective_reason in ("USER_CANCELLED", "WATCHDOG_TIMEOUT", "PROCESS_UNRESPONSIVE", "DISCOVERY_PROGRESS_TIMEOUT"):
                    log.warning(
                        "[run_query] discovery_only: cooperative shutdown stopped this run due to "
                        "%s — raising typed DiscoveryFailure (delivered=%d/%d)",
                        effective_reason, gate.accepted, _deliver_target,
                    )
                    raise DiscoveryFailure(
                        effective_reason,
                        f"cooperative shutdown stopped this run due to {effective_reason}",
                    )
                else:
                    log.warning(
                        "[run_query] discovery_only: cooperative shutdown stopped this run "
                        "before target_reached or genuine exhaustion — "
                        "raising DiscoveryFailure(CANCELLED) so __done__ "
                        "reports this accurately instead of as an ordinary "
                        "success=True completion (delivered=%d/%d)",
                        gate.accepted, _deliver_target,
                    )
                    raise DiscoveryFailure(
                        DiscoveryFailureReason.CANCELLED,
                        "cooperative shutdown (watchdog inactivity/ceiling, caller "
                        "abort, or process shutdown) stopped this run before it "
                        "reached its target or genuinely exhausted its search space",
                    )
            elif not gate.target_reached:
                prov_errors = composed.provider_errors
                if not prov_errors and hasattr(composed.provider, "provider_errors"):
                    prov_errors = composed.provider.provider_errors
                if prov_errors:
                    primary_err = prov_errors.get("google_maps") or next(iter(prov_errors.values()))
                    log.warning(
                        "[run_query] discovery_only ended with provider error(s): %s; raising primary failure",
                        {pid: f"{type(err).__name__}: {err}" for pid, err in prov_errors.items()},
                    )
                    raise primary_err
        else:
            # NOTE (Phase 1A scope): this session-identity `user_id` is a
            # separate, pre-existing placeholder unrelated to early-dedup
            # ownership — DiscoverySession bookkeeping, not read by
            # `is_duplicate()` anywhere. Phase 1A's target flow threads the
            # real user id straight from `run_query(user_id=...)` to
            # `build_seven_stage_pipeline(requesting_user_id=...)` below,
            # bypassing this call entirely (see TARGET FLOW). Left
            # unchanged here deliberately, to keep this fix scoped to
            # early-dedup ownership only.
            ctx = engine_coordinator.create_session(
                user_id="service.run_query",
                provider="google_maps",
                niche=niche or None,
                country=country or None,
                city=city or None,
                requested_count=_deliver_target,
            )
            session_id = ctx.session.id
            engine_coordinator.start_session(session_id)

            # PROVIDER PARALLELISM v1: composes every relevant, configured
            # provider (see providers/discovery_composition.py) instead of
            # constructing a bare GoogleMapsProvider directly — see the
            # matching comment in the discovery_only branch above for what
            # this resolves to with today's actual (no extra API keys)
            # deployment state.
            composed = compose_discovery(
                session_id=session_id, query=query, city=city, country=country,
                niche=niche, region=region, area=area, max_results=raw_supply_cap,
                should_stop=_should_stop_discovery,
                # MINIMAL FIX (discovery liveness — forensic audit §9):
                # `on_progress=_on_progress` below (passed to
                # `build_seven_stage_pipeline()`) only reaches
                # execution_driver.py's own `_emit()` closure, which is
                # invoked from `_on_candidate()`/`_emit_stage_outcome()` —
                # i.e. still only AFTER a candidate exists, exactly the
                # blind spot this fix closes. Threading the same
                # `_on_progress` straight onto the request itself is what
                # lets MapsScraper.search()'s new panel_resolved/
                # round_scanned/crash_detected/crash_recovered heartbeats
                # (see scraper/maps_scraper.py) reach stdout at all in this
                # (non-discovery_only) branch.
                on_progress=_on_progress,
                # PHASE 2B ROOT CAUSE FIX: thread this run's real
                # `profiler` (constructed above, near the top of
                # run_query()) into the GoogleMapsProvider/OverpassProvider
                # instances compose_discovery() actually builds, instead
                # of the bare `GoogleMapsProvider`/`OverpassProvider`
                # classes (zero-arg factories that always left
                # MapsScraper defaulting to a NullProfiler — see
                # GoogleMapsProvider's own docstring for the full
                # explanation). `_google_maps_factory`/`_overpass_factory`
                # (defined near the top of run_query(), just after
                # `profiler` itself) preserve the exact pre-existing
                # `Callable[[], DiscoveryProviderInterface]` test seam —
                # monkeypatching `service.GoogleMapsProvider` with a
                # zero-arg fake still works via their `try/except
                # TypeError` fallback (see their own docstrings).
                google_maps_factory=_google_maps_factory,
                overpass_factory=_overpass_factory,
                profiler=profiler,
                require_website=require_website,
                known_place_ids=known_place_ids,
                street_mode=bool(street_mode or street),
            )
            discovery_provider = composed.provider
            discovery_request = composed.request
            log.info(
                "[provider] session=%s composed providers=%s",
                session_id, composed.selected_provider_ids,
            )

            result_q: "thread_queue.Queue" = thread_queue.Queue()

            def _on_persisted(opportunity: QualifiedOpportunity, stored: StoredOpportunity) -> None:
                result_q.put((opportunity, stored))

            streaming_backend = _StreamingStorageBackend(_build_storage_backend(), _on_persisted)

            instance_counts = {
                "website": 8,
                "instagram": 4,
                "contact": 8,
                "merge": 4,
                "qualification": 4,
                "storage": 2,
            }
            stages, queue_ids, fan_in, cleanup_cb = build_seven_stage_pipeline(
                engine_coordinator, session_id,
                discovery_provider=discovery_provider,
                discovery_request=discovery_request,
                storage_backend=streaming_backend,
                niche=niche or None,
                on_progress=_on_progress,
                on_stage_timing=_on_stage_timing,
                early_dedup_checker=_build_early_dedup_checker(),
                required_channels=tuple(required_channels or ()),
                instance_counts=instance_counts,
                # Phase 1A — thread the real requesting user_id through so
                # the early dedup decision is user-scoped ownership, not
                # global existence. None (the default, e.g. pool-building
                # callers that never pass user_id to run_query()) preserves
                # the exact prior global-only behavior.
                requesting_user_id=user_id,
            )
            engine_coordinator.mark_running(session_id)
            engine_runtime = engine_coordinator.get_engine_runtime(session_id)

            def _on_discovery_wallclock(stage_name: str, elapsed_ms: float) -> None:
                # PHASE 2B (discovery wall-clock instrumentation): the
                # `discovery` stage's single `execute_stage()` call
                # already blocks until `discovery_provider` is fully
                # exhausted (see ExecutionDriver's own "PHASE 2B FIX
                # (continuous pipeline flow)" docstring note) — so this
                # one measurement IS discovery_total_ms, not a sum of
                # anything. Also fixes the pre-existing
                # "discovery_worker_end" gap: that mark was set nowhere
                # in this codebase before this fix, silently degrading
                # `_discovery_span_ms()`/`_browser_utilization_pct()`/
                # `_discovery_worker_utilization_pct()` in print_report()
                # to a whole-run-span fallback.
                if stage_name == "discovery":
                    profiler.record_stage_duration("discovery_total_ms", elapsed_ms)
                    profiler.mark("discovery_worker_end")

            driver = ExecutionDriver(
                engine_runtime, stages, on_stage_outcome=cleanup_cb,
                on_stage_wallclock=_on_discovery_wallclock, run_producers_once=True,
                # PHASE 5C: restore downstream throughput by letting the
                # Website stage actually use more than one of its already-
                # configured 8 idle instances (`instance_counts["website"]`
                # above) at once. Conservative default (2) -- see
                # engine/execution_driver.py's own
                # DEFAULT_STAGE_CONCURRENCY docstring for why this
                # is not instance_counts["website"] itself.
                # PHASE 5E: same treatment for Contact (also 2, also not
                # instance_counts["contact"]'s 8) -- see
                # DEFAULT_STAGE_CONCURRENCY and execution_driver.py's
                # "Phase 5E" module docstring section. Instagram, Merge,
                # Qualification, and Storage remain untouched (implicit
                # concurrency 1).
                stage_concurrency={
                    "website": int(os.environ.get("MAST_STAGE_CONCURRENCY_WEBSITE", "4")),
                    "contact": int(os.environ.get("MAST_STAGE_CONCURRENCY_CONTACT", "4")),
                },
                # STOP-PROPAGATION FIX: give the driver a read-only view
                # of this call's own `shutdown_event` (set from the
                # SIGTERM handler -- see _on_sigterm / the module-level
                # _shutdown_event docstring) so a shutdown requested
                # while a `driver.run_once()` pass is already in
                # progress (mid multi-stage loop, on the asyncio.to_thread
                # worker thread, not yet returned to this coroutine) can
                # stop that pass from starting its next stage -- instead
                # of only taking effect on the *next* run_once() call,
                # which is all the `if shutdown_event is not None and
                # shutdown_event.is_set(): break` checkpoint below (and
                # the identical one above) could ever guarantee on their
                # own. Reuses the existing shutdown_event/_stop_event
                # mechanism unchanged; does not add any new cancellation
                # framework or alter what shutdown_event itself means.
                external_stop_event=shutdown_event,
            )

            all_input_queue_ids = [
                queue_ids.website_in, queue_ids.instagram_in, queue_ids.contact_in,
                queue_ids.merge_in, queue_ids.qualification_in, queue_ids.storage_in,
            ]
            queue_manager = ctx.runtime.queue_manager

            def _fully_drained() -> bool:
                # PART B/D (Phase 2B): with Discovery now running on its
                # own dedicated thread (engine/execution_driver.py's
                # producer-thread decoupling), "every input queue is
                # currently empty" is no longer sufficient evidence of
                # genuine exhaustion — discovery may simply be between
                # candidates. `driver.producers_finished()` is checked
                # first so this can never declare exhaustion while
                # discovery is still actively running.
                if driver is not None and not driver.producers_finished():
                    return False
                if driver is not None:
                    with getattr(driver, "_telemetry_lock", threading.Lock()):
                        if any(getattr(driver, "_stage_active", {}).values()):
                            return False
                if fan_in.pending_count() != 0:
                    return False
                return all(queue_manager.get_queue(qid).is_empty() for qid in all_input_queue_ids)

            profiler.mark("discovery_worker_start")

            # PART D (Phase 2B — watchdog shutdown semantics): set when
            # the loop below breaks specifically because
            # `shutdown_event` was seen set, as opposed to breaking
            # because `gate.target_reached` or genuine `_fully_drained()`
            # exhaustion. Consulted right after the loop (still inside
            # this `try`, before the shared cleanup `finally`) to decide
            # whether to raise `DiscoveryFailure(CANCELLED)` — see there
            # for why a cooperative-shutdown break must never be allowed
            # to fall through and be reported as an ordinary
            # `success=True` completion.
            _stopped_by_shutdown = False
            try:
                idle_passes = 0
                quiescent_passes = 0
                while not gate.target_reached:
                    # LIFECYCLE FIX (graceful shutdown ordering): checked
                    # *before* starting another driver.run_once() pass, not
                    # after — this is the safe checkpoint. Whatever pass is
                    # already in flight when a shutdown is requested is
                    # never interrupted (see the module-level
                    # `_shutdown_event` docstring for why forcing that would
                    # orphan the thread mid-Playwright-use); it's simply the
                    # LAST pass. Combined with GoogleMapsDiscoveryRequest.
                    # should_stop (checked once per candidate, inside that
                    # in-flight pass, whenever Discovery happens to be the
                    # stage still running), a pass that's mid-discovery when
                    # shutdown is requested still winds down promptly rather
                    # than continuing toward raw_supply_cap.
                    if shutdown_event is not None and shutdown_event.is_set():
                        log.info(
                            "[run_query] shutdown requested — not starting "
                            "another execution pass (delivered=%d/%d so far)",
                            gate.accepted, _deliver_target,
                        )
                        _stopped_by_shutdown = True
                        break

                    outcomes = await asyncio.to_thread(driver.run_once)
                    await asyncio.sleep(0)
                    if driver.last_error is not None:
                        raise driver.last_error
                    any_ran = any(o.ran for o in outcomes)

                    drained_any = False
                    while True:
                        try:
                            opportunity, stored = result_q.get_nowait()
                        except thread_queue.Empty:
                            break
                        drained_any = True
                        engine_pid = opportunity.pipeline_id

                        lead_dict = _opportunity_to_lead_dict(opportunity, stored)
                        lead_dict["fingerprints"] = sorted(fingerprints_for(lead_dict))
                        lead_dict["is_disqualified"] = (
                            bool(is_chain(lead_dict.get("name")))
                            or bool(is_cannabis(lead_dict))
                        )
                        lead_dict["_pipeline_id"] = engine_pid

                        # PipelineTracer mints its own id via discover() — it
                        # does not accept a caller-supplied one (see
                        # utils/pipeline_trace.py). Under Engine 2.0,
                        # discovery/enrichment/qualification all happen
                        # inside the pipeline before service.py ever sees a
                        # business, so this is the first point in this
                        # branch a pipeline_id becomes observable here;
                        # tracer.discover() is called right here rather than
                        # at actual discovery time. Businesses Qualification
                        # rejects are therefore not tracked by this tracer at
                        # all (they never reach result_q) — that rejection
                        # is still fully visible in the engine's own
                        # mast.engine.execution_driver log line, just not in
                        # this report.
                        pid = tracer.discover(lead_dict.get("name") or "<unnamed>")
                        tracer.transition(pid, "RESULTS_QUEUE")

                        if required_channels and "email" in required_channels and not is_valid_email(lead_dict.get("email")):
                            stats.skip("invalid_or_placeholder_email")
                            tracer.reject(pid, "invalid_or_placeholder_email")
                            continue

                        score_value = lead_dict.get("score") or 0
                        if score_value < min_score:
                            stats.skip(f"score_<_{min_score}")
                            profiler.record_rejection(
                                reason=f"score_<_{min_score}",
                                elapsed_ms=profiler.elapsed_since_business_start_ms(),
                            )
                            tracer.reject(pid, f"score_<_{min_score}")
                            continue

                        _now = time.perf_counter()
                        if _last_lead_time is not None:
                            profiler._stages["inter_lead_gap"].record(
                                (_now - _last_lead_time) * 1000.0
                            )
                        _last_lead_time = _now
                        profiler.mark_first_opportunity()
                        _mark("first_lead_delivered")

                        # Phase 1A: the authoritative accept/reject
                        # decision — see LeadAcceptanceGate.try_accept_lead
                        # docstring. Rejection here (target already reached
                        # by a lead drained earlier in this same inner
                        # while-loop) means this opportunity is dropped
                        # without being yielded, exactly like the old
                        # `delivered >= _deliver_target` post-yield break
                        # below used to prevent going one over — the check
                        # is just moved before the yield instead of after.
                        if not gate.try_accept_lead():
                            tracer.reject(pid, "target_already_reached")
                            break
                        tracer.transition(pid, "YIELDED_TO_NODE")
                        tracer.deliver(pid)
                        profiler.incr("delivered")
                        # Phase 3B-VALIDATION (observability only): label
                        # this delivered lead weak vs normal site, read
                        # straight off the already-in-hand `opportunity`
                        # (EnrichedBusiness.business is the original
                        # BusinessCandidate — no new lookup, no new state).
                        _delivered_business = (
                            opportunity.business.business if opportunity.business else None
                        )
                        if _delivered_business is not None:
                            _delivered_cls = "weak" if is_weak_site(_delivered_business.website) else "normal"
                            profiler.incr(f"delivered_{_delivered_cls}_site")
                        yield lead_dict
                        if gate.target_reached:
                            break

                    if gate.target_reached:
                        log.info(
                            "[run_query] requested quantity reached — delivered=%d deliver_target=%d",
                            gate.accepted, _deliver_target,
                        )
                        # CRITMODE PART 2 -- POST-USEFUL-WORK
                        # instrumentation: reuses the SAME _on_progress
                        # protocol as discovery's stage="discovery"
                        # events, just stage="engine" -- carries the
                        # current pending (non-terminal) pipeline record
                        # count as item_id so Node can see how much work
                        # was still in flight the instant target was hit.
                        _on_progress("engine", "target_reached", str(tracer.pending_count()))
                        if driver is not None:
                            driver.stop(on_phase=lambda phase: _on_progress("engine", phase, str(tracer.pending_count())))
                        break

                    if not any_ran and not drained_any:
                        idle_passes += 1
                        if _fully_drained():
                            quiescent_passes += 1
                            if quiescent_passes >= 3:
                                if driver is not None and driver.last_error is not None:
                                    raise driver.last_error
                                if shutdown_event is not None and shutdown_event.is_set():
                                    _stopped_by_shutdown = True
                                    break
                                log.info(
                                    "[run_query] pipeline fully drained — exhausted before "
                                    "reaching deliver_target (delivered=%d/%d)",
                                    gate.accepted, _deliver_target,
                                )
                                break
                        else:
                            quiescent_passes = 0
                        # Paced idle backoff: avoid CPU spin during async I/O or worker wait
                        backoff = min(0.01 * (1.5 ** min(idle_passes, 6)), 0.10)
                        await asyncio.sleep(backoff)
                    else:
                        idle_passes = 0
                        quiescent_passes = 0

                # PART D (Phase 2B — watchdog shutdown semantics): a
                # cooperative-shutdown break (watchdog inactivity/ceiling,
                # caller abort, or process shutdown — service.py cannot
                # tell which; only the Node bridge's own local timedOut
                # state can, and does, see EngineDoneInfo.terminationReason
                # in pythonBridge.ts) must NEVER be allowed to reach
                # `_main_cli` as an ordinary loop-exhaustion, which would
                # be reported as `success=True` — see this file's
                # `_main_cli` and `exceptions.DiscoveryFailureReason.
                # CANCELLED` for the existing, established mechanism this
                # reuses rather than inventing a second status system.
                # Guarded by `not gate.target_reached` so "target reached
                # AND shutdown also happened to be requested moments
                # later" still correctly reports as a target-reached
                # success (PART F: "Target completion still wins") — that
                # case already `break`s via the `gate.target_reached`
                # check above, earlier in the same pass, before this line
                # is ever reached.
                if _stopped_by_shutdown and not gate.target_reached:
                    effective_reason = shutdown_reason or _get_shutdown_reason()
                    if _is_non_failure_shutdown(effective_reason):
                        log.info(
                            "[run_query] cooperative shutdown stopped this run due to "
                            "%s — completing as successful early stop (delivered=%d/%d)",
                            effective_reason, gate.accepted, _deliver_target,
                        )
                    elif effective_reason in ("USER_CANCELLED", "WATCHDOG_TIMEOUT", "PROCESS_UNRESPONSIVE", "DISCOVERY_PROGRESS_TIMEOUT"):
                        log.warning(
                            "[run_query] cooperative shutdown stopped this run due to "
                            "%s — raising typed DiscoveryFailure (delivered=%d/%d)",
                            effective_reason, gate.accepted, _deliver_target,
                        )
                        raise DiscoveryFailure(
                            effective_reason,
                            f"cooperative shutdown stopped this run due to {effective_reason}",
                        )
                    else:
                        log.warning(
                            "[run_query] cooperative shutdown stopped this run "
                            "before target_reached or genuine exhaustion — "
                            "raising DiscoveryFailure(CANCELLED) so __done__ "
                            "reports this accurately instead of as an ordinary "
                            "success=True completion (delivered=%d/%d)",
                            gate.accepted, _deliver_target,
                        )
                        raise DiscoveryFailure(
                            DiscoveryFailureReason.CANCELLED,
                            "cooperative shutdown (watchdog inactivity/ceiling, caller "
                            "abort, or process shutdown) stopped this run before it "
                            "reached its target or genuinely exhausted its search space",
                        )
                elif not gate.target_reached:
                    prov_errors = composed.provider_errors
                    if not prov_errors and hasattr(composed.provider, "provider_errors"):
                        prov_errors = composed.provider.provider_errors
                    if prov_errors:
                        primary_err = prov_errors.get("google_maps") or next(iter(prov_errors.values()))
                        log.warning(
                            "[run_query] pipeline ended with provider error(s): %s; raising primary failure",
                            {pid: f"{type(err).__name__}: {err}" for pid, err in prov_errors.items()},
                        )
                        raise primary_err
            finally:
                if driver is not None:
                    # CRITMODE PART 2 -- POST-USEFUL-WORK instrumentation:
                    # same on_phase wiring as the target-reached path above,
                    # for the other exit paths (watchdog/cancel/exhaustion)
                    # that reach this cleanup finally instead. Safe even if
                    # driver.stop() already ran once above -- stop() is
                    # documented as safe to call more than once, and Node's
                    # progressMarks are first-occurrence-only so a second
                    # emit here is a harmless no-op if it already fired.
                    await asyncio.to_thread(
                        driver.stop,
                        on_phase=lambda phase: _on_progress("engine", phase, str(tracer.pending_count())),
                    )
                tracer.sweep_incomplete("run_ended_before_business_finished (cancelled/aborted)")
    finally:
        log.info("[run_query] entering outer cleanup (store close, profiler report)")
        # Phase 2 Watchdog Architecture:
        # Stop and drain the periodic heartbeat ticker before writer shutdown.
        hb_stop.set()
        if hb_task is not None:
            hb_task.cancel()
            try:
                await hb_task
            except (asyncio.CancelledError, Exception):
                pass
        # P1-A FIX: flush/stop the dedicated progress-event writer before
        # anything else in this cleanup block. By this point `driver.stop()`
        # (nested finally above, production path) and `hb_task.cancel()`
        # have already run, so no further `_on_progress()` calls are
        # expected -- `stop()` drains whatever is still queued (FIFO, so
        # nothing enqueued before it is skipped) and joins the drainer
        # thread with a bounded timeout, never hanging this cleanup.
        _progress_writer.stop()
        store.close()
        if session_id is not None:
            try:
                if gate.target_reached:
                    engine_coordinator.finish_session(session_id)
                else:
                    engine_coordinator.cancel_session(session_id)
                # Part 3 (batch intelligence chain): Ranking is
                # session-scoped and must wait until the discovery
                # session completes (locked architecture) -- finish_session
                # / cancel_session above IS that completion signal, the
                # same existing lifecycle hook the rest of this cleanup
                # block already reuses. A batch-intelligence failure must
                # never mask that the session itself already reached a
                # terminal state, so it is logged, not re-raised.
                try:
                    batch_result = run_batch_intelligence(engine_coordinator, session_id)
                    log.info(
                        "[run_query] batch intelligence chain: session=%s "
                        "ranked=%d missions=%d workflow_states=%d",
                        session_id,
                        len(batch_result["ranked_opportunities"]),
                        len(batch_result["missions"]),
                        len(batch_result["workflow_states"]),
                    )
                    # Persistence Integration milestone, Part 4: persist
                    # the batch result ONLY after run_batch_intelligence()
                    # above has already returned successfully -- this line
                    # is unreachable if that call raised, so a partially-
                    # computed intelligence chain is never persisted. A
                    # persistence failure itself must not mask that the
                    # session and its (in-memory) batch result already
                    # completed, so it is logged, not re-raised -- the
                    # same posture the batch-intelligence try/except above
                    # already takes toward run_batch_intelligence() itself.
                    try:
                        batch_backend = _build_batch_intelligence_backend()
                        batch_backend.persist_batch_result(
                            session_id,
                            priorities=batch_result["priorities"],
                            ranked_opportunities=batch_result["ranked_opportunities"],
                            missions=batch_result["missions"],
                            workflow_states=batch_result["workflow_states"],
                        )
                        log.info(
                            "[run_query] batch intelligence persisted: session=%s "
                            "priorities=%d ranked=%d missions=%d workflow_states=%d",
                            session_id,
                            len(batch_result["priorities"]),
                            len(batch_result["ranked_opportunities"]),
                            len(batch_result["missions"]),
                            len(batch_result["workflow_states"]),
                        )
                    except Exception:
                        log.warning(
                            "[run_query] batch intelligence persistence failed "
                            "for session=%s (in-memory batch result is still "
                            "available via engine_coordinator.get_batch_result)",
                            session_id, exc_info=True,
                        )
                except Exception:
                    log.warning(
                        "[run_query] batch intelligence chain failed for session=%s",
                        session_id, exc_info=True,
                    )
            except Exception:
                log.debug("[run_query] session %s already terminal", session_id, exc_info=True)
        log_milestone("After run_query cleanup")
        # Phase 1A: `gate.accepted` is the authoritative count — reading it
        # here (rather than a separately-tracked local) is what guarantees
        # this closing log line can never drift from what the gate itself
        # decided was accepted.
        log.info(f"[service] done — delivered={gate.accepted} {stats.summary()}")
        log.info(
            "[service] rejection summary:\n" + stats.rejection_summary()
        )
        # Phase S1: any business not already swept above is closed out here
        # too, then the full reconciliation — counts plus any invariant
        # violation — is logged as the last thing this run does.
        tracer.sweep_incomplete("run_ended_before_business_finished")
        log.info("[pipeline] reconciliation:\n" + tracer.reconcile())
        # Phase 2: stash profiler summary so _main_cli can embed it in
        # the __done__ sentinel without changing run_query's public API.
        global _last_perf_summary
        _last_perf_summary = profiler.summary()
        # PART E (Phase 2B — truthful first-lead latency): additive
        # sub-report alongside the existing profiler summary (nothing
        # existing removed/renamed). Values are seconds since this
        # run_query() call started (`_request_started_ts`), each recorded
        # once, the first time it happened — see `_mark()`'s own comment
        # above. A key's absence means that milestone never happened this
        # run (e.g. no candidates ever discovered), not that it was zero.
        _last_perf_summary["latency"] = {
            "time_to_first_candidate_s": _latency_marks.get("first_candidate_discovered"),
            "time_to_first_accepted_s": _latency_marks.get("first_candidate_accepted"),
            "time_to_first_enrichment_s": _latency_marks.get("first_enrichment_completed"),
            "time_to_first_lead_s": _latency_marks.get("first_lead_delivered"),
        }
        # Phase 2A: attach the module-level import timing captured once at
        # process start. Not per-run (imports only happen once per Python
        # process, not once per run_query() call), but embedding it here
        # means every run's __perf__ output carries it for visibility.
        _last_perf_summary["python_imports_ms"] = round(_IMPORTS_ELAPSED_MS, 1)
        profiler.print_report(
            query=query,
            city=city,
            delivered=gate.accepted,
            requested=_deliver_target,  # report the user-facing target, not the scan budget
        )
        # Phase 2 (per-area latency profiling, Step 2): the ONE
        # authoritative per-area summary this phase adds. `city` is the
        # per-child area name (Bronx, Queens, ... — see pythonBridge.ts,
        # which spawns one `run_query()` per area with `city=<area>`).
        # Uses `_request_started_ts` as its time base (same reference
        # `_latency_marks` already uses) so `runtime_ms` and the
        # `first_*_ms` fields share one clock; the stage-time and counter
        # fields come from `profiler` directly and are clock-independent.
        _area_runtime_ms = (time.perf_counter() - _request_started_ts) * 1000.0
        _area_sla_kwargs = dict(
            area=city,
            runtime_ms=_area_runtime_ms,
            first_candidate_ms=(
                _latency_marks["first_candidate_discovered"] * 1000.0
                if "first_candidate_discovered" in _latency_marks else None
            ),
            first_enrichment_ms=(
                _latency_marks["first_enrichment_completed"] * 1000.0
                if "first_enrichment_completed" in _latency_marks else None
            ),
            first_qualified_ms=(
                _latency_marks["first_candidate_qualified"] * 1000.0
                if "first_candidate_qualified" in _latency_marks else None
            ),
            first_delivered_ms=(
                _latency_marks["first_lead_delivered"] * 1000.0
                if "first_lead_delivered" in _latency_marks else None
            ),
        )
        profiler.print_area_sla(**_area_sla_kwargs)
        # Also embed the same fields, structurally, in the __done__
        # sentinel payload (`_last_perf_summary`) — the stderr block above
        # is for a human tailing logs; this is for anything that wants to
        # parse it (e.g. a future dashboard aggregating area-sla across
        # a whole production run) without scraping text.
        _last_perf_summary["area_sla"] = {
            **{k: v for k, v in _area_sla_kwargs.items()},
            "maps_ms": profiler._stages["playwright_startup"].total_ms
                + profiler._stages["browser_startup"].total_ms
                + profiler._stages["context_creation"].total_ms
                + profiler._stages["page_creation"].total_ms,
            "navigation_ms": profiler._stages["maps_initial_load"].total_ms,
            "panel_ms": profiler._stages["place_panel_wait"].total_ms
                + profiler._stages["place_settle"].total_ms,
            "scroll_ms": profiler._stages["scroll_movement"].total_ms
                + profiler._stages["scroll_wait"].total_ms,
            "place_click_ms": profiler._stages["place_click"].total_ms,
            "rate_limit_ms": profiler._stages["rate_limit_wait_search"].total_ms
                + profiler._stages["rate_limit_wait_place"].total_ms,
            "extraction_ms": profiler._stages["maps_place_extraction"].total_ms,
            # PHASE 2B (discovery wall-clock instrumentation) — kept in
            # sync with the new fields `RunProfiler.area_sla_line()`
            # itself now reports; see that method's own docstring for
            # why these are direct measurements, not sums, for the
            # three *_total_ms fields.
            "discovery_total_ms": profiler._stages["discovery_total_ms"].total_ms,
            "google_maps_total_ms": profiler._stages["google_maps_provider_total"].total_ms,
            "overpass_total_ms": profiler._stages["overpass_provider_total"].total_ms,
            "maps_navigation_ms": profiler._stages["maps_initial_load"].total_ms,
            "panel_resolution_ms": profiler._stages["place_panel_wait"].total_ms
                + profiler._stages["place_settle"].total_ms,
            "place_detail_ms": profiler._stages["place_click"].total_ms,
            "candidate_extraction_ms": profiler._stages["maps_place_extraction"].total_ms,
            "retry_wait_ms": profiler._stages["retry_wait"].total_ms,
            "maps_rounds": profiler.counter("maps_rounds"),
            "maps_candidates_seen": profiler.counter("maps_candidates_seen"),
            "maps_candidates_yielded": profiler.counter("maps_candidates_yielded"),
            # PHASE 12A (zero-risk Maps click reduction) — kept in sync
            # with the same two new fields RunProfiler.area_sla_line()
            # now reports; see that method's docstring.
            "maps_candidates_clicked": profiler.counter("maps_candidates_clicked"),
            "maps_candidates_card_closed_skipped": profiler.counter("maps_candidates_card_closed_skipped"),
            # PHASE 33A (place panel wait telemetry)
            "place_panel_wait_count": profiler.place_panel_wait_summary()["place_panel_wait_count"],
            "place_panel_wait_total_ms": profiler.place_panel_wait_summary()["place_panel_wait_total_ms"],
            "place_panel_wait_avg_ms": profiler.place_panel_wait_summary()["place_panel_wait_avg_ms"],
            "place_panel_wait_p50_ms": profiler.place_panel_wait_summary()["place_panel_wait_p50_ms"],
            "place_panel_wait_p90_ms": profiler.place_panel_wait_summary()["place_panel_wait_p90_ms"],
            "place_panel_wait_p99_ms": profiler.place_panel_wait_summary()["place_panel_wait_p99_ms"],
            "place_panel_wait_max_ms": profiler.place_panel_wait_summary()["place_panel_wait_max_ms"],
            "place_panel_wait_timeout_count": profiler.place_panel_wait_summary()["place_panel_wait_timeout_count"],
            "overpass_requests": profiler.counter("overpass_requests"),
            "overpass_retries": profiler.counter("overpass_retries"),
            # DETAIL-PANEL WEBSITE FAST-ABORT TELEMETRY
            "detail_website_probe_ms": profiler._stages["detail_website_probe"].total_ms,
            "detail_fast_abort_saved_ms": profiler._stages["detail_fast_abort_saved"].total_ms,
            "maps_detail_website_probe_attempts": profiler.counter("maps_detail_website_probe_attempts"),
            "maps_detail_website_probe_has_site": profiler.counter("maps_detail_website_probe_has_site"),
            "maps_detail_website_probe_no_site": profiler.counter("maps_detail_website_probe_no_site"),
            "maps_detail_fast_abort_no_website": profiler.counter("maps_detail_fast_abort_no_website"),
            "website_ms": profiler._stages["website_worker"].total_ms,
            "instagram_ms": profiler._stages["instagram_worker"].total_ms,
            "contact_ms": profiler._stages["contact_worker"].total_ms,
            "merge_ms": profiler._stages["merge_worker"].total_ms,
            "qualification_ms": profiler._stages["qualification_worker"].total_ms,
            "storage_ms": profiler._stages["storage_worker"].total_ms,
            "raw_candidates": profiler.counter("raw_candidates"),
            "early_new": profiler.counter("early_new"),
            "early_duplicates": profiler.counter("early_duplicates"),
            "early_pruned": profiler.counter("early_pruned"),
            "contact_failures": profiler.counter("contact_failures"),
            # Phase 14.2 (Instagram acquisition telemetry) — additive,
            # observational only; see engine/execution_driver.py's
            # `_instagram_downstream`/`_contact_downstream` and
            # service.py's `_on_progress` above for what each counts.
            "instagram_attempted": profiler.counter("instagram_attempted"),
            "instagram_url_input_present": profiler.counter("instagram_url_input_present"),
            "instagram_profile_reachable": profiler.counter("instagram_profile_reachable"),
            "instagram_short_circuited": profiler.counter("instagram_short_circuited"),
            "instagram_discovery_found": profiler.counter("instagram_discovery_found"),
            "instagram_discovery_missing": profiler.counter("instagram_discovery_missing"),
            "instagram_discovery_invalid": profiler.counter("instagram_discovery_invalid"),
            # Phase 15 (Email / Contact Acquisition telemetry)
            "email_secondary_page_fetched": profiler.counter("email_secondary_page_fetched"),
            "email_secondary_page_found": profiler.counter("email_secondary_page_found"),
            "email_acquired": profiler.counter("email_acquired"),
            "email_missing_after_scan": profiler.counter("email_missing_after_scan"),
            "phone_secondary_page_fetched": profiler.counter("phone_secondary_page_fetched"),
            "phone_acquired": profiler.counter("phone_acquired"),
            "phone_missing_after_scan": profiler.counter("phone_missing_after_scan"),
            "secondary_page_fetch_failures": profiler.counter("secondary_page_fetch_failures"),
            "secondary_fallback_attempted": profiler.counter("secondary_fallback_attempted"),
            "secondary_fallback_success": profiler.counter("secondary_fallback_success"),
            "secondary_fallback_fetch_failed": profiler.counter("secondary_fallback_fetch_failed"),
            "qualified": profiler.counter("qualified"),
            "delivered": profiler.counter("delivered"),
        }
        log.info("[run_query] outer cleanup finished")


async def _main_cli() -> None:
    _cleanup_stop_sentinel_file()
    raw_args = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    params = json.loads(raw_args)
    # deliver_target is the user-facing qualified-lead count (what the user
    # actually requested).  max_results is the raw scan budget (how many
    # Maps places may be scanned to find enough qualified leads after
    # filtering).  The __done__ sentinel reports `requested=deliver_target`
    # so the Node bridge's onDone callback sees the true count.
    requested = params.get("deliver_target") or params.get("max_results", 60)

    delivered = 0
    log.info("[main_cli] entering run_query async for loop")
    # ROOT CAUSE FIX (Part 8 — false "exhausted" results): a discovery
    # provider that fails to access/parse results (no valid results panel,
    # a consent/block/challenge interstitial, a navigation timeout, or an
    # unclassified scraper error) now raises `DiscoveryFailure` — see
    # exceptions/__init__.py and scraper/maps_scraper.py — instead of the
    # old silent `return`. That failure propagates up through
    # `run_query()`'s async generator unchanged. Catching it specifically
    # here, instead of letting it crash the subprocess with no `__done__`
    # sentinel at all, is what lets the __done__ payload carry an explicit
    # `success: False` + `failure_reason` pair — the Node bridge
    # (src/scraperBridge/pythonBridge.ts) and its callers
    # (src/jobs/discoverJob.ts's `citySearchExhausted` handling) key off
    # `success` to make sure a failure is never treated the same as a
    # query whose search space genuinely ran out. Any OTHER (unclassified)
    # exception is intentionally NOT caught here — it propagates, crashes
    # the subprocess with a non-zero exit code, and is surfaced by the
    # bridge's existing `exitCode !== 0` handling, exactly as before.
    failure: DiscoveryFailure | None = None
    try:
        async for lead_dict in run_query(**params, shutdown_event=_shutdown_event):
            delivered += 1
            try:
                sys.stdout.write(json.dumps(lead_dict, default=str) + "\n")
                sys.stdout.flush()
            except (BrokenPipeError, IOError, OSError):
                log.info("[main_cli] stdout pipe closed by consumer (early break / TARGET_REACHED)")
                break
        log.info(f"[main_cli] run_query async for loop ended normally (delivered={delivered}) — about to write __done__")
    except DiscoveryFailure as exc:
        failure = exc
        log.error(
            f"[main_cli] run_query ended with a discovery failure "
            f"(reason={exc.reason.value}, delivered={delivered} before "
            f"failure) — about to write __done__ with success=False: {exc.detail}"
        )
    except asyncio.CancelledError:
        # LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown
        # phase): this only fires if _run_with_graceful_shutdown's
        # COOPERATIVE_SHUTDOWN_GRACE_S fallback actually escalated to a
        # forced task.cancel() — i.e. run_query()'s own cooperative
        # checkpoints (should_stop / the between-pass shutdown_event check)
        # didn't finish in time. Before this fix, this exception propagated
        # straight out of `_main_cli()` uncaught, skipping the __done__
        # write entirely — that is the direct cause of the reported
        # "sawDone=false" / "Delivered: 0" outcome, even for a run whose
        # leads had already been fully qualified/stored (every already-
        # written stdout line up to this point is real and already reached
        # Node; only the sentinel was missing). Catching it here, the same
        # way DiscoveryFailure is caught above, guarantees __done__ is
        # ALWAYS written — every branch of "python yields a lead -> node
        # receives it -> ... -> completion reports it correctly" now holds
        # even on a forced shutdown, not just a clean one. Never reported
        # as `exhausted=True` — see DiscoveryFailureReason.CANCELLED's own
        # docstring for why that invariant matters here specifically.
        effective_reason = _get_shutdown_reason()
        if _is_non_failure_shutdown(effective_reason):
            log.info(
                f"[main_cli] run_query cancelled during {effective_reason} shutdown "
                f"(delivered={delivered}) — completing as successful early stop"
            )
            failure = None
        elif effective_reason in ("USER_CANCELLED", "WATCHDOG_TIMEOUT", "PROCESS_UNRESPONSIVE", "DISCOVERY_PROGRESS_TIMEOUT"):
            failure = DiscoveryFailure(
                effective_reason,
                f"graceful shutdown requested with reason={effective_reason}",
            )
            log.warning(
                f"[main_cli] run_query cancelled during {effective_reason} shutdown "
                f"(delivered={delivered} before cancellation) — writing "
                f"__done__ with success=False, failure_reason={effective_reason}"
            )
        else:
            failure = DiscoveryFailure(
                DiscoveryFailureReason.CANCELLED,
                "graceful shutdown (SIGTERM) requested before this run finished "
                "naturally, and the cooperative shutdown checkpoints did not "
                "wind down in time — escalated to a forced cancellation",
            )
            log.warning(
                f"[main_cli] run_query cancelled during shutdown "
                f"(delivered={delivered} before cancellation) — writing "
                f"__done__ with success=False, failure_reason=CANCELLED"
            )
    except Exception as exc:
        failure = DiscoveryFailure(
            DiscoveryFailureReason.SCRAPER_ERROR,
            f"Unhandled engine failure: {type(exc).__name__}: {exc}",
        )
        log.exception(
            f"[main_cli] run_query crashed with unhandled exception "
            f"(delivered={delivered} before crash) — writing __done__ with success=False"
        )

    # `exhausted=True` means this query's own search space ran out (Maps
    # end-of-results / scroll cap) before `requested` was reached — i.e.
    # this is a genuine shortfall for this query, not an artificial stop.
    # `exhausted=False` means either we stopped because we delivered
    # everything that was asked for (there may well be more out there), OR
    # the attempt failed (`success=False`) before exhaustion could even be
    # determined — `exhausted` is meaningless in that case and callers must
    # check `success` first, never infer failure from `exhausted` alone.
    #
    # LIFECYCLE FIX (TARGET_REACHED semantics): When parent target is reached,
    # child termination is a SUCCESSFUL EARLY STOP: success=True,
    # target_reached=True, termination_reason="SUCCESS_TARGET_REACHED".
    #
    # LIFECYCLE FIX (CONSUMER_STOPPED semantics — FINAL SHUTDOWN LATENCY +
    # CONSUMER_STOPPED FIX): a plain CONSUMER_STOPPED stop (area rotation /
    # the Node bridge's own consumer breaking out early) is ALSO a
    # successful early stop, but it must NOT be reported as
    # target_reached=True (the PARENT request's target was not necessarily
    # met — only this call's own batch was satisfied; see
    # pythonBridge.ts's SUCCESS_CONSUMER_STOPPED doc comment) and must NOT
    # be reported as exhausted=True either (the search space did not run
    # out — this run was asked to stop, mid-search, by its consumer).
    effective_reason = _get_shutdown_reason()
    is_target_reached_stop = failure is None and (delivered >= requested or effective_reason == "TARGET_REACHED")
    is_consumer_stopped_stop = (
        failure is None and not is_target_reached_stop and effective_reason == "CONSUMER_STOPPED"
    )
    target_reached = is_target_reached_stop
    success = failure is None
    exhausted = (
        False if (failure is not None or target_reached or is_consumer_stopped_stop)
        else delivered < requested
    )
    if effective_reason in ("USER_CANCELLED", "WATCHDOG_TIMEOUT", "PROCESS_UNRESPONSIVE", "DISCOVERY_PROGRESS_TIMEOUT"):
        termination_reason = effective_reason
    else:
        termination_reason = (
            "SUCCESS_TARGET_REACHED" if (success and target_reached)
            else "SUCCESS_CONSUMER_STOPPED" if (success and is_consumer_stopped_stop)
            else "SUCCESS_EXHAUSTED" if success
            else failure.reason.value
        )
    try:
        sys.stdout.write(json.dumps({
            "__done__": True,
            "delivered": delivered,
            "requested": requested,
            "exhausted": exhausted,
            "success": success,
            "target_reached": target_reached,
            "termination_reason": termination_reason,
            "failure_reason": failure.reason.value if failure is not None else None,
            "failure_detail": failure.detail if failure is not None else None,
            "__perf__": _last_perf_summary,
        }, default=str) + "\n")
        sys.stdout.flush()
        log.info(
            f"[main_cli] __done__ sentinel written (delivered={delivered}, "
            f"requested={requested}, target_reached={target_reached}, "
            f"success={success}, termination_reason={termination_reason}, "
            f"failure_reason={failure.reason.value if failure else None!r})"
        )
    except (BrokenPipeError, IOError, OSError):
        log.info("[main_cli] stdout pipe closed before __done__ could be flushed")
    finally:
        _cleanup_stop_sentinel_file()
        confirm_and_emit_job_terminated()


async def verify_business(*, website: str = "", instagram: str = "", headless: bool = True) -> dict:
    """
    Phase 7. Re-checks a single, already-known business's website and/or
    Instagram DIRECTLY — no Maps search, no niche/city query. Reuses
    `SiteCrawler` / `IGIntelligence` exactly as `EnrichmentPipeline` does
    internally for extraction; the only genuinely new logic is the raw
    reachability probe below (a bare `page.goto` + catch), since
    `SiteCrawler.crawl()` was built to answer "what did we extract" and
    silently returns an empty dict on both a dead site and a live-but-
    contentless one — it has no reason to distinguish those, so it can't
    tell verification whether the site is still up. Duplicating its
    extraction logic to add that distinction would violate "don't
    duplicate crawler logic"; a two-line separate probe doesn't.

    Returns:
      {
        "website_ok": bool | None,      # None = no website on file to check
        "website_data": dict,           # SiteCrawler.crawl() output, only if website_ok
        "instagram_ok": bool | None,    # None = no instagram on file to check
        "instagram_data": dict,         # IGIntelligence.fetch_profile() output, only if instagram_ok
      }
    """
    config = ScraperConfig(headless=headless)
    stats = RunStats()
    proxy_manager = ProxyManager()

    result: dict[str, Any] = {
        "website_ok": None,
        "website_data": {},
        "instagram_ok": None,
        "instagram_data": {},
    }

    async with MapsScraper(config, proxy_manager, stats) as scraper:
        browser = scraper.browser

        if website:
            page = await browser.new_page()
            try:
                await page.goto(website, wait_until="domcontentloaded", timeout=config.site_timeout_ms)
                result["website_ok"] = True
            except Exception as e:
                log.debug(f"[verify] website unreachable: {website} ({e})")
                result["website_ok"] = False
            finally:
                await page.close()

            if result["website_ok"]:
                crawler = SiteCrawler(config, browser)
                try:
                    result["website_data"] = await crawler.crawl(website)
                except Exception as e:
                    # The reachability probe above already succeeded (the
                    # page loaded), so website_ok stays True — this is an
                    # extraction failure, not a dead site. Website crawling
                    # and Instagram intelligence are independent
                    # responsibilities; a crash here must not prevent the
                    # Instagram check below from running.
                    log.debug(f"[verify] website crawl failed after reachability check succeeded: {website} ({e})")

        if instagram:
            ig = IGIntelligence(config, browser)
            profile = await ig.fetch_profile(instagram)
            # `blocked` is IG_intel's own signal for "sorry, this page isn't
            # available" — i.e. the handle no longer resolves, distinct from
            # a merely private (but still existing) account.
            result["instagram_ok"] = not profile.get("blocked", False)
            result["instagram_data"] = profile

    return result


async def _verify_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await verify_business(**params)
    sys.stdout.write(json.dumps(result, default=str))
    sys.stdout.flush()


async def enrich_business_v2(payload: dict) -> dict:
    """
    Milestone 2 entrypoint: runs Engine 2.0's WebsiteWorker /
    InstagramWorker / ContactWorker / MergeWorker for one already-known
    business (businessProcessingJob.ts's enrichBusiness()/scoreBusiness(),
    via runEngineEnrich() in pythonBridge.ts). Async only for calling-
    convention symmetry with verify_business() and run_query() — every
    Engine 2.0 worker this delegates to is itself synchronous (see
    engine_enrichment_bridge.py).
    """
    return _engine_enrich_business(payload)


async def _enrich_cli() -> None:
    from utils.egress_guard import is_local_isolation_enforced, install_python_socket_isolation_guard
    if is_local_isolation_enforced():
        install_python_socket_isolation_guard()
    # See the _REAL_STDOUT / sys.stdout swap at the top of this module for
    # why the result is written there rather than to `sys.stdout` directly
    # (sys.stdout has been redirected to stderr for this mode, so logging
    # from here on doesn't corrupt the one JSON line pythonBridge.ts's
    # runEngineEnrich() expects on real stdout).
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await enrich_business_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def _enrich_daemon_cli() -> None:
    """
    Phase 3 optimization: Persistent enrichment worker daemon.
    Processes line-delimited JSON requests from stdin without restarting the
    Python interpreter or re-importing modules. Preserves domain cache and
    single-flight coordination across requests.

    Protocol:
      Input (stdin):  {"id": "<req_id>", "params": {...}}
      Output (stdout): {"id": "<req_id>", "result": {...}}
                  or  {"id": "<req_id>", "error": "<message>"}
      Ping (stdin):   {"id": "<req_id>", "ping": true}
      Pong (stdout):  {"id": "<req_id>", "pong": true}
    """
    from utils.egress_guard import is_local_isolation_enforced, install_python_socket_isolation_guard
    if is_local_isolation_enforced():
        install_python_socket_isolation_guard()

    semaphore = asyncio.Semaphore(16)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Optional[str]] = asyncio.Queue()

    def _stdin_reader() -> None:
        try:
            for line in iter(_sys.stdin.readline, ""):
                loop.call_soon_threadsafe(queue.put_nowait, line)
        except Exception:
            pass
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    reader_thread = threading.Thread(target=_stdin_reader, name="enrich-stdin-reader", daemon=True)
    reader_thread.start()

    active_tasks: set[asyncio.Task] = set()

    async def _handle_request(req_id: str, params: dict) -> None:
        async with semaphore:
            try:
                res = await loop.run_in_executor(None, _engine_enrich_business, params)
                payload = {"id": req_id, "result": res}
            except Exception as exc:
                payload = {"id": req_id, "error": str(exc)}
            line = json.dumps(payload, default=str) + "\n"
            _REAL_STDOUT.write(line)
            _REAL_STDOUT.flush()

    while True:
        raw_line = await queue.get()
        if raw_line is None:
            break
        text = raw_line.strip()
        if not text:
            continue
        try:
            msg = json.loads(text)
            req_id = msg.get("id")
            if not req_id:
                continue
            if msg.get("ping"):
                _REAL_STDOUT.write(json.dumps({"id": req_id, "pong": True}) + "\n")
                _REAL_STDOUT.flush()
                continue
            params = msg.get("params", {})
            task = asyncio.create_task(_handle_request(req_id, params))
            active_tasks.add(task)
            task.add_done_callback(active_tasks.discard)
        except Exception as exc:
            _REAL_STDOUT.write(json.dumps({"error": f"Invalid JSON line: {exc}"}) + "\n")
            _REAL_STDOUT.flush()

    if active_tasks:
        await asyncio.gather(*active_tasks, return_exceptions=True)


async def build_street_inventory_v2(payload: dict) -> dict:
    """
    CRITMODE Phase 4 — PART A: the only Node-callable entrypoint onto the
    existing (Phase 2A) `street_inventory/build.py` pipeline. Wraps the
    already-implemented, already-tested `build_city_street_inventory()`
    (real OSM/Overpass source, idempotent upsert-on-`street_key`
    persistence — see that module and `street_inventory/repository.py`
    for the actual fetch/persist logic, both UNCHANGED by this phase).
    This function adds no new inventory logic of its own; it only gives
    poolExpandJob.ts (via runEngineStreetInventory() in pythonBridge.ts)
    a subprocess entrypoint onto it, the same way `enrich`/`verify`
    already expose other library functions as CLI modes.
    """
    from street_inventory.build import build_city_street_inventory

    return build_city_street_inventory(
        country_code=payload["country_code"],
        city=payload["city"],
        country_name=payload.get("country_name"),
        region=payload.get("region"),
        area_name=payload.get("area_name"),
        osm_relation_id=payload.get("osm_relation_id"),
    )


async def _street_inventory_cli() -> None:
    # Same _REAL_STDOUT convention as _enrich_cli() above — sys.stdout is
    # redirected to stderr for every _JSON_CLI_MODES entry (see the top of
    # this module), so this writes its one JSON result line to the real
    # stdout pythonBridge.ts's runEngineStreetInventory() reads.
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    # DEBUG (street-inventory hang investigation): this is the ONLY log
    # line that previously existed between the Node-side "starting build"
    # log and the (possibly much later) result line — there was no
    # confirmation the CLI had even parsed its stdin and begun calling
    # into build_city_street_inventory(). Cheap, stays permanently: it's
    # the anchor every downstream stage timestamp below is measured from.
    _cli_start = _time.monotonic()
    log.info(
        "[street-inventory-cli] begin country=%s city=%s",
        params.get("country_code"),
        params.get("city"),
    )
    result = await build_street_inventory_v2(params)
    log.info(
        "[street-inventory-cli] done country=%s city=%s status=%s elapsed=%.1fs",
        params.get("country_code"),
        params.get("city"),
        result.get("status"),
        _time.monotonic() - _cli_start,
    )
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def _run_with_graceful_shutdown(coro_fn) -> None:
    """
    BUG FIX (missing profiler report): the Node bridge (pythonBridge.ts /
    runEngineQuery) deliberately asks this process for more leads than it
    needs (`askFor`) and breaks out of its consuming loop as soon as its own
    target is met — that is the NORMAL way almost every run ends, not an
    error case. When it stops consuming early, its cleanup path now sends
    SIGTERM (see pythonBridge.ts gracefulKillProcessTree), falling back to
    SIGKILL only if this process doesn't exit on its own within a grace
    period.

    Without a handler, SIGTERM's default OS action terminates the
    interpreter immediately — same as SIGKILL — so run_query()'s outer
    `finally` (store.close(), profiler.print_report(), the __done__
    sentinel) never runs. That's the actual root cause of the missing
    profiler report: it's not that print_report() has a bug, it's that the
    process is being killed before Python ever gets to run it.

    LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
    this used to respond to SIGTERM by calling `task.cancel()`
    unconditionally. For every OTHER cli mode (verify/enrich/score/...) —
    short-lived, no background-thread work — that's safe and still exactly
    what happens below, just after a bounded wait. For the long-running
    discovery mode (`_main_cli` -> `run_query()`), it was actually the root
    cause of the reported "Target page, context or browser has been
    closed" race: `run_query()`'s production path drives
    `ExecutionDriver.run_once()` via `asyncio.to_thread(...)`, a real OS
    thread that `task.cancel()` cannot interrupt once it's running —
    cancelling only makes the *awaiting* coroutine stop waiting for it,
    orphaning the thread (see the module-level `_shutdown_event` docstring
    for the full mechanics). The orphaned thread would then keep calling
    into Playwright while the main coroutine's `finally` blocks (and,
    eventually, the Node bridge's SIGKILL escalation) tore down the very
    process the orphaned thread's browser lived in.

    The fix: SIGTERM now sets `_shutdown_event` — a cooperative flag
    `run_query()` itself checks at safe checkpoints (see its own
    docstring/comments) — and gives it `COOPERATIVE_SHUTDOWN_GRACE_S`
    seconds to wind down and finish *on its own* before falling back to
    the old `task.cancel()` behavior as a last resort. `_main_cli` also
    now catches the resulting `CancelledError` (if the fallback ever does
    fire) so `__done__` is still written either way — see `_main_cli`'s
    own comment for that half of the fix.
    """
    _cleanup_stop_sentinel_file()
    task = asyncio.ensure_future(coro_fn())
    _shutdown_event.clear()
    _set_shutdown_reason(None)
    escalate_task: Optional["asyncio.Task[None]"] = None

    def _on_sigterm() -> None:
        nonlocal escalate_task
        reason = _get_shutdown_reason()
        grace_s = _shutdown_grace_period_s(reason)
        log.warning(
            f"[service] received SIGTERM (reason={reason or 'unspecified'}) — requesting cooperative shutdown "
            "(run_query's own checkpoints get up to "
            f"{grace_s:.0f}s to wind down active work "
            "and let cleanup — including __done__ — run normally, before "
            "falling back to a forced cancellation)"
        )
        _shutdown_event.set()

        async def _escalate_if_still_running() -> None:
            await asyncio.sleep(grace_s)
            if not task.done():
                log.warning(
                    "[service] cooperative shutdown did not finish within "
                    f"{grace_s:.0f}s of SIGTERM ({reason or 'unspecified'}) — "
                    "escalating to forced task cancellation (same "
                    "last-resort behavior this handler always had; may "
                    "leave a background thread orphaned if one is still "
                    "running — see _shutdown_event's docstring)"
                )
                task.cancel()

        escalate_task = asyncio.ensure_future(_escalate_if_still_running())

    if sys.platform != "win32":
        # add_signal_handler needs a running loop and isn't supported on
        # Windows' default event loop; on Windows the process falls back to
        # the pre-existing (immediate) shutdown behavior.
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, _on_sigterm)

    try:
        await task
    except asyncio.CancelledError:
        log.info("[service] exited after escalated (forced) SIGTERM shutdown")
    finally:
        if escalate_task is not None and not escalate_task.done():
            escalate_task.cancel()
        confirm_and_emit_job_terminated()


async def score_business_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Opportunity Scoring for a business payload, including universal breakdown,
    profession scores for all canonical professions, and business health score.
    """
    from datetime import datetime, timedelta, timezone

    biz_id = str(payload.get("id") or payload.get("business_id") or "biz_unknown")
    biz_data = payload.get("business") if isinstance(payload.get("business"), dict) else payload

    scoring_service = OpportunityScoringService()
    res = scoring_service.evaluate_business_professions(biz_data, business_id=biz_id)

    raw_reviews = biz_data.get("reviews_count")
    if raw_reviews is None:
        raw_reviews = biz_data.get("review_count")
    if raw_reviews is None:
        raw_reviews = biz_data.get("reviews")

    raw_rating = biz_data.get("reviews_rating")
    if raw_rating is None:
        raw_rating = biz_data.get("rating")

    website = biz_data.get("website")
    website_reachable = (
        bool(biz_data["website_reachable"])
        if biz_data.get("website_reachable") is not None
        else bool(website)
    )
    https_val = (
        bool(biz_data["ssl_valid"])
        if biz_data.get("ssl_valid") is not None
        else str(website or "").startswith("https://")
    )

    signals = biz_data.get("signals") if isinstance(biz_data.get("signals"), dict) else {}
    ig_days = signals.get("ig_last_post_days") if signals else None
    if ig_days is None:
        ig_days = biz_data.get("ig_last_post_days")
    last_post_date = biz_data.get("instagram_last_post_date") or biz_data.get("last_post_date")
    if not last_post_date and isinstance(ig_days, (int, float)):
        last_post_date = (datetime.now(timezone.utc) - timedelta(days=int(ig_days))).isoformat()

    ig_reachable = (
        bool(biz_data["instagram_reachable"])
        if biz_data.get("instagram_reachable") is not None
        else bool(biz_data.get("instagram"))
    )

    health_score = ScoringWorker._business_health_component(
        type("TempBiz", (), {
            "rating": raw_rating,
            "review_count": raw_reviews,
            "website": website,
        })(),
        type("TempWebsite", (), {
            "website_reachable": website_reachable,
            "https": https_val,
        })(),
        type("TempIG", (), {
            "profile_reachable": ig_reachable,
            "last_post_date": last_post_date,
        })()
    )

    return {
        "business_id": res.business_id,
        "is_disqualified": res.is_disqualified,
        "universal_breakdown": res.universal_breakdown.to_dict(),
        "health_score": health_score,
        "profession_scores": {
            s.profession_slug: {
                "score": s.score,
                "breakdown": s.breakdown.to_dict(),
                "summary": s.summary,
                "reasons": list(s.reasons),
            }
            for s in res.profession_scores
        }
    }


async def _score_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await score_business_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _opportunity_from_payload(raw_opp: dict):
    """
    Shared Opportunity construction used by qualify, prioritize (and any
    future CLI mode that needs a canonical Opportunity). Factored out of
    qualify_business_v2 so prioritize_opportunity_v2 builds the identical
    Opportunity instead of duplicating the parsing/coercion logic.
    """
    import datetime as _dt
    from opportunities import Opportunity

    discovered_raw = raw_opp.get("discovered_at")
    if isinstance(discovered_raw, str):
        try:
            discovered_at = _dt.datetime.fromisoformat(discovered_raw.replace("Z", "+00:00"))
        except ValueError:
            discovered_at = _dt.datetime.now(_dt.timezone.utc)
    elif isinstance(discovered_raw, (int, float)):
        discovered_at = _dt.datetime.fromtimestamp(discovered_raw / 1000, tz=_dt.timezone.utc)
    else:
        discovered_at = _dt.datetime.now(_dt.timezone.utc)

    return Opportunity(
        opportunity_id=str(raw_opp.get("opportunity_id") or raw_opp.get("id") or "opp_unknown"),
        business_id=str(raw_opp.get("business_id") or raw_opp.get("businessId") or "biz_unknown"),
        niche_id=str(raw_opp.get("niche_id") or raw_opp.get("nicheId") or raw_opp.get("niche") or "unknown"),
        opportunity_type_id=str(raw_opp.get("opportunity_type_id") or raw_opp.get("type") or "unknown"),
        discovered_at=discovered_at,
        supporting_signal_ids=tuple(raw_opp.get("supporting_signal_ids") or []),
    )


async def qualify_business_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Qualification for an opportunity payload.

    Accepts either:
      - An Opportunity-shaped dict: {opportunity_id, business_id, niche_id,
        opportunity_type_id, discovered_at?, supporting_signal_ids?}
      - A top-level payload with an "opportunity" key containing the above.

    Returns the canonical OpportunityQualification result serialised as a plain dict.
    """
    raw_opp = payload.get("opportunity") if isinstance(payload.get("opportunity"), dict) else payload
    opp = _opportunity_from_payload(raw_opp)

    qual_service = OpportunityQualificationService()
    res = qual_service.evaluate(opp)
    return {
        "opportunity_id": res.opportunity_id,
        "status": res.status.value,
        "qualified": res.status.value == "QUALIFIED",
        "passed_rule_ids": list(res.passed_rule_ids),
        "failed_rule_ids": list(res.failed_rule_ids),
    }


async def _qualify_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await qualify_business_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def prioritize_opportunity_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Opportunity Prioritization (Subsystem 12) for a
    single opportunity payload.

    Mirrors qualify_business_v2 / score_business_v2's payload shape:
      - An Opportunity-shaped dict, or a top-level payload with an
        "opportunity" key containing one.
      - Optional "policy": {strategy?, evaluation_at?, score_weight?,
        recency_weight?, recency_half_life_days?, require_qualification?}

    Reuses the same Qualification and Scoring evaluations qualify/score
    already expose, then feeds all three into
    OpportunityPrioritizationService per the locked batch pipeline order
    (Qualification -> Scoring -> Prioritization).
    """
    import datetime as _dt
    from opportunity_prioritization.service import OpportunityPrioritizationService
    from opportunity_prioritization.models import PrioritizationPolicy, PrioritizationStrategy

    raw_opp = payload.get("opportunity") if isinstance(payload.get("opportunity"), dict) else payload
    opp = _opportunity_from_payload(raw_opp)

    qualification = OpportunityQualificationService().evaluate(opp)
    score = OpportunityScoringService().evaluate(opp)

    raw_policy = payload.get("policy") or {}
    strategy_raw = str(raw_policy.get("strategy") or "BALANCED").upper()
    try:
        strategy = PrioritizationStrategy(strategy_raw)
    except ValueError:
        strategy = PrioritizationStrategy.BALANCED

    eval_at_raw = raw_policy.get("evaluation_at")
    if isinstance(eval_at_raw, str):
        try:
            evaluation_at = _dt.datetime.fromisoformat(eval_at_raw.replace("Z", "+00:00"))
        except ValueError:
            evaluation_at = _dt.datetime.now(_dt.timezone.utc)
    elif isinstance(eval_at_raw, (int, float)):
        evaluation_at = _dt.datetime.fromtimestamp(eval_at_raw / 1000, tz=_dt.timezone.utc)
    else:
        evaluation_at = _dt.datetime.now(_dt.timezone.utc)

    policy_kwargs = dict(
        strategy=strategy,
        evaluation_at=evaluation_at,
        recency_half_life_days=float(raw_policy.get("recency_half_life_days", 30.0)),
        require_qualification=bool(raw_policy.get("require_qualification", True)),
    )
    if strategy == PrioritizationStrategy.CUSTOM_WEIGHTED:
        policy_kwargs["score_weight"] = raw_policy.get("score_weight")
        policy_kwargs["recency_weight"] = raw_policy.get("recency_weight")

    policy = PrioritizationPolicy(**policy_kwargs)

    result = OpportunityPrioritizationService.evaluate_priority(opp, qualification, score, policy)

    return {
        "opportunity_id": result.opportunity_id,
        "priority_score": result.priority_score,
        "score_contribution": result.score_contribution,
        "recency_contribution": result.recency_contribution,
        "is_eligible": result.is_eligible,
        "qualification_status": qualification.status.value,
        "overall_score": score.overall_score,
    }


async def _prioritize_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await prioritize_opportunity_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def evaluate_crm_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 CRM Intelligence (relationship health, lifecycle stage,
    contact guardrail). Accepts the Node bridge payload containing:
      - workspace_id, business_id, current_timestamp_iso (required)
      - interaction_history: list of {timestamp_iso, interaction_type, outcome_type?,
        is_opt_out?, is_conversion?, is_positive?}
      - policy: optional {max_attempts_per_window, window_days, cooling_off_days, dormancy_days}
    """
    import datetime as _dt
    workspace_id = payload.get("workspace_id") or "workspace"
    business_id = payload.get("business_id") or payload.get("id") or "business"
    ts = payload.get("current_timestamp_iso") or _dt.datetime.now(_dt.timezone.utc).isoformat()

    raw_history = payload.get("interaction_history") or []
    history = tuple(
        CRMInteractionRecord(
            timestamp_iso=r.get("timestamp_iso", ts),
            interaction_type=r.get("interaction_type", "contact"),
            outcome_type=r.get("outcome_type", ""),
            is_opt_out=bool(r.get("is_opt_out", False)),
            is_conversion=bool(r.get("is_conversion", False)),
            is_positive=bool(r.get("is_positive", False)),
        )
        for r in raw_history
        if isinstance(r, dict) and r.get("timestamp_iso")
    )

    raw_policy = payload.get("policy") or {}
    policy = CRMContactPolicy(
        max_attempts_per_window=int(raw_policy.get("max_attempts_per_window", 3)),
        window_days=int(raw_policy.get("window_days", 30)),
        cooling_off_days=int(raw_policy.get("cooling_off_days", 14)),
        dormancy_days=int(raw_policy.get("dormancy_days", 60)),
    )

    req = CRMRelationshipRequest(
        workspace_id=workspace_id,
        business_id=business_id,
        current_timestamp_iso=ts,
        interaction_history=history,
        policy=policy,
    )
    rel = CRMIntelligenceService.evaluate_relationship(req)
    return {
        "stage": rel.stage.value,
        "health": rel.health.value,
        "guardrail": rel.guardrail_decision.value,
        "total_attempts": rel.total_attempts,
        "attempts_in_window": rel.attempts_in_window,
        "days_since_last_interaction": rel.days_since_last_interaction,
        "reason": rel.reason,
    }


async def _crm_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_crm_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _fetch_batch_intelligence_context(session_id: str):
    """
    Persistence Integration milestone, Part 5 (read path): loads this
    session's persisted priorities/ranks/missions/workflow_states via
    SupabaseBatchIntelligenceBackend and projects them into an
    EngineContext (engine_context/service.py's ContextProjectionService
    -- Subsystem 16, which existed for exactly this purpose but had no
    caller anywhere in this repo before this milestone) so
    AnalyticsService.compute_analytics() (analytics/service.py) can
    consume real persisted state instead of anything being recomputed.
    Never raises for a session with no persisted rows yet (returns an
    EngineContext with empty tuples, the same as
    ContextProjectionService.project()'s own documented behavior for
    absent inputs) -- callers decide whether an empty context is
    meaningful for their response.
    """
    from engine_context.models import (
        ContextComponent,
        ContextProjectionRequest,
        ContextSubject,
        ContextSubjectType,
    )
    from engine_context.service import ContextProjectionService

    batch_backend = _build_batch_intelligence_backend()
    priorities = batch_backend.fetch_priorities_for_session(session_id)
    ranks = batch_backend.fetch_ranked_opportunities(session_id)
    missions = batch_backend.fetch_missions_for_session(session_id)
    workflows = batch_backend.fetch_workflow_states_for_session(session_id)

    request = ContextProjectionRequest(
        subject=ContextSubject(subject_id=session_id, subject_type=ContextSubjectType.WORKSPACE),
        requested_components=(
            ContextComponent.PRIORITY,
            ContextComponent.RANK,
            ContextComponent.MISSION,
            ContextComponent.WORKFLOW,
        ),
    )
    return ContextProjectionService.project(
        request,
        priorities=priorities,
        ranks=ranks,
        missions=missions,
        workflows=workflows,
    )


def _analytics_report_dict(report) -> dict:
    import dataclasses

    return dataclasses.asdict(report)


async def evaluate_analytics_v2(payload: dict) -> dict:
    """
    Returns pipeline analytics from raw pipeline snapshot metrics.
    The AnalyticsService requires an EngineContext object; for the lightweight
    Node-bridge use case we compute summary statistics directly from the
    snapshot fields that Node already has (total_discovered, total_qualified,
    total_contacted, total_won, stalled_deals_count).

    Persistence Integration milestone, Part 5 addition: when payload
    also carries "session_id", the response additionally includes
    "batch_intelligence" -- a real AnalyticsService.compute_analytics()
    report (analytics/models.AnalyticsReport, Subsystem 18) computed
    from that session's persisted Prioritization/Ranking/Mission
    Generation/Workflow Initialization output, loaded via
    _fetch_batch_intelligence_context() rather than recomputed. This is
    purely additive: callers that do not pass session_id (every existing
    caller today) see byte-identical output to before this milestone.
    """
    total_discovered = int(payload.get("total_discovered") or 0)
    total_qualified = int(payload.get("total_qualified") or 0)
    total_contacted = int(payload.get("total_contacted") or 0)
    total_won = int(payload.get("total_won") or 0)

    def _rate(num: int, denom: int) -> float:
        return round(num / denom * 100, 1) if denom > 0 else 0.0

    result = {
        "total_discovered": total_discovered,
        "total_qualified": total_qualified,
        "total_contacted": total_contacted,
        "total_won": total_won,
        "qualification_rate_pct": _rate(total_qualified, total_discovered),
        "contact_rate_pct": _rate(total_contacted, total_qualified),
        "win_rate_pct": _rate(total_won, total_contacted),
        "end_to_end_rate_pct": _rate(total_won, total_discovered),
    }

    session_id = payload.get("session_id")
    if session_id:
        from analytics.service import AnalyticsService

        try:
            context = _fetch_batch_intelligence_context(str(session_id))
            report = AnalyticsService.compute_analytics(context)
            result["batch_intelligence"] = _analytics_report_dict(report)
        except Exception:
            log.warning(
                "[evaluate_analytics_v2] failed to load persisted batch "
                "intelligence for session_id=%s", session_id, exc_info=True,
            )

    return result


async def _analytics_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_analytics_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def build_ai_coach_context_v2(payload: dict) -> dict:
    """
    Engine 2.0 builds the canonical structured intelligence context payload
    (BusinessContext, ScoringContext, RelationshipContext, AnalyticsContext)
    that Node transports verbatim to Claude/OpenAI — Engine reasons, Node transports.
    """
    biz_data = payload.get("business") or {}
    crm_data = payload.get("crm") or {}
    stalled_deals = payload.get("stalledDeals") or []
    snapshot = payload.get("snapshot") or {}

    # Business scoring context — Engine 2.0 computes all profession scores.
    scores_res = OpportunityScoringService().evaluate_business_professions(biz_data) if biz_data else None

    # CRM relationship context — synchronous Engine 2.0 evaluation.
    crm_res: dict = {}
    if crm_data:
        crm_res = await evaluate_crm_v2(crm_data)

    # Analytics context — pass through from Node's already-computed snapshot.
    analytics_res: dict = {}
    if snapshot:
        analytics_res = await evaluate_analytics_v2(snapshot)

    result = {
        "business_context": {
            "name": biz_data.get("name"),
            "category": biz_data.get("category") or biz_data.get("niche"),
            "website": biz_data.get("website"),
            "rating": biz_data.get("reviews_rating") or biz_data.get("rating"),
            "reviews_count": biz_data.get("reviews_count") or biz_data.get("reviews"),
        },
        "scoring_context": {
            "is_disqualified": scores_res.is_disqualified if scores_res else False,
            "universal_breakdown": scores_res.universal_breakdown.to_dict() if scores_res else {},
            "profession_scores": {
                s.profession_slug: {"score": s.score, "summary": s.summary, "reasons": list(s.reasons)}
                for s in scores_res.profession_scores
            } if scores_res else {},
        },
        "relationship_context": crm_res,
        "analytics_context": analytics_res,
        "stalled_deals": stalled_deals,
    }

    # Persistence Integration milestone, Part 5 addition: when payload
    # carries "opportunity_id", surface that opportunity's persisted
    # Mission + WorkflowState (Subsystems 14/15, written by
    # run_batch_intelligence()) as "mission_context" -- read-path-only,
    # via the same SupabaseBatchIntelligenceBackend every other reader
    # in this file now uses. Additive: callers that don't pass
    # opportunity_id (every existing caller today) see byte-identical
    # output to before this milestone.
    opportunity_id = payload.get("opportunity_id")
    if opportunity_id:
        try:
            batch_backend = _build_batch_intelligence_backend()
            mission = batch_backend.fetch_mission(str(opportunity_id))
            workflow_state = batch_backend.fetch_workflow_state(str(opportunity_id))
            result["mission_context"] = {
                "mission": (
                    {
                        "opportunity_id": mission.opportunity_id,
                        "business_id": mission.business_id,
                        "mission_type": mission.mission_type.value,
                    }
                    if mission is not None else None
                ),
                "workflow_state": (
                    _workflow_state_dict(workflow_state)
                    if workflow_state is not None else None
                ),
            }
        except Exception:
            log.warning(
                "[build_ai_coach_context_v2] failed to load persisted "
                "mission context for opportunity_id=%s", opportunity_id,
                exc_info=True,
            )

    return result


async def _ai_coach_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await build_ai_coach_context_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _workflow_state_dict(state) -> dict:
    return {
        "mission_id": state.mission_id,
        "opportunity_id": state.opportunity_id,
        "business_id": state.business_id,
        "status": state.status.value,
    }


async def evaluate_workflow_v2(payload: dict) -> dict:
    """
    Evaluates Engine 2.0 Workflow Engine (Subsystem 15) transitions for the
    Node bridge's on-demand "Workflow Transition" step.

    Two actions, selected by payload["action"] (case-insensitive):
      - "initialize": builds a Mission from payload["mission"] and returns
        the initial UNSTARTED WorkflowState via
        WorkflowEngineService.initialize_workflow(). Used when a workspace
        needs a WorkflowState for a mission that doesn't have one on
        record yet.
      - "transition" (default): evaluates a single (WorkflowState,
        WorkflowEvent) pair from payload["state"] and payload["event"] via
        WorkflowEngineService.transition().
    """
    import datetime as _dt
    from mission_generation.models import Mission, MissionType
    from workflow.service import WorkflowEngineService
    from workflow.models import WorkflowEvent, WorkflowEventType, WorkflowState, WorkflowStatus

    action = str(payload.get("action") or "").lower()
    if not action:
        action = "initialize" if "mission" in payload and "event" not in payload else "transition"

    if action == "initialize":
        raw_mission = payload.get("mission") if isinstance(payload.get("mission"), dict) else payload
        mission = Mission(
            opportunity_id=str(raw_mission.get("opportunity_id") or raw_mission.get("id") or "opp_unknown"),
            business_id=str(raw_mission.get("business_id") or raw_mission.get("businessId") or "biz_unknown"),
            mission_type=MissionType(str(raw_mission.get("mission_type") or raw_mission.get("type") or "OUTREACH").upper()),
        )
        state = WorkflowEngineService.initialize_workflow(mission)
        return {"action": "initialize", "state": _workflow_state_dict(state)}

    raw_state = payload.get("state") or payload.get("current_state")
    if raw_state:
        current_state = WorkflowState(
            mission_id=str(raw_state.get("mission_id") or raw_state.get("opportunity_id") or "opp_unknown"),
            opportunity_id=str(raw_state.get("opportunity_id") or "opp_unknown"),
            business_id=str(raw_state.get("business_id") or "biz_unknown"),
            status=WorkflowStatus(str(raw_state.get("status") or "UNSTARTED").upper()),
        )
    else:
        # Persistence Integration milestone, Part 5 (read path): no
        # inline `state`/`current_state` payload was supplied -- rather
        # than falling back to a fabricated "opp_unknown" WorkflowState
        # (the pre-persistence behavior), load the real persisted
        # WorkflowState for payload["opportunity_id"] via
        # SupabaseBatchIntelligenceBackend.fetch_workflow_state(),
        # written by run_batch_intelligence()'s Workflow Initialization
        # step. This is the on-demand chain consuming persisted state
        # instead of recomputing/guessing it.
        opportunity_id = str(
            payload.get("opportunity_id") or payload.get("id") or ""
        ).strip()
        if not opportunity_id:
            raise ValueError(
                "evaluate_workflow_v2: 'transition' action requires either "
                "a 'state'/'current_state' payload or an 'opportunity_id' "
                "to load a persisted WorkflowState for."
            )
        batch_backend = _build_batch_intelligence_backend()
        current_state = batch_backend.fetch_workflow_state(opportunity_id)
        if current_state is None:
            raise ValueError(
                f"evaluate_workflow_v2: no persisted WorkflowState found for "
                f"opportunity_id={opportunity_id!r}; Workflow Initialization "
                f"may not have run for this opportunity yet."
            )

    raw_event = payload.get("event") or {}
    event = WorkflowEvent(
        event_type=WorkflowEventType(str(raw_event.get("event_type") or raw_event.get("type") or "QUEUE").upper()),
        timestamp_iso=str(raw_event.get("timestamp_iso") or _dt.datetime.now(_dt.timezone.utc).isoformat()),
        reason=raw_event.get("reason"),
    )

    result = WorkflowEngineService.transition(current_state, event)

    if result.success:
        # Persist the advanced state back so the next on-demand
        # transition (and Mission Intelligence / Analytics / AI Coach
        # reads) see the new status rather than the stale batch-
        # initialization one. Never persists a failed transition's
        # unchanged new_state==previous_state.
        try:
            batch_backend = _build_batch_intelligence_backend()
            batch_backend.update_workflow_state(result.new_state)
        except Exception:
            log.warning(
                "[evaluate_workflow_v2] failed to persist transitioned "
                "WorkflowState for opportunity_id=%s",
                result.new_state.opportunity_id, exc_info=True,
            )

    return {
        "action": "transition",
        "success": result.success,
        "previous_state": _workflow_state_dict(result.previous_state),
        "new_state": _workflow_state_dict(result.new_state),
        "error_message": result.error_message,
    }


async def _workflow_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_workflow_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def _mission_progression_dict(evaluation) -> dict:
    from mission_generation.models import Mission

    def _mission_dict(m: Mission | None) -> dict | None:
        if m is None:
            return None
        return {
            "opportunity_id": m.opportunity_id,
            "business_id": m.business_id,
            "mission_type": m.mission_type.value,
        }

    return {
        "current_mission": _mission_dict(evaluation.current_mission),
        "workflow_state": _workflow_state_dict(evaluation.workflow_state),
        "next_mission": _mission_dict(evaluation.next_mission),
        "rule_applied": evaluation.rule_applied.value,
        "reason": evaluation.reason,
    }


async def evaluate_mission_intelligence_v2(payload: dict) -> dict:
    """
    Persistence Integration milestone, Part 5 (read path): Mission
    Intelligence (Subsystem 22) had no CLI entrypoint anywhere in this
    file before this milestone -- MissionIntelligenceService.
    derive_next_mission() (mission_intelligence/service.py) has existed
    since that subsystem was built but was never wired to anything
    outside tests/validate_mission_intelligence.py. This is that wiring,
    and it is read-path-only: it loads the persisted Mission and
    WorkflowState for payload["opportunity_id"] (written by
    run_batch_intelligence()'s Mission Generation / Workflow
    Initialization steps) and the most recent persisted FeedbackRecord
    for that opportunity, if any -- it does not recompute Prioritization,
    Ranking, or Mission Generation itself (Part 5's own requirement).

    payload:
      - opportunity_id (required)
    """
    from feedback.models import FeedbackTargetType
    from mission_intelligence.service import MissionIntelligenceService

    opportunity_id = str(payload.get("opportunity_id") or payload.get("id") or "").strip()
    if not opportunity_id:
        raise ValueError(
            "evaluate_mission_intelligence_v2 requires 'opportunity_id'."
        )

    batch_backend = _build_batch_intelligence_backend()

    mission = batch_backend.fetch_mission(opportunity_id)
    if mission is None:
        raise ValueError(
            f"evaluate_mission_intelligence_v2: no persisted Mission found "
            f"for opportunity_id={opportunity_id!r}; Mission Generation may "
            f"not have run for this opportunity yet."
        )

    workflow_state = batch_backend.fetch_workflow_state(opportunity_id)
    if workflow_state is None:
        raise ValueError(
            f"evaluate_mission_intelligence_v2: no persisted WorkflowState "
            f"found for opportunity_id={opportunity_id!r}; Workflow "
            f"Initialization may not have run for this opportunity yet."
        )

    feedback_records = batch_backend.fetch_feedback_for_target(
        FeedbackTargetType.OPPORTUNITY, opportunity_id
    )
    latest_feedback = feedback_records[0] if feedback_records else None

    evaluation = MissionIntelligenceService.derive_next_mission(
        mission, workflow_state, latest_feedback
    )
    return _mission_progression_dict(evaluation)


async def _mission_intelligence_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await evaluate_mission_intelligence_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


async def capture_feedback_v2(payload: dict) -> dict:
    """
    Persistence Integration milestone, Part 4/5 (write path for
    Feedback): feedback/service.py's FeedbackService.capture_feedback()
    has existed since Subsystem 19 was built but, like Mission
    Intelligence, had zero production callers before this milestone
    (repository audit confirmed only tests/validate_feedback.py
    exercised it). This CLI mode captures a FeedbackRecord and persists
    it via SupabaseBatchIntelligenceBackend.persist_feedback() so
    evaluate_mission_intelligence_v2() above (and any future on-demand
    reader) can read it back without the caller having to resupply it.

    payload:
      - target_type (required — 'opportunity' | 'mission' | 'business' | 'provider')
      - target_id (required)
      - outcome (required)
      - notes (optional)
      - metadata (optional — list of [key, value] pairs)
    """
    from feedback.service import FeedbackService

    record = FeedbackService.capture_feedback(
        target_type=str(payload.get("target_type") or ""),
        target_id=str(payload.get("target_id") or ""),
        outcome=str(payload.get("outcome") or ""),
        notes=payload.get("notes"),
        metadata=[tuple(pair) for pair in (payload.get("metadata") or [])],
    )

    batch_backend = _build_batch_intelligence_backend()
    batch_backend.persist_feedback(record)

    return {
        "target_type": record.target_type.value,
        "target_id": record.target_id,
        "outcome": record.outcome.value,
        "notes": record.evidence.notes,
        "metadata": [list(pair) for pair in record.evidence.metadata],
    }


async def _feedback_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await capture_feedback_v2(params)
    _REAL_STDOUT.write(json.dumps(result, default=str))
    _REAL_STDOUT.flush()


def test_windows_job_object_constants_and_types() -> None:
    assert JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0x00002000
    assert JobObjectExtendedLimitInformation == 9
    assert JobObjectBasicAccountingInformation == 1
    assert ERROR_ALREADY_EXISTS == 183
    assert PROCESS_SET_QUOTA == 0x0100
    assert PROCESS_TERMINATE == 0x0001
    if sys.platform == "win32":
        assert ctypes.sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION) == 64
        assert ctypes.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) == 144
        assert ctypes.sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION) == 48


def test_windows_job_object_creation_and_config() -> None:
    if sys.platform != "win32":
        return
    job_name = f"Local\\MAST_TEST_JOB_{os.getpid()}_{int(time.time()*1000)}"
    h_job = kernel32.CreateJobObjectW(None, job_name)
    assert h_job, f"CreateJobObjectW failed: {kernel32.GetLastError()}"
    try:
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        res = kernel32.SetInformationJobObject(
            h_job, JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
        )
        assert res, f"SetInformationJobObject failed: {kernel32.GetLastError()}"
        active = query_job_active_processes(h_job)
        assert active == 0, f"Expected 0 active processes before assignment, got {active}"
    finally:
        kernel32.CloseHandle(h_job)


def test_windows_job_object_browser_assignment() -> None:
    if sys.platform != "win32":
        return
    job_name = f"Local\\MAST_TEST_JOB_ASSIGN_{os.getpid()}_{int(time.time()*1000)}"
    h_job = kernel32.CreateJobObjectW(None, job_name)
    assert h_job, f"CreateJobObjectW failed: {kernel32.GetLastError()}"
    try:
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        kernel32.SetInformationJobObject(
            h_job, JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
        )
        # Verify Python itself is NOT in the Job Object
        assert query_job_active_processes(h_job) == 0

        # Spawn a dummy child process and assign its PID to the Job Object
        import subprocess
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
        try:
            res = assign_pid_to_windows_job(h_job, child.pid)
            assert res is True, f"assign_pid_to_windows_job failed for child {child.pid}"
            active = query_job_active_processes(h_job)
            assert active == 1, f"Expected 1 active process in Job Object, got {active}"

            # Terminate Job Object -> kills child process
            term_ok = terminate_and_verify_windows_job(h_job, timeout_s=1.0)
            assert term_ok is True
            assert query_job_active_processes(h_job) == 0
            # Python survives!
            assert True
        finally:
            try:
                child.kill()
            except Exception:
                pass
    finally:
        close_windows_job_handle(h_job)


def test_windows_job_object_readiness_and_ack_success() -> None:
    global _MAST_JOB_BOOTSTRAP_CONFIRMED
    _MAST_JOB_BOOTSTRAP_CONFIRMED = False

    nonce = f"nonce_{int(time.time()*1000)}"
    in_s = io.StringIO(json.dumps({"type": "MAST_JOB_ACK", "nonce": nonce, "status": "CONFIRMED"}) + "\n")
    out_s = io.StringIO()
    err_s = io.StringIO()

    res = bootstrap_windows_job_object(
        job_name=f"Local\\MAST_JOB_test_{os.getpid()}_{int(time.time()*1000)}",
        scout_id="scout_test_success",
        nonce=nonce,
        in_stream=in_s,
        out_stream=out_s,
        err_stream=err_s,
        assign_self=False,
    )
    assert res is True
    ready = json.loads(out_s.getvalue().strip())
    assert ready["type"] == "MAST_JOB_READY"
    assert ready["scoutId"] == "scout_test_success"
    assert ready["nonce"] == nonce
    assert ready["pid"] == os.getpid()


def test_windows_job_object_readiness_and_ack_rejections() -> None:
    global _MAST_JOB_BOOTSTRAP_CONFIRMED

    # 1. Bad nonce
    _MAST_JOB_BOOTSTRAP_CONFIRMED = False
    in_bad_nonce = io.StringIO(json.dumps({"type": "MAST_JOB_ACK", "nonce": "wrong_nonce", "status": "CONFIRMED"}) + "\n")
    try:
        bootstrap_windows_job_object(
            job_name=f"Local\\MAST_JOB_rej_{os.getpid()}_1",
            scout_id="scout_rej_1",
            nonce="nonce_expected_1",
            in_stream=in_bad_nonce,
            out_stream=io.StringIO(),
            err_stream=io.StringIO(),
            assign_self=False,
        )
        assert False, "Expected exit 79 on bad nonce"
    except SystemExit as exc:
        assert exc.code == 79

    # 2. Bad type
    _MAST_JOB_BOOTSTRAP_CONFIRMED = False
    in_bad_type = io.StringIO(json.dumps({"type": "MAST_OTHER_TYPE", "nonce": "nonce_2", "status": "CONFIRMED"}) + "\n")
    try:
        bootstrap_windows_job_object(
            job_name=f"Local\\MAST_JOB_rej_{os.getpid()}_2",
            scout_id="scout_rej_2",
            nonce="nonce_2",
            in_stream=in_bad_type,
            out_stream=io.StringIO(),
            err_stream=io.StringIO(),
            assign_self=False,
        )
        assert False, "Expected exit 79 on bad type"
    except SystemExit as exc:
        assert exc.code == 79

    # 3. Rejected status
    _MAST_JOB_BOOTSTRAP_CONFIRMED = False
    in_bad_status = io.StringIO(json.dumps({"type": "MAST_JOB_ACK", "nonce": "nonce_3", "status": "REJECTED"}) + "\n")
    try:
        bootstrap_windows_job_object(
            job_name=f"Local\\MAST_JOB_rej_{os.getpid()}_3",
            scout_id="scout_rej_3",
            nonce="nonce_3",
            in_stream=in_bad_status,
            out_stream=io.StringIO(),
            err_stream=io.StringIO(),
            assign_self=False,
        )
        assert False, "Expected exit 79 on rejected status"
    except SystemExit as exc:
        assert exc.code == 79

    # 4. Invalid prefix
    _MAST_JOB_BOOTSTRAP_CONFIRMED = False
    try:
        bootstrap_windows_job_object(
            job_name="Global\\INVALID_PREFIX",
            scout_id="scout_rej_4",
            nonce="nonce_4",
            out_stream=io.StringIO(),
            err_stream=io.StringIO(),
            assign_self=False,
        )
        assert False, "Expected exit 78 on invalid prefix"
    except SystemExit as exc:
        assert exc.code == 78

    # 5. EOF on stdin
    _MAST_JOB_BOOTSTRAP_CONFIRMED = False
    in_eof = io.StringIO("")
    try:
        bootstrap_windows_job_object(
            job_name=f"Local\\MAST_JOB_rej_{os.getpid()}_5",
            scout_id="scout_rej_5",
            nonce="nonce_5",
            in_stream=in_eof,
            out_stream=io.StringIO(),
            err_stream=io.StringIO(),
            assign_self=False,
        )
        assert False, "Expected exit 79 on EOF"
    except SystemExit as exc:
        assert exc.code == 79


def test_windows_job_object_duplicate_rejection() -> None:
    if sys.platform != "win32":
        return
    global _MAST_JOB_BOOTSTRAP_CONFIRMED
    _MAST_JOB_BOOTSTRAP_CONFIRMED = False

    job_name = f"Local\\MAST_JOB_DUP_{os.getpid()}_{int(time.time()*1000)}"
    h_job = kernel32.CreateJobObjectW(None, job_name)
    assert h_job, f"Initial CreateJobObjectW failed: {kernel32.GetLastError()}"
    try:
        in_s = io.StringIO(json.dumps({"type": "MAST_JOB_ACK", "nonce": "nonce_dup", "status": "CONFIRMED"}) + "\n")
        try:
            bootstrap_windows_job_object(
                job_name=job_name,
                scout_id="scout_dup",
                nonce="nonce_dup",
                in_stream=in_s,
                out_stream=io.StringIO(),
                err_stream=io.StringIO(),
                assign_self=False,
            )
            assert False, "Expected exit 78 on duplicate Job Object name"
        except SystemExit as exc:
            assert exc.code == 78
    finally:
        kernel32.CloseHandle(h_job)


def test_browser_reuse_rejection_lifecycle() -> None:
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_reuse_test")
    assert scraper.is_owned is False
    assert scraper.is_launched is False
    assert scraper.is_closed is False

    # Simulate active/launched state
    scraper._is_launched = True
    scraper._is_owned = True

    # Re-entry via __aenter__ must be strictly rejected
    import pytest
    with pytest.raises(RuntimeError, match="reuse is strictly prohibited"):
        asyncio.run(scraper.__aenter__())

    # Simulate closed state
    scraper._is_closed = True
    scraper._is_owned = False

    # Calling __aenter__ or search on closed instance must be rejected
    with pytest.raises(RuntimeError, match="reuse is strictly prohibited"):
        asyncio.run(scraper.__aenter__())

    async def _test_search_reuse():
        async for _ in scraper.search("test", "test"):
            pass

    with pytest.raises(RuntimeError, match="reuse is strictly prohibited"):
        asyncio.run(_test_search_reuse())


def test_windows_job_termination_zero_active_processes() -> None:
    # Simulated query counts: 2 active -> 1 active -> 0 active
    simulated_counts = [2, 1, 0]

    def mock_query(h):
        if simulated_counts:
            return simulated_counts.pop(0)
        return 0

    res = terminate_and_verify_windows_job(
        h_job=12345, timeout_s=1.0, poll_interval_s=0.01, query_fn=mock_query
    )
    assert res is True


def test_windows_job_termination_never_reports_premature_success() -> None:
    # Query function where processes hang and never reach 0
    def mock_query_hanging(h):
        return 1

    res = terminate_and_verify_windows_job(
        h_job=12345, timeout_s=0.15, poll_interval_s=0.02, query_fn=mock_query_hanging
    )
    assert res is False, "Must never report True when active processes remains > 0"


def test_posix_pgid_retention_and_immutability() -> None:
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(), scout_id="scout_posix_test")
    scraper.set_browser_identity(pid=45678, pgid=45678)
    assert scraper.browser_pid == 45678
    assert scraper.browser_pgid == 45678

    # Attempting to overwrite with None/0 must preserve existing retained PGID
    scraper.set_browser_identity(pid=0, pgid=0)
    assert scraper.browser_pgid == 45678

    scraper.set_browser_identity(pid=123, pgid=None)
    assert scraper.browser_pgid == 45678

    # Retained even if browser object is cleared
    scraper._browser = None
    assert scraper.browser_pgid == 45678


def test_posix_termination_existing_process_group() -> None:
    """Issue 1: Group exists (killpg succeeds) -> _is_process_group_extinct returns False."""
    def mock_kill(pgid, sig):
        assert sig == 0
        return None  # Success means process group exists and is alive

    assert _is_process_group_extinct(88888, mock_kill) is False


def test_posix_termination_esrch_confirmation() -> None:
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


def test_posix_termination_eperm_rejected() -> None:
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


def test_posix_termination_unexpected_os_error_rejected() -> None:
    """Issue 1: Unexpected OS errors (e.g. EINVAL, EIO) must NOT be interpreted as termination."""
    for code in (errno.EINVAL, errno.EIO, errno.EACCES):
        def mock_kill_err(pgid, sig, c=code):
            err = OSError()
            err.errno = c
            raise err

        assert _is_process_group_extinct(88888, mock_kill_err) is False
        res = terminate_and_verify_posix_group(pgid=88888, timeout_s=0.1, poll_interval_s=0.02, kill_fn=mock_kill_err)
        assert res is False


def test_posix_termination_timeout_with_group_alive() -> None:
    """Issue 1: When process group remains alive throughout timeout window, termination fails."""
    def mock_kill_always_alive(pgid, sig):
        return None  # Process group exists

    res = terminate_and_verify_posix_group(
        pgid=66666, timeout_s=0.15, poll_interval_s=0.02, kill_fn=mock_kill_always_alive
    )
    assert res is False, "Must return False when process group remains alive throughout timeout"


def test_genuine_posix_subprocess_process_group_termination() -> None:
    """Issue 1: Genuine POSIX subprocess integration test verifying actual OS-level behavior."""
    if sys.platform == "win32":
        return
    import subprocess
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        start_new_session=True,
    )
    try:
        pgid = os.getpgid(proc.pid)
        assert pgid > 0
        assert not _is_process_group_extinct(pgid, os.killpg)
        confirmed = terminate_and_verify_posix_group(pgid, timeout_s=3.0)
        assert confirmed is True
        assert _is_process_group_extinct(pgid, os.killpg) is True
    finally:
        try:
            proc.kill()
            proc.wait(timeout=1.0)
        except Exception:
            pass


def test_posix_termination_sigkill_fallback() -> None:
    signals_sent = []

    def mock_kill(pid_arg, sig_arg):
        signals_sent.append(sig_arg)
        if sig_arg == 0:
            # Drop after SIGKILL (9) is observed
            if SIGKILL in signals_sent:
                err = OSError()
                err.errno = errno.ESRCH
                raise err
        return None

    res = terminate_and_verify_posix_group(
        pgid=77777,
        timeout_s=1.0,
        poll_interval_s=0.01,
        graceful_signal=SIGTERM,
        grace_period_s=0.05,
        kill_fn=mock_kill,
    )
    assert res is True
    assert SIGTERM in signals_sent
    assert SIGKILL in signals_sent


def test_posix_termination_never_confuses_signal_with_confirmation() -> None:
    def mock_kill_hanging(pid_arg, sig_arg):
        return None  # Never raises ESRCH

    res = terminate_and_verify_posix_group(
        pgid=66666, timeout_s=0.15, poll_interval_s=0.02, kill_fn=mock_kill_hanging
    )
    assert res is False, "Must never report True if ESRCH is not observed"


def test_termination_failure_and_timeout_behavior() -> None:
    assert terminate_and_verify_posix_group(0) is False
    assert terminate_and_verify_posix_group(-10) is False
    assert terminate_and_verify_windows_job(None) is False


def test_repeated_termination_idempotency() -> None:
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(), scout_id="scout_idempotency_test")
    scraper._termination_confirmed = True
    assert scraper.terminate_browser_process_tree() is True
    assert scraper.terminate_browser_process_tree() is True


def test_live_maps_scraper_browser_lifecycle() -> None:
    from scraper.maps_scraper import MapsScraper

    async def _run() -> None:
        h_job = None
        if sys.platform == "win32":
            job_name = f"Local\\MAST_LIVE_TEST_JOB_{os.getpid()}_{int(time.time()*1000)}"
            h_job = kernel32.CreateJobObjectW(None, job_name)
            limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            kernel32.SetInformationJobObject(
                h_job, JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
            )

        try:
            config = ScraperConfig(headless=True)
            scraper = MapsScraper(config, scout_id="scout_live_test_73", job_handle=h_job)
            assert scraper.scout_id == "scout_live_test_73"
            assert scraper.is_owned is False
            assert scraper.is_launched is False
            assert scraper.is_closed is False

            async with scraper:
                assert scraper.is_owned is True
                assert scraper.is_launched is True
                assert scraper.is_closed is False
                assert scraper.browser is not None

                import pytest
                with pytest.raises(RuntimeError, match="reuse is strictly prohibited"):
                    await scraper.__aenter__()

            assert scraper.is_closed is True
            assert scraper.is_owned is False
            assert scraper.is_termination_confirmed is True

            import pytest
            with pytest.raises(RuntimeError, match="reuse is strictly prohibited"):
                await scraper.__aenter__()
        finally:
            if h_job:
                close_windows_job_handle(h_job)

    asyncio.run(_run())


def test_windows_real_playwright_driver_job_lifecycle() -> None:
    """Section 6: Real Windows integration test verifying that Python remains outside
    the Job Object, the Playwright driver process is assigned to the Job Object, Chromium
    and all child processes inherit membership, and TerminateJobObject cleanly terminates
    the browser tree down to ActiveProcesses == 0 while Python remains alive.
    """
    if sys.platform != "win32":
        return

    async def _run() -> None:
        job_name = f"Local\\MAST_REAL_TEST_JOB_{os.getpid()}_{int(time.time()*1000)}"
        h_job = kernel32.CreateJobObjectW(None, job_name)
        assert h_job, f"CreateJobObjectW failed: {kernel32.GetLastError()}"
        try:
            # 1. Configure KILL_ON_JOB_CLOSE
            limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            res = kernel32.SetInformationJobObject(
                h_job, JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
            )
            assert res, f"SetInformationJobObject failed: {kernel32.GetLastError()}"

            # 2. Verify Python itself is NOT in the Job Object
            initial_active = query_job_active_processes(h_job)
            assert initial_active == 0, f"Python must not be in Job Object, got active={initial_active}"

            # 3. Launch Playwright driver
            from playwright.async_api import async_playwright
            playwright = await async_playwright().start()
            try:
                transport = getattr(getattr(getattr(playwright, "_impl_obj", None), "_connection", None), "_transport", None)
                driver_proc = getattr(transport, "_proc", None)
                driver_pid = getattr(driver_proc, "pid", None)
                assert driver_pid and driver_pid > 0, "Failed to capture driver PID"

                # 4. Assign driver process to Job Object before Chromium launch
                assigned = assign_pid_to_windows_job(h_job, driver_pid)
                assert assigned is True, f"Failed to assign driver PID {driver_pid} to Job Object"

                # Verify driver is in the Job Object (ActiveProcesses >= 1 before Chromium)
                driver_active = query_job_active_processes(h_job)
                assert driver_active >= 1, f"Expected active >= 1 after driver assignment, got {driver_active}"

                # 5. Launch Chromium
                browser = await playwright.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
                )
                page = await browser.new_page()

                # Verify Chromium and children are in the Job Object (ActiveProcesses >= 3)
                browser_active = query_job_active_processes(h_job)
                assert browser_active >= 3, f"Expected active >= 3 after Chromium launch, got {browser_active}"

                # 6. Terminate the Job Object
                term_ok = terminate_and_verify_windows_job(h_job, timeout_s=3.0)

                # 7. Verify Python remains alive (this assertion runs!)
                assert True, "Python remained alive through TerminateJobObject"

                # 8. Poll ActiveProcesses until it reaches 0
                final_active = query_job_active_processes(h_job)
                assert final_active == 0, f"Expected 0 active processes after termination, got {final_active}"
                assert term_ok is True, "Expected terminate_and_verify_windows_job to return True"

                # 9. Verify browser is fully dead
                try:
                    await page.goto("about:blank", timeout=500)
                    assert False, "Browser page should be dead after Job Object termination"
                except Exception:
                    pass
            finally:
                try:
                    await playwright.stop()
                except Exception:
                    pass
        finally:
            kernel32.CloseHandle(h_job)

    asyncio.run(_run())


def test_driver_pid_discovery_failure_aborts_browser_launch() -> None:
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_neg_driver_pid")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_p._impl_obj._connection._transport._proc = None
    mock_p.stop = AsyncMock()

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        import pytest
        with pytest.raises(RuntimeError, match="Failed to capture Playwright driver PID"):
            asyncio.run(scraper.__aenter__())

        assert scraper.is_closed is True
        assert scraper.is_owned is False
        mock_p.stop.assert_awaited_once()


def test_driver_assignment_failure_aborts_browser_launch() -> None:
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_neg_assign_fail")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=False):
            import pytest
            with pytest.raises(RuntimeError, match="Failed to assign Playwright driver process"):
                asyncio.run(scraper.__aenter__())

            assert scraper.is_closed is True
            assert scraper.is_owned is False
            mock_p.stop.assert_awaited_once()


def test_unassigned_driver_active_count_aborts_browser_launch() -> None:
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_neg_active_count")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=True):
            with patch("service.query_job_active_processes", return_value=0):
                import pytest
                with pytest.raises(RuntimeError, match="Job Object active processes verification failed"):
                    asyncio.run(scraper.__aenter__())

                assert scraper.is_closed is True
                assert scraper.is_owned is False
                mock_p.stop.assert_awaited_once()


def test_job_termination_timeout_reported_unconfirmed() -> None:
    def mock_query_never_zero(h):
        return 2

    res = terminate_and_verify_windows_job(
        h_job=12345, timeout_s=0.1, poll_interval_s=0.02, query_fn=mock_query_never_zero
    )
    assert res is False, "Must report False when timeout expires before active processes reach 0"


def test_clean_exit_without_kill_signal_handle_cleanup() -> None:
    """Verify that during a clean context manager exit, browser.close() and playwright.stop()
    allow terminate_browser_process_tree() to confirm 0 active processes without calling
    TerminateJobObject, and verify handle cleanup.
    """
    if sys.platform != "win32":
        return

    from scraper.maps_scraper import MapsScraper

    async def _run() -> None:
        job_name = f"Local\\MAST_CLEAN_TEST_JOB_{os.getpid()}_{int(time.time()*1000)}"
        h_job = kernel32.CreateJobObjectW(None, job_name)
        assert h_job, f"CreateJobObjectW failed: {kernel32.GetLastError()}"
        try:
            limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            kernel32.SetInformationJobObject(
                h_job, JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
            )

            config = ScraperConfig(headless=True)
            scraper = MapsScraper(config, scout_id="scout_clean_exit_test")
            scraper._job_handle = h_job

            async with scraper:
                assert scraper.is_owned is True
                assert scraper.is_launched is True
                assert query_job_active_processes(h_job) >= 3

            # After clean exit from async with, browser.close() and playwright.stop() ran.
            assert scraper.is_closed is True
            assert scraper.is_owned is False
            assert scraper.is_termination_confirmed is True
            assert query_job_active_processes(h_job) == 0
        finally:
            close_windows_job_handle(h_job)

    asyncio.run(_run())


def test_windows_job_object_incomplete_coordination_rejected() -> None:
    """Point 1: Missing required coordination configuration cannot silently bypass containment."""
    # 1. job_name present, scout_id missing -> exit 78
    try:
        bootstrap_windows_job_object(
            job_name="Local\\MAST_JOB_partial_1",
            scout_id=None,
            nonce="nonce_partial_1",
            err_stream=io.StringIO(),
        )
        assert False, "Expected exit 78 on partial coordination params"
    except SystemExit as exc:
        assert exc.code == 78

    # 2. MAST_COORDINATION_REQUIRED set in env but parameters missing -> exit 78
    old_env = os.environ.get("MAST_COORDINATION_REQUIRED")
    try:
        os.environ["MAST_COORDINATION_REQUIRED"] = "1"
        try:
            bootstrap_windows_job_object(
                job_name=None,
                scout_id=None,
                nonce=None,
                err_stream=io.StringIO(),
            )
            assert False, "Expected exit 78 when MAST_COORDINATION_REQUIRED is set but params missing"
        except SystemExit as exc:
            assert exc.code == 78
    finally:
        if old_env is None:
            os.environ.pop("MAST_COORDINATION_REQUIRED", None)
        else:
            os.environ["MAST_COORDINATION_REQUIRED"] = old_env


def test_coordinated_scout_without_job_handle_rejected() -> None:
    """Point 1 & 2: A coordinated scout on Windows without a Job Object handle cannot launch."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_coordinated_no_job")
    scraper._job_handle = None

    old_main_srv = sys.modules.get("service")
    try:
        # Clear _MAST_JOB_HANDLE if present
        if old_main_srv and hasattr(old_main_srv, "_MAST_JOB_HANDLE"):
            setattr(old_main_srv, "_MAST_JOB_HANDLE", None)

        from unittest.mock import AsyncMock, patch, MagicMock
        mock_p = MagicMock()
        mock_proc = MagicMock()
        mock_proc.pid = 12345
        mock_p._impl_obj._connection._transport._proc = mock_proc
        mock_p.stop = AsyncMock()

        with patch("scraper.maps_scraper.async_playwright") as mock_ap:
            mock_ctx = MagicMock()
            mock_ctx.start = AsyncMock(return_value=mock_p)
            mock_ap.return_value = mock_ctx

            import pytest
            with pytest.raises(RuntimeError, match="Coordinated scout session on Windows requires an active Job Object handle"):
                asyncio.run(scraper.__aenter__())

            assert scraper.is_closed is True
            assert scraper.is_owned is False
            mock_p.stop.assert_awaited_once()
    finally:
        pass


def test_post_launch_containment_failure_fails_closed() -> None:
    """Point 4: Post-launch containment failure (ActiveProcesses <= 1) fails closed."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_containment_fail")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()

    mock_browser = MagicMock()
    mock_browser.close = AsyncMock()
    mock_p.chromium.launch = AsyncMock(return_value=mock_browser)

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=True):
            # Pre-launch: active=1 (driver assigned). Post-launch: active=1 (Chromium did not enter job!)
            with patch("service.query_job_active_processes", return_value=1):
                with patch("service.terminate_and_verify_windows_job", return_value=True) as mock_term:
                    import pytest
                    with pytest.raises(RuntimeError, match="Post-launch containment verification failed"):
                        asyncio.run(scraper.__aenter__())

                    assert scraper.is_closed is True
                    assert scraper.is_owned is False
                    assert scraper.is_termination_confirmed is True
                    mock_term.assert_called_once()
                    mock_p.stop.assert_awaited_once()


def test_chromium_launch_failure_cleanup() -> None:
    """Point 3: Chromium launch failure immediately terminates tree and stops Playwright."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_launch_fail")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()
    mock_p.chromium.launch = AsyncMock(side_effect=RuntimeError("Simulated Chromium binary crash"))

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=True):
            with patch("service.query_job_active_processes", return_value=1):
                with patch("service.terminate_and_verify_windows_job", return_value=True) as mock_term:
                    import pytest
                    with pytest.raises(RuntimeError, match="Chromium launch failed"):
                        asyncio.run(scraper.__aenter__())

                    assert scraper.is_closed is True
                    assert scraper.is_owned is False
                    assert scraper.is_termination_confirmed is True
                    mock_term.assert_called_once()
                    mock_p.stop.assert_awaited_once()


def test_job_handle_propagation_without_module_duplication() -> None:
    """Point 2: Ensure handle propagates cleanly and sys.modules avoids module duplication."""
    from scraper.maps_scraper import _resolve_job_handle
    global _MAST_JOB_HANDLE
    old_h = _MAST_JOB_HANDLE
    try:
        _MAST_JOB_HANDLE = 777777
        h = _resolve_job_handle()
        if sys.platform == "win32":
            assert h == 777777, f"Expected 777777, got {h}"
    finally:
        _MAST_JOB_HANDLE = old_h


def test_post_launch_containment_timeout_leaves_unconfirmed() -> None:
    """Blocker 2: Post-launch containment failure where termination times out leaves _termination_confirmed = False."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_containment_timeout")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()

    mock_browser = MagicMock()
    mock_browser.close = AsyncMock()
    mock_p.chromium.launch = AsyncMock(return_value=mock_browser)

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=True):
            with patch("service.query_job_active_processes", return_value=1):
                with patch("service.terminate_and_verify_windows_job", return_value=False) as mock_term:
                    import pytest
                    with pytest.raises(RuntimeError, match="Job Object termination unconfirmed"):
                        asyncio.run(scraper.__aenter__())

                    assert scraper.is_closed is True
                    assert scraper.is_owned is False
                    assert scraper.is_termination_confirmed is False, (
                        "When termination verification returns False/times out, "
                        "_termination_confirmed must remain False"
                    )
                    assert scraper._job_handle == 999999, "Job Object handle must remain open/accessible"
                    mock_term.assert_called_once()
                    mock_p.stop.assert_awaited_once()
                    mock_browser.close.assert_awaited_once()


def test_chromium_launch_failure_timeout_leaves_unconfirmed() -> None:
    """Blocker 2: Chromium launch failure where termination times out leaves _termination_confirmed = False."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_launch_timeout")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()
    mock_p.chromium.launch = AsyncMock(side_effect=RuntimeError("Simulated Chromium crash"))

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=True):
            with patch("service.query_job_active_processes", return_value=1):
                with patch("service.terminate_and_verify_windows_job", return_value=False) as mock_term:
                    import pytest
                    with pytest.raises(RuntimeError, match="process termination unconfirmed"):
                        asyncio.run(scraper.__aenter__())

                    assert scraper.is_closed is True
                    assert scraper.is_owned is False
                    assert scraper.is_termination_confirmed is False, (
                        "When termination verification returns False/times out during launch failure, "
                        "_termination_confirmed must remain False"
                    )
                    assert scraper._job_handle == 999999, "Job Object handle must remain open/accessible"
                    mock_term.assert_called_once()
                    mock_p.stop.assert_awaited_once()


def test_posix_chromium_launch_failure_verification_failure_leaves_unconfirmed() -> None:
    """Item 1: Chromium launch failure on POSIX when process-group verification fails leaves unconfirmed."""
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_posix_launch_fail")
    scraper._job_handle = None
    scraper.set_browser_identity(pid=12345, pgid=12345)

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()
    mock_p.chromium.launch = AsyncMock(side_effect=RuntimeError("Simulated POSIX Chromium crash"))

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("sys.platform", "linux"):
            with patch("service.terminate_and_verify_posix_group", return_value=False) as mock_posix_term:
                import pytest
                with pytest.raises(RuntimeError, match="process termination unconfirmed"):
                    asyncio.run(scraper.__aenter__())

                assert scraper.is_closed is True
                assert scraper.is_owned is False
                assert scraper.is_termination_confirmed is False
                mock_posix_term.assert_called_once_with(12345, timeout_s=3.0)
                mock_p.stop.assert_awaited_once()


def test_windows_uncoordinated_launch_failure_without_job_object() -> None:
    """Item 2: Windows uncoordinated launch failure without Job Object leaves unconfirmed on driver timeout."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True))
    scraper._job_handle = None

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 23456
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()
    mock_p.chromium.launch = AsyncMock(side_effect=RuntimeError("Uncoordinated Chromium launch crash"))

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        # Case A: Driver termination verification times out
        with patch("service.terminate_and_verify_windows_pid", return_value=False) as mock_pid_term:
            import pytest
            with pytest.raises(RuntimeError, match="process termination unconfirmed"):
                asyncio.run(scraper.__aenter__())

            assert scraper.is_closed is True
            assert scraper.is_termination_confirmed is False
            mock_pid_term.assert_called_once_with(23456, timeout_s=3.0)


def test_driver_assignment_failure_driver_still_alive_leaves_unconfirmed() -> None:
    """Item 3: Driver assignment failure where Playwright.stop() returns but driver is still alive leaves unconfirmed."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_assign_fail_alive")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 34567
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=False):
            with patch("service.terminate_and_verify_windows_pid", return_value=False) as mock_term_pid:
                import pytest
                with pytest.raises(RuntimeError, match="driver termination unconfirmed"):
                    asyncio.run(scraper.__aenter__())

                assert scraper.is_closed is True
                assert scraper.is_owned is False
                assert scraper.is_termination_confirmed is False
                assert scraper.driver_assigned_to_job is False
                mock_term_pid.assert_called_once_with(34567, timeout_s=3.0)
                mock_p.stop.assert_awaited_once()


def test_driver_assignment_failure_driver_terminated_confirmed() -> None:
    """Item 4: Driver assignment failure where OS-level termination of driver is confirmed."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_assign_fail_dead")
    scraper._job_handle = 999999

    from unittest.mock import AsyncMock, patch, MagicMock
    mock_p = MagicMock()
    mock_proc = MagicMock()
    mock_proc.pid = 45678
    mock_p._impl_obj._connection._transport._proc = mock_proc
    mock_p.stop = AsyncMock()

    with patch("scraper.maps_scraper.async_playwright") as mock_ap:
        mock_ctx = MagicMock()
        mock_ctx.start = AsyncMock(return_value=mock_p)
        mock_ap.return_value = mock_ctx

        with patch("service.assign_pid_to_windows_job", return_value=False):
            with patch("service.terminate_and_verify_windows_pid", return_value=True) as mock_term_pid:
                import pytest
                with pytest.raises(RuntimeError, match="aborting browser launch"):
                    asyncio.run(scraper.__aenter__())

                assert scraper.is_closed is True
                assert scraper.is_owned is False
                assert scraper.is_termination_confirmed is True
                assert scraper.driver_assigned_to_job is False
                mock_term_pid.assert_called_once_with(45678, timeout_s=3.0)
                mock_p.stop.assert_awaited_once()


def test_empty_job_object_with_alive_unassigned_driver_never_confirms() -> None:
    """Item 5: An empty Job Object while an unassigned driver is still alive NEVER confirms termination."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_empty_job_alive_driver")
    scraper._job_handle = 999999
    scraper._driver_pid = 56789
    scraper._driver_assigned_to_job = False  # Driver was never assigned!

    from unittest.mock import patch
    # Even if Job Object reports ActiveProcesses == 0
    with patch("service.terminate_and_verify_windows_job", return_value=True) as mock_job_term:
        with patch("service.terminate_and_verify_windows_pid", return_value=False) as mock_pid_term:
            res = scraper.terminate_browser_process_tree()
            assert res is False, "Must return False when unassigned driver process is still alive"
            assert scraper.is_termination_confirmed is False
            mock_pid_term.assert_called_once_with(56789, timeout_s=5.0)


def test_missing_process_identity_leaves_termination_unconfirmed() -> None:
    """Item 6: Missing process identity leaves termination unconfirmed (returns False)."""
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True))
    scraper._job_handle = None
    scraper._driver_pid = None
    scraper._browser_pid = None
    scraper._browser_pgid = None

    # On Windows without identity
    from unittest.mock import patch
    with patch("sys.platform", "win32"):
        res = scraper.terminate_browser_process_tree()
        assert res is False, "Windows without process identity must return False"
        assert scraper.is_termination_confirmed is False

    # On POSIX without identity
    scraper._termination_confirmed = False
    with patch("sys.platform", "linux"):
        res = scraper.terminate_browser_process_tree()
        assert res is False, "POSIX without process identity must return False"
        assert scraper.is_termination_confirmed is False


def test_normal_cleanup_requires_os_verification() -> None:
    """Item 9: Normal cleanup confirms termination only after OS verification confirms exit."""
    if sys.platform != "win32":
        return
    from scraper.maps_scraper import MapsScraper
    scraper = MapsScraper(ScraperConfig(headless=True), scout_id="scout_normal_cleanup")
    scraper._job_handle = 999999
    scraper._driver_assigned_to_job = True

    from unittest.mock import patch
    # Case A: OS verification fails (e.g. process hung)
    with patch("service.terminate_and_verify_windows_job", return_value=False):
        assert scraper.terminate_browser_process_tree() is False
        assert scraper.is_termination_confirmed is False

    # Case B: OS verification succeeds (ActiveProcesses == 0)
    with patch("service.terminate_and_verify_windows_job", return_value=True):
        assert scraper.terminate_browser_process_tree() is True
        assert scraper.is_termination_confirmed is True


def test_job_termination_confirmation_windows_success() -> None:
    """Gate 4 correction: Verified Windows Job termination emits MAST_JOB_TERMINATED."""
    global _MAST_TERMINATED_EMITTED, _MAST_JOB_HANDLE, _MAST_SCOUT_SESSION_ID, _MAST_STARTUP_NONCE
    _MAST_TERMINATED_EMITTED = False
    _MAST_SCOUT_SESSION_ID = "scout_term_win_ok"
    _MAST_STARTUP_NONCE = "nonce_term_win_ok"
    out_s = io.StringIO()

    from unittest.mock import patch
    with patch("service.terminate_and_verify_windows_job", return_value=True):
        with patch("service.close_windows_job_handle", return_value=True):
            res = confirm_and_emit_job_terminated(
                out_stream=out_s,
                h_job=999999,
                scout_id="scout_term_win_ok",
                nonce="nonce_term_win_ok"
            )
            assert res is True
            msg = json.loads(out_s.getvalue().strip())
            assert msg["type"] == "MAST_JOB_TERMINATED"
            assert msg["scoutId"] == "scout_term_win_ok"
            assert msg["nonce"] == "nonce_term_win_ok"
            assert msg["status"] == "CONFIRMED"


def test_job_termination_confirmation_windows_failure_suppresses_message() -> None:
    """Gate 4 correction: Failed Windows Job verification must NEVER emit MAST_JOB_TERMINATED."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    with patch("service.terminate_and_verify_windows_job", return_value=False):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            h_job=999999,
            scout_id="scout_term_win_fail",
            nonce="nonce_term_win_fail"
        )
        assert res is False
        assert out_s.getvalue() == "", "Must not emit anything when verification fails"


def test_job_termination_confirmation_posix_success() -> None:
    """Gate 4 correction: Verified POSIX process group termination emits MAST_JOB_TERMINATED."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper
    MapsScraper._last_browser_pgid = 54321

    with patch("sys.platform", "linux"):
        with patch("service.terminate_and_verify_posix_group", return_value=True):
            res = confirm_and_emit_job_terminated(
                out_stream=out_s,
                scout_id="scout_term_posix_ok",
                nonce="nonce_term_posix_ok"
            )
            assert res is True
            msg = json.loads(out_s.getvalue().strip())
            assert msg["type"] == "MAST_JOB_TERMINATED"
            assert msg["scoutId"] == "scout_term_posix_ok"
            assert msg["nonce"] == "nonce_term_posix_ok"
            assert msg["status"] == "CONFIRMED"
    MapsScraper._last_browser_pgid = None


def test_job_termination_confirmation_posix_failure_suppresses_message() -> None:
    """Gate 4 correction: Failed POSIX verification must NEVER emit MAST_JOB_TERMINATED."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper
    MapsScraper._last_browser_pgid = 54321

    with patch("sys.platform", "linux"):
        with patch("service.terminate_and_verify_posix_group", return_value=False):
            res = confirm_and_emit_job_terminated(
                out_stream=out_s,
                scout_id="scout_term_posix_fail",
                nonce="nonce_term_posix_fail"
            )
            assert res is False
            assert out_s.getvalue() == "", "Must not emit when POSIX verification fails"
    MapsScraper._last_browser_pgid = None


def test_job_termination_confirmation_empty_ownership_success() -> None:
    """Gate 4 correction: Coordinated session where no browser was launched verifies empty ownership."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper
    MapsScraper._last_browser_pgid = None
    MapsScraper._last_driver_pid = None
    MapsScraper._browser_spawn_attempted = False
    MapsScraper._driver_startup_failed = False
    MapsScraper._spawn_failed = False

    with patch("sys.platform", "linux"):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            scout_id="scout_no_browser",
            nonce="nonce_no_browser",
            posix_identity_confirmed=True,
        )
        assert res is True
        msg = json.loads(out_s.getvalue().strip())
        assert msg["type"] == "MAST_JOB_TERMINATED"
        assert msg["scoutId"] == "scout_no_browser"
        assert msg["nonce"] == "nonce_no_browser"


def test_missing_ownership_identity_cannot_produce_confirmation() -> None:
    """Issue 2: Missing ownership identity cannot produce successful confirmation."""
    global _MAST_TERMINATED_EMITTED, _MAST_JOB_HANDLE, _MAST_POSIX_BOOTSTRAP_CONFIRMED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper

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
    _MAST_POSIX_BOOTSTRAP_CONFIRMED = False

    with patch("sys.platform", "linux"):
        res = confirm_and_emit_job_terminated(
            out_stream=out_s,
            scout_id="scout_no_ident_posix",
            nonce="nonce_no_ident_posix",
            posix_identity_confirmed=False,
        )
        assert res is False
        assert out_s.getvalue() == ""


def test_initialized_empty_ownership_context_confirms_termination() -> None:
    """Issue 2: Genuinely initialized but empty ownership context can produce confirmation."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper

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
    _MAST_TERMINATED_EMITTED = False
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


def test_uncoordinated_legacy_does_not_falsely_report_termination() -> None:
    """Issue 2: Uncoordinated legacy session does not falsely report coordinated termination."""
    global _MAST_TERMINATED_EMITTED, _MAST_SCOUT_SESSION_ID, _MAST_STARTUP_NONCE
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    old_scout = _MAST_SCOUT_SESSION_ID
    old_nonce = _MAST_STARTUP_NONCE
    _MAST_SCOUT_SESSION_ID = None
    _MAST_STARTUP_NONCE = None

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
        _MAST_SCOUT_SESSION_ID = old_scout
        _MAST_STARTUP_NONCE = old_nonce
        if old_env_scout:
            os.environ["MAST_SCOUT_SESSION_ID"] = old_env_scout
        if old_env_nonce:
            os.environ["MAST_STARTUP_NONCE"] = old_env_nonce
        if old_env_req:
            os.environ["MAST_COORDINATION_REQUIRED"] = old_env_req


def test_windows_job_empty_pid_list_with_assigned_processes_fails_confirmation() -> None:
    """Item 1: NumberOfProcessIdsInList == 0 but NumberOfAssignedProcesses > 0 must fail verification."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
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


def test_posix_empty_ownership_failed_driver_startup_fails_confirmation() -> None:
    """Item 3: Failed driver startup must leave empty ownership unconfirmed."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper

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


def test_posix_empty_ownership_spawn_attempted_fails_confirmation() -> None:
    """Item 3: If browser spawn was attempted, empty ownership branch cannot be used."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper

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


def test_posix_invalid_identity_values_fails_confirmation() -> None:
    """Item 3: Invalid / corrupted identity values (e.g. <= 0 or non-int) must fail confirmation."""
    global _MAST_TERMINATED_EMITTED
    from unittest.mock import patch
    from scraper.maps_scraper import MapsScraper

    for invalid_val in [0, -1, -999, "invalid", False]:
        _MAST_TERMINATED_EMITTED = False
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


def test_job_termination_confirmation_idempotency() -> None:
    """Gate 4 correction: Calling confirm_and_emit_job_terminated multiple times emits at most once."""
    global _MAST_TERMINATED_EMITTED
    _MAST_TERMINATED_EMITTED = False
    out_s = io.StringIO()

    from unittest.mock import patch
    with patch("service.terminate_and_verify_windows_job", return_value=True):
        with patch("service.close_windows_job_handle", return_value=True):
            res1 = confirm_and_emit_job_terminated(
                out_stream=out_s,
                h_job=999999,
                scout_id="scout_idem",
                nonce="nonce_idem"
            )
            assert res1 is True
            first_output = out_s.getvalue()
            assert "MAST_JOB_TERMINATED" in first_output

            # Second invocation
            res2 = confirm_and_emit_job_terminated(
                out_stream=out_s,
                h_job=999999,
                scout_id="scout_idem",
                nonce="nonce_idem"
            )
            assert res2 is True
            assert out_s.getvalue() == first_output, "Must not emit duplicate message"


def run_all_process_ownership_tests() -> int:
    """Run all Phase 7.3 Gate 3 process ownership and browser identity tests."""
    tests = [
        test_windows_job_object_constants_and_types,
        test_windows_job_object_creation_and_config,
        test_windows_job_object_browser_assignment,
        test_windows_job_object_readiness_and_ack_success,
        test_windows_job_object_readiness_and_ack_rejections,
        test_windows_job_object_duplicate_rejection,
        test_browser_reuse_rejection_lifecycle,
        test_windows_job_termination_zero_active_processes,
        test_windows_job_termination_never_reports_premature_success,
        test_posix_pgid_retention_and_immutability,
        test_posix_termination_existing_process_group,
        test_posix_termination_esrch_confirmation,
        test_posix_termination_eperm_rejected,
        test_posix_termination_unexpected_os_error_rejected,
        test_posix_termination_timeout_with_group_alive,
        test_genuine_posix_subprocess_process_group_termination,
        test_posix_termination_sigkill_fallback,
        test_posix_termination_never_confuses_signal_with_confirmation,
        test_termination_failure_and_timeout_behavior,
        test_repeated_termination_idempotency,
        test_live_maps_scraper_browser_lifecycle,
        test_windows_real_playwright_driver_job_lifecycle,
        test_driver_pid_discovery_failure_aborts_browser_launch,
        test_driver_assignment_failure_aborts_browser_launch,
        test_unassigned_driver_active_count_aborts_browser_launch,
        test_job_termination_timeout_reported_unconfirmed,
        test_clean_exit_without_kill_signal_handle_cleanup,
        test_windows_job_object_incomplete_coordination_rejected,
        test_coordinated_scout_without_job_handle_rejected,
        test_post_launch_containment_failure_fails_closed,
        test_chromium_launch_failure_cleanup,
        test_job_handle_propagation_without_module_duplication,
        test_post_launch_containment_timeout_leaves_unconfirmed,
        test_chromium_launch_failure_timeout_leaves_unconfirmed,
        test_posix_chromium_launch_failure_verification_failure_leaves_unconfirmed,
        test_windows_uncoordinated_launch_failure_without_job_object,
        test_driver_assignment_failure_driver_still_alive_leaves_unconfirmed,
        test_driver_assignment_failure_driver_terminated_confirmed,
        test_empty_job_object_with_alive_unassigned_driver_never_confirms,
        test_missing_process_identity_leaves_termination_unconfirmed,
        test_normal_cleanup_requires_os_verification,
        test_job_termination_confirmation_windows_success,
        test_job_termination_confirmation_windows_failure_suppresses_message,
        test_job_termination_confirmation_posix_success,
        test_job_termination_confirmation_posix_failure_suppresses_message,
        test_job_termination_confirmation_empty_ownership_success,
        test_missing_ownership_identity_cannot_produce_confirmation,
        test_initialized_empty_ownership_context_confirms_termination,
        test_windows_job_empty_pid_list_with_assigned_processes_fails_confirmation,
        test_posix_empty_ownership_failed_driver_startup_fails_confirmation,
        test_posix_empty_ownership_spawn_attempted_fails_confirmation,
        test_posix_invalid_identity_values_fails_confirmation,
        test_uncoordinated_legacy_does_not_falsely_report_termination,
        test_job_termination_confirmation_idempotency,
    ]
    passed = 0
    failed = 0
    sys.stderr.write(f"[test-process-ownership] Running {len(tests)} focused tests...\n")
    for t in tests:
        try:
            t()
            passed += 1
            sys.stderr.write(f"  OK: {t.__name__}\n")
        except Exception as exc:
            failed += 1
            sys.stderr.write(f"  FAIL: {t.__name__} -> {exc}\n")
    sys.stderr.write(f"[test-process-ownership] Results: {passed} passed, {failed} failed out of {len(tests)}\n")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) <= 1 or sys.argv[1] != "test-process-ownership":
        bootstrap_process_ownership()

    if len(sys.argv) > 1 and sys.argv[1] == "verify":
        asyncio.run(_run_with_graceful_shutdown(_verify_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "enrich":
        asyncio.run(_run_with_graceful_shutdown(_enrich_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "enrich-daemon":
        asyncio.run(_run_with_graceful_shutdown(_enrich_daemon_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "score":
        asyncio.run(_run_with_graceful_shutdown(_score_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "qualify":
        asyncio.run(_run_with_graceful_shutdown(_qualify_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "prioritize":
        asyncio.run(_run_with_graceful_shutdown(_prioritize_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "workflow":
        asyncio.run(_run_with_graceful_shutdown(_workflow_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "crm":
        asyncio.run(_run_with_graceful_shutdown(_crm_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "analytics":
        asyncio.run(_run_with_graceful_shutdown(_analytics_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "ai_coach":
        asyncio.run(_run_with_graceful_shutdown(_ai_coach_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "mission_intelligence":
        asyncio.run(_run_with_graceful_shutdown(_mission_intelligence_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "feedback":
        asyncio.run(_run_with_graceful_shutdown(_feedback_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "street_inventory":
        asyncio.run(_run_with_graceful_shutdown(_street_inventory_cli))
    elif len(sys.argv) > 1 and sys.argv[1] == "test-process-ownership":
        exit_code = run_all_process_ownership_tests()
        sys.exit(exit_code)
    else:
        asyncio.run(_run_with_graceful_shutdown(_main_cli))

