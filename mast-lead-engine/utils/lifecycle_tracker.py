import os
import sys
import logging
from playwright.async_api import Browser, BrowserContext, Page

log = logging.getLogger("lifecycle")

active_browsers = 0
active_contexts = 0
active_pages = 0

def get_memory_usage() -> float:
    """Get resident set size (RSS) memory of the current process in MB."""
    try:
        # Try resource module (Linux/macOS)
        import resource
        # ru_maxrss is in kilobytes on Linux, bytes on macOS
        rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform == 'darwin':
            return rss_kb / 1024.0 / 1024.0
        else:
            return rss_kb / 1024.0
    except ImportError:
        pass

    try:
        # Try psutil if available
        import psutil
        process = psutil.Process(os.getpid())
        return process.memory_info().rss / 1024.0 / 1024.0
    except Exception:
        pass

    # Fallback on Windows
    try:
        if sys.platform == 'win32':
            import ctypes
            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", ctypes.c_ulong),
                    ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]
            GetProcessMemoryInfo = ctypes.windll.psapi.GetProcessMemoryInfo
            GetCurrentProcess = ctypes.windll.kernel32.GetCurrentProcess
            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
            if GetProcessMemoryInfo(GetCurrentProcess(), ctypes.byref(counters), ctypes.sizeof(counters)):
                return counters.WorkingSetSize / 1024.0 / 1024.0
    except Exception:
        pass
    return 0.0

def track_browser_created():
    global active_browsers
    active_browsers += 1
    log.info(f"[LIFECYCLE] Browser created. Active counts -> browsers: {active_browsers}, contexts: {active_contexts}, pages: {active_pages}. Memory: {get_memory_usage():.2f} MB")

def track_browser_closed():
    global active_browsers
    active_browsers = max(0, active_browsers - 1)
    log.info(f"[LIFECYCLE] Browser closed. Active counts -> browsers: {active_browsers}, contexts: {active_contexts}, pages: {active_pages}. Memory: {get_memory_usage():.2f} MB")

def track_context_created():
    global active_contexts
    active_contexts += 1
    log.info(f"[LIFECYCLE] Context created. Active counts -> browsers: {active_browsers}, contexts: {active_contexts}, pages: {active_pages}. Memory: {get_memory_usage():.2f} MB")

def track_context_closed():
    global active_contexts
    active_contexts = max(0, active_contexts - 1)
    log.info(f"[LIFECYCLE] Context closed. Active counts -> browsers: {active_browsers}, contexts: {active_contexts}, pages: {active_pages}. Memory: {get_memory_usage():.2f} MB")

def track_page_created():
    global active_pages
    active_pages += 1
    log.info(f"[LIFECYCLE] Page created. Active counts -> browsers: {active_browsers}, contexts: {active_contexts}, pages: {active_pages}. Memory: {get_memory_usage():.2f} MB")

def track_page_closed():
    global active_pages
    active_pages = max(0, active_pages - 1)
    log.info(f"[LIFECYCLE] Page closed. Active counts -> browsers: {active_browsers}, contexts: {active_contexts}, pages: {active_pages}. Memory: {get_memory_usage():.2f} MB")

def log_milestone(name: str):
    log.info(f"[LIFECYCLE] Milestone: {name}. Active counts -> browsers: {active_browsers}, contexts: {active_contexts}, pages: {active_pages}. Memory: {get_memory_usage():.2f} MB")

_patched = False

def install_tracker():
    global _patched
    if _patched:
        return
    _patched = True

    # 1. Patch Browser.close
    orig_browser_close = Browser.close
    async def patched_browser_close(self, *args, **kwargs):
        log.info("[LIFECYCLE-TRACE] Browser.close() called")
        try:
            await orig_browser_close(self, *args, **kwargs)
        finally:
            track_browser_closed()
    Browser.close = patched_browser_close

    # 2. Patch BrowserContext.close
    orig_context_close = BrowserContext.close
    async def patched_context_close(self, *args, **kwargs):
        log.info("[LIFECYCLE-TRACE] BrowserContext.close() called")
        try:
            await orig_context_close(self, *args, **kwargs)
        finally:
            track_context_closed()
    BrowserContext.close = patched_context_close

    # 3. Patch Page.close
    orig_page_close = Page.close
    async def patched_page_close(self, *args, **kwargs):
        log.info("[LIFECYCLE-TRACE] Page.close() called")
        try:
            await orig_page_close(self, *args, **kwargs)
        finally:
            track_page_closed()
    Page.close = patched_page_close

    # 4. Patch new_context on Browser
    orig_new_context = Browser.new_context
    async def patched_new_context(self, *args, **kwargs):
        log.info("[LIFECYCLE-TRACE] browser.new_context() called")
        ctx = await orig_new_context(self, *args, **kwargs)
        track_context_created()
        return ctx
    Browser.new_context = patched_new_context

    # 5. Patch new_page on BrowserContext
    orig_new_page_ctx = BrowserContext.new_page
    async def patched_new_page_ctx(self, *args, **kwargs):
        log.info("[LIFECYCLE-TRACE] context.new_page() called")
        pg = await orig_new_page_ctx(self, *args, **kwargs)
        track_page_created()
        return pg
    BrowserContext.new_page = patched_new_page_ctx

    log.info("[LIFECYCLE] Patches installed successfully")
