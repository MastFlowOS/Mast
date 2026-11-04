import os
import sys

SCRAPER_PATH = r"mast-lead-engine\scraper\maps_scraper.py"

with open(SCRAPER_PATH, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update _PLACE_NAME_SELECTORS
old_sel = """_PLACE_NAME_SELECTORS = [
    "h1.DUwDvf",
    "h1.fontHeadlineLarge",
    "h1[data-item-id]",
]"""

new_sel = """_PLACE_NAME_SELECTORS = [
    "h1.DUwDvf",
    "h1.fontHeadlineLarge",
    "h1[data-item-id]",
    "div[role='main'] h1",
    "div[role='region'] h1",
    "h1",
    "div.DUwDvf",
]"""

assert old_sel in content, "old_sel not found!"
content = content.replace(old_sel, new_sel, 1)

# 2. Update _resolve_results_panel alternate candidates
old_resolve = """        strict = _PANEL_SELECTOR_STRICT.get(sel, True)
        is_valid, evidence = await _validate_panel_candidate(page, panel, selector=sel, strict=strict)
        if is_valid:
            log.info(f"[maps][diag] result panel validated — selector={sel!r} evidence={evidence}")
            return sel, panel

        attempted.append(f"{sel!r}: rejected ({evidence})")
        log.info(f"[maps][diag] panel candidate rejected — selector={sel!r} evidence={evidence}")"""

new_resolve = """        strict = _PANEL_SELECTOR_STRICT.get(sel, True)
        is_valid, evidence = await _validate_panel_candidate(page, panel, selector=sel, strict=strict)
        if is_valid:
            log.info(f"[maps][diag] result panel validated — selector={sel!r} evidence={evidence}")
            return sel, panel

        # If primary element was rejected (e.g. generic container matched non-feed first), check other candidates
        if hasattr(page, "query_selector_all"):
            try:
                candidates = await page.query_selector_all(sel)
                for cand in candidates[1:6]:
                    c_valid, c_evidence = await _validate_panel_candidate(page, cand, selector=sel, strict=strict)
                    if c_valid:
                        log.info(f"[maps][diag] result panel validated (alternate) — selector={sel!r} evidence={c_evidence}")
                        return sel, cand
            except Exception:
                pass

        attempted.append(f"{sel!r}: rejected ({evidence})")
        log.info(f"[maps][diag] panel candidate rejected — selector={sel!r} evidence={evidence}")"""

assert old_resolve in content, "old_resolve not found!"
content = content.replace(old_resolve, new_resolve, 1)

# 3. Update _read_panel_identity_snapshot
old_snap = """    url = getattr(page, "url", "") or ""
    place_id = _stable_place_id_from_url(url) if "/maps/place/" in url else ""
    return {
        "open": detail_open,
        "name": _norm_identity_text(raw_name),
        "raw_name": raw_name,
        "address": _norm_identity_text(raw_address),
        "raw_address": raw_address,
        "place_id": place_id,
        "url": url,
    }"""

new_snap = """    url = getattr(page, "url", "") or ""
    place_id = _stable_place_id_from_url(url) if "/maps/place/" in url else ""
    if not detail_open and "/maps/place/" in url and "/maps/search/" not in url:
        detail_open = True
    if not raw_name and "/maps/place/" in url and "/maps/search/" not in url:
        slug_name = _place_name_from_href(url)
        if slug_name:
            raw_name = slug_name
    return {
        "open": detail_open,
        "name": _norm_identity_text(raw_name),
        "raw_name": raw_name,
        "address": _norm_identity_text(raw_address),
        "raw_address": raw_address,
        "place_id": place_id,
        "url": url,
    }"""

assert old_snap in content, "old_snap not found!"
content = content.replace(old_snap, new_snap, 1)

# 4. Update _is_target_closed_or_crashed_error
old_crashed = """            "connection closed",
            "session closed",
            "execution context was destroyed",
        )"""

new_crashed = """            "connection closed",
            "session closed",
        )"""

assert old_crashed in content, "old_crashed not found!"
content = content.replace(old_crashed, new_crashed, 1)

# 5. Update _execute_return_failure_recovery
old_rec = """    if not _is_page_alive(page):
        ctx_closed = False
        if hasattr(page, "context"):
            try:
                ctx = page.context
                if hasattr(ctx, "is_closed") and ctx.is_closed():
                    ctx_closed = True
            except Exception:
                pass
        if ctx_closed:
            _emit("browser_context_closed", context_label)
        else:
            _emit("browser_page_crashed", context_label)
        raise DiscoveryFailure(
            DiscoveryFailureReason.SCRAPER_ERROR,
            f"browser page or context closed/crashed during return_to_results in {context_label}",
        )"""

new_rec = """    if not _is_page_alive(page):
        page_really_closed = False
        if hasattr(page, "is_closed"):
            try:
                page_really_closed = page.is_closed()
            except Exception:
                page_really_closed = True
        ctx_closed = False
        if hasattr(page, "context"):
            try:
                ctx = page.context
                if hasattr(ctx, "is_closed") and ctx.is_closed():
                    ctx_closed = True
            except Exception:
                pass
        if page_really_closed or ctx_closed:
            if ctx_closed:
                _emit("browser_context_closed", context_label)
            else:
                _emit("browser_page_crashed", context_label)
            raise DiscoveryFailure(
                DiscoveryFailureReason.SCRAPER_ERROR,
                f"browser page or context closed/crashed during return_to_results in {context_label}",
            )
        # Target not closed at browser level — attempt navigation recovery if available
        if search_url and not search_nav_recovery_used:
            try:
                search_nav_recovery_used = True
                setattr(page, "_mast_target_crashed", False)
                rec_timeout = config.maps_timeout_ms if config else 10000
                await page.goto(search_url, wait_until="domcontentloaded", timeout=rec_timeout)
                panel_sel, _ = await _resolve_results_panel(page, config=config if config else ScraperConfig())
                if await _is_feed_ready(page, panel_sel):
                    _emit("return_recovery_succeeded", context_label)
                    log.info(f"[maps][return-recovery] search-navigation recovered alive target for {full_query!r}")
                    return True, search_nav_recovery_used, panel_sel
            except Exception as rec_err:
                log.warning(f"[maps][return-recovery] recovery attempt failed: {rec_err}")
        _emit("browser_page_crashed", context_label)
        raise DiscoveryFailure(
            DiscoveryFailureReason.SCRAPER_ERROR,
            f"browser page or context closed/crashed during return_to_results in {context_label}",
        )"""

assert old_rec in content, "old_rec not found!"
content = content.replace(old_rec, new_rec, 1)

# 6. Update _emit_progress
old_emit = """        def _emit_progress(event: str, item_id: str | None = None, **kwargs: Any) -> None:
            if on_progress is None:
                return
            try:
                if kwargs:
                    try:
                        on_progress("discovery", event, item_id, **kwargs)
                    except TypeError:
                        on_progress("discovery", event, item_id)
                else:
                    on_progress("discovery", event, item_id)
            except Exception:
                log.debug("on_progress observer raised — ignored", exc_info=True)"""

new_emit = """        def _emit_progress(stage_or_event: str, event_or_item: str | None = None, item_id: str | None = None, **kwargs: Any) -> None:
            if on_progress is None:
                return
            try:
                if item_id is not None or stage_or_event == "discovery":
                    stg = stage_or_event
                    ev = event_or_item or ""
                    it = item_id
                else:
                    stg = "discovery"
                    ev = stage_or_event
                    it = event_or_item
                if kwargs:
                    try:
                        on_progress(stg, ev, it, **kwargs)
                    except TypeError:
                        on_progress(stg, ev, it)
                else:
                    on_progress(stg, ev, it)
            except Exception:
                log.debug("on_progress observer raised — ignored", exc_info=True)"""

assert old_emit in content, "old_emit not found!"
content = content.replace(old_emit, new_emit, 1)

# 7. Update Initial Load Diagnostics
old_diag = """                try:
                    _landed_url = page.url
                    _title = await page.title()
                    _body_len = len(await page.evaluate("() => document.body?.innerText?.length || 0"))
                    log.info(
                        f"[maps][diag] search page loaded — "
                        f"requested={search_url!r} landed_on={_landed_url!r} "
                        f"title={_title!r} body_chars={_body_len}"
                    )
                except Exception as _diag_exc:
                    log.debug(f"[maps][diag] page-load diagnostic failed: {_diag_exc}")"""

new_diag = """                try:
                    _landed_url = getattr(page, "url", "") or ""
                    _title = await asyncio.wait_for(page.title(), timeout=2.0)
                    _body_len = len(await asyncio.wait_for(page.evaluate("() => document.body?.innerText?.length || 0"), timeout=2.0))
                    log.info(
                        f"[maps][diag] search page loaded — "
                        f"requested={search_url!r} landed_on={_landed_url!r} "
                        f"title={_title!r} body_chars={_body_len}"
                    )
                except Exception as _diag_exc:
                    log.debug(f"[maps][diag] page-load diagnostic failed: {_diag_exc}")"""

assert old_diag in content, "old_diag not found!"
content = content.replace(old_diag, new_diag, 1)

# 8. Update _run_card_panel_and_extract
old_extract = """                                if not found_panel:
                                    curr_url = getattr(page, "url", "") or ""
                                    log.info(f"[maps][diag] place_panel_wait failed: url={curr_url!r} card_href={card_href!r}")
                                    if should_stop is not None and should_stop():
                                        self._profiler.incr("place_panel_wait_aborted")
                                        return "panel_timeout", None, "panel_wait_timeout"
                                    self._profiler.incr("place_panel_wait_timeout")
                                    if "/maps/place/" not in curr_url and not is_minimal_stub:
                                        return "mismatch", None, "waiting_for_detail_panel"

                            if not is_minimal_stub:
                                try:
                                    probe_h1 = await page.query_selector(_PLACE_NAME_SELECTORS[0])
                                    if probe_h1 is panel and panel is not None:
                                        is_minimal_stub = True
                                except Exception:
                                    pass

                            identity_wait_ms = (
                                self.config.place_timeout_ms
                                if found_panel
                                else min(self.config.place_timeout_ms, 250)
                            )"""

new_extract = """                                if not found_panel:
                                    curr_url = getattr(page, "url", "") or ""
                                    if "/maps/place/" in curr_url and "/maps/search/" not in curr_url:
                                        found_panel = True
                                        self._profiler.incr("place_panel_wait_resolved")
                                    else:
                                        log.info(f"[maps][diag] place_panel_wait failed: url={curr_url!r} card_href={card_href!r}")
                                        if should_stop is not None and should_stop():
                                            self._profiler.incr("place_panel_wait_aborted")
                                            return "panel_timeout", None, "panel_wait_timeout"
                                        self._profiler.incr("place_panel_wait_timeout")
                                        if "/maps/place/" not in curr_url and not is_minimal_stub:
                                            return "mismatch", None, "waiting_for_detail_panel"

                            if not is_minimal_stub:
                                try:
                                    probe_h1 = await page.query_selector(_PLACE_NAME_SELECTORS[0])
                                    if probe_h1 is panel and panel is not None:
                                        is_minimal_stub = True
                                except Exception:
                                    pass

                            curr_url = getattr(page, "url", "") or ""
                            is_on_place_url = "/maps/place/" in curr_url and "/maps/search/" not in curr_url
                            identity_wait_ms = (
                                self.config.place_timeout_ms
                                if found_panel or is_on_place_url
                                else min(self.config.place_timeout_ms, 250)
                            )"""

assert old_extract in content, "old_extract not found!"
content = content.replace(old_extract, new_extract, 1)

with open(SCRAPER_PATH, "w", encoding="utf-8", newline="") as f:
    f.write(content)

print("maps_scraper.py patched successfully!")
