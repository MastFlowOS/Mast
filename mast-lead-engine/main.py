"""
Mast Lead Engine — Main Entry Point (Part 1 CLI).

Usage:
    python main.py --query "specialty coffee shops" --city "Austin" --country US
    python main.py --query "yoga studios" --city "London" --country GB --max 100
    python main.py --query "nail salons" --city "Miami" --country US --fast --no-ig

Environment variables:
    MAST_PROXIES               Comma-separated proxy URLs
    MAPS_RPM                   Maps request rate (default: 20/min)
    IG_RPM                     Instagram rate (default: 10/min)
    MAX_IG_FOLLOWERS           Filter cap (default: 5000)
    MAX_REVIEWS                Filter cap (default: 500)
    LEADS_DB_PATH              SQLite database path (default: data/leads.db)
    LOG_LEVEL                  DEBUG | INFO | WARNING (default: INFO)
    MAST_SHEETS_SPREADSHEET_ID Google Sheets output target
    MAST_SHEETS_CREDENTIALS_FILE Service account JSON path
    SCRAPER_FAST               Set any value to enable fast mode
    SKIP_IG                    Set to skip Instagram enrichment
    SKIP_SITE_CRAWL            Set to skip website crawl
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from service import run_query
from storage.dedup import LeadStore
from utils.output import CSVWriter, JSONLWriter, SheetsWriter
from utils.runtime import get_logger

log = get_logger("main")


# ──────────────────────────────────────────────────────────────────────────────
# CLI argument parsing
# ──────────────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Mast Lead Engine — Production-grade lead scraper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # Required
    p.add_argument("--query", required=True,
                   help='Search query, e.g. "specialty coffee shops"')
    p.add_argument("--city", required=True,
                   help='Target city, e.g. "Austin"')

    # Optional
    p.add_argument("--country", default="US",
                   help="ISO country code (default: US)")
    p.add_argument("--max", type=int, default=60, dest="max_results",
                   help="Max leads to collect (default: 60)")
    p.add_argument("--niche", default="",
                   help="Niche tag for catalog tagging")
    p.add_argument("--region", default="",
                   help="Region tag for analytics")

    # Filters
    p.add_argument("--max-ig-followers", type=int, default=5000,
                   help="Max Instagram followers (default: 5000)")
    p.add_argument("--max-reviews", type=int, default=500,
                   help="Max Google reviews (default: 500)")
    p.add_argument("--min-score", type=int, default=0,
                   help="Minimum lead score to output (default: 0)")

    # Modes
    p.add_argument("--fast", action="store_true",
                   help="Fast mode: fewer sub-pages, shorter delays")
    p.add_argument("--no-ig", action="store_true",
                   help="Skip Instagram enrichment")
    p.add_argument("--no-site", action="store_true",
                   help="Skip website crawl")
    p.add_argument("--no-history", action="store_true",
                   help="Ignore previous dedup history (fresh run)")
    p.add_argument("--headful", action="store_true",
                   help="Run browser in headful mode (visible window)")
    p.add_argument("--no-viability-gate", action="store_true",
                   help="Include leads that fail the outreach viability gate")

    # Output
    p.add_argument("--output-dir", default="output",
                   help="Directory for CSV/JSONL output (default: output/)")
    p.add_argument("--output-format", choices=["csv", "jsonl", "both", "sheets"],
                   default="csv", help="Output format (default: csv)")
    p.add_argument("--label", default="leads",
                   help="Label prefix for output filenames")
    p.add_argument("--db", default="data/leads.db",
                   help="SQLite dedup database path (default: data/leads.db)")

    # Rate limiting
    p.add_argument("--maps-rpm", type=float, default=None,
                   help="Google Maps requests/min (overrides env)")
    p.add_argument("--ig-rpm", type=float, default=None,
                   help="Instagram requests/min (overrides env)")

    return p


# ──────────────────────────────────────────────────────────────────────────────
# Main async runner
# ──────────────────────────────────────────────────────────────────────────────

async def run(args: argparse.Namespace) -> int:
    """
    Main async runner. Returns exit code.

    Engine 2.0 cutover: this no longer drives MapsScraper /
    EnrichmentPipeline itself — that was a second, inline copy of the
    exact orchestration service.run_query() already implements (now via
    EngineCoordinator / build_seven_stage_pipeline / ExecutionDriver).
    main.py's own job stays what it always was: CLI parsing, dedup-db
    reset, and file output — so it now simply calls run_query() as a
    library and hands each lead dict to the configured writers, per the
    "treat service.py as the composition root, don't duplicate
    orchestration" migration rule.
    """
    if args.no_history:
        log.warning("[main] --no-history: wiping dedup database")
        store = LeadStore(args.db)
        store.reset()
        store.close()

    log.info(
        f"[main] starting — query={args.query!r} city={args.city!r} "
        f"country={args.country} max={args.max_results}"
    )

    # Output writers
    writers: list = []
    fmt = args.output_format

    if fmt in ("csv", "both"):
        writers.append(CSVWriter(output_dir=args.output_dir, label=args.label))
    if fmt in ("jsonl", "both"):
        writers.append(JSONLWriter(output_dir=args.output_dir, label=args.label))
    if fmt == "sheets":
        writers.append(SheetsWriter())

    delivered = 0

    try:
        async for lead_dict in run_query(
            query=args.query,
            city=args.city,
            country=args.country,
            niche=args.niche,
            region=args.region,
            max_results=args.max_results,
            max_ig_followers=args.max_ig_followers,
            max_reviews=args.max_reviews,
            min_score=args.min_score,
            fast=args.fast,
            skip_ig=args.no_ig,
            skip_site_crawl=args.no_site,
            require_viability=not args.no_viability_gate,
            db_path=args.db,
        ):
            for writer in writers:
                writer.write(lead_dict)

            delivered += 1

            # Inline progress report
            print(
                f"  [{delivered:3d}] "
                f"{lead_dict.get('name') or '<unnamed>':<30} | "
                f"score={lead_dict.get('score') or 0:3.0f} ({lead_dict.get('tier') or '-':<6}) | "
                f"ig={lead_dict.get('ig_followers') or '-':<7} | "
                f"email={'✓' if lead_dict.get('email') else '✗'}  "
                f"phone={'✓' if lead_dict.get('phone') else '✗'}"
            )

    except KeyboardInterrupt:
        log.warning("[main] interrupted by user")
    except Exception as exc:
        log.error(f"[main] fatal: {exc}", exc_info=True)
        return 1
    finally:
        for writer in writers:
            try:
                writer.close()
            except Exception:
                pass

    # Summary
    print("\n" + "─" * 60)
    print(f"  Delivered to output : {delivered}")
    if writers and hasattr(writers[0], "path"):
        print(f"  Output file         : {writers[0].path}")
    print("─" * 60)

    return 0


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # Validate
    if args.max_results < 1:
        print("Error: --max must be >= 1", file=sys.stderr)
        sys.exit(1)

    # Engine 2.0: GoogleMapsProvider (providers/google_maps_provider.py)
    # constructs its own ScraperConfig(headless=True) internally and does
    # not accept maps_rpm/ig_rpm overrides — these three CLI flags have no
    # effect on the production (run_query) path anymore. Flagged here
    # rather than silently dropped; see the migration review for why.
    if args.headful or args.maps_rpm or args.ig_rpm:
        print(
            "Warning: --headful/--maps-rpm/--ig-rpm have no effect under "
            "Engine 2.0 (GoogleMapsProvider owns its own scraper config); "
            "ignoring.",
            file=sys.stderr,
        )

    exit_code = asyncio.run(run(args))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
