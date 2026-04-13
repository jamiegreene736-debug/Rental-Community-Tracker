"""
main.py — Entry point for the Vacation Rental Rate & Availability Engine.

Usage:
    python main.py                  # Start the full scheduler (default)
    python main.py --once           # Run full pipeline once and exit
    python main.py --rates-only     # Scrape rates only, no Guesty sync
    python main.py --availability   # Run availability check only
    python main.py --sync           # Run Guesty sync only
    python main.py --status         # Print system status and exit
    python main.py --test-guesty    # Test Guesty API connection
"""

import argparse
import logging
import sys
import os
from datetime import date
from dotenv import load_dotenv

load_dotenv()

# ── Logging setup (before any local imports) ──────────────────────────────────
from config import LOG_LEVEL, LOG_FILE

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)-30s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

from config import COMPOSITE_UNITS, DATABASE_PATH, GUESTY_CLIENT_ID
from database import DatabaseManager
from orchestrator import RateOrchestrator
from availability.checker import AvailabilityChecker
from guesty.client import GuestyClient
from scheduler import build_scheduler


def check_config():
    """Warn about missing configuration."""
    warnings = []
    if not GUESTY_CLIENT_ID:
        warnings.append("GUESTY_CLIENT_ID not set — Guesty sync will fail")
    if not os.getenv("GUESTY_CLIENT_SECRET"):
        warnings.append("GUESTY_CLIENT_SECRET not set — Guesty sync will fail")
    if not any(u.guesty_listing_id for u in COMPOSITE_UNITS):
        warnings.append("No GUESTY_LISTING_ID_* env vars set — configure listing IDs")
    if not os.getenv("SERP_API_KEY") and not os.getenv("SCRAPER_API_KEY"):
        warnings.append("No SERP_API_KEY or SCRAPER_API_KEY — Google search/scraping may be limited")
    for w in warnings:
        logger.warning(f"[Config] ⚠ {w}")
    return len(warnings) == 0


def print_status(db: DatabaseManager):
    """Print a summary of the current system state."""
    print("\n" + "=" * 60)
    print("  VACATION RENTAL ENGINE — SYSTEM STATUS")
    print("=" * 60)

    with db.get_conn() as conn:
        obs_count = conn.execute("SELECT COUNT(*) FROM rate_observations").fetchone()[0]
        price_count = conn.execute("SELECT COUNT(*) FROM computed_prices").fetchone()[0]
        avail_count = conn.execute("SELECT COUNT(*) FROM availability_windows").fetchone()[0]
        blackout_count = conn.execute(
            "SELECT COUNT(*) FROM availability_windows WHERE is_available=0"
        ).fetchone()[0]
        last_run = conn.execute(
            "SELECT ran_at, job_name, success FROM scheduler_runs ORDER BY ran_at DESC LIMIT 1"
        ).fetchone()

    print(f"  Rate observations:  {obs_count:,}")
    print(f"  Computed prices:    {price_count:,}")
    print(f"  Availability windows: {avail_count:,} ({blackout_count:,} blacked out)")

    if last_run:
        print(f"  Last job:           {last_run[1]} at {last_run[0]} "
              f"({'✓' if last_run[2] else '✗'})")

    print(f"\n  Composite units configured: {len(COMPOSITE_UNITS)}")
    for unit in COMPOSITE_UNITS:
        summary = db.get_rate_summary(unit.guesty_listing_id or "")
        print(f"    • {unit.display_name}")
        print(f"      Guesty ID: {unit.guesty_listing_id or '[NOT SET]'}")
        print(f"      Open windows: {summary.get('open_windows', 0)}, "
              f"Blacked out: {summary.get('blackout_windows', 0)}")

    print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(
        description="Vacation Rental Rate & Availability Engine"
    )
    parser.add_argument("--once", action="store_true", help="Run full pipeline once")
    parser.add_argument("--rates-only", action="store_true", help="Scrape rates only")
    parser.add_argument("--availability", action="store_true", help="Availability check only")
    parser.add_argument("--sync", action="store_true", help="Guesty sync only")
    parser.add_argument("--status", action="store_true", help="Print status and exit")
    parser.add_argument("--test-guesty", action="store_true", help="Test Guesty connection")
    args = parser.parse_args()

    # ── Initialize DB ──────────────────────────────────────────────────────
    db = DatabaseManager(DATABASE_PATH)

    # ── Config validation ──────────────────────────────────────────────────
    check_config()

    # ── CLI Commands ───────────────────────────────────────────────────────
    if args.status:
        print_status(db)
        return

    if args.test_guesty:
        guesty = GuestyClient(db)
        ok = guesty.health_check()
        if ok:
            print("✓ Guesty connection OK")
            listings = guesty.list_all_listings()
            print(f"  Found {len(listings)} listings in Guesty account:")
            for l in listings[:10]:
                print(f"    • {l.get('_id', 'unknown')} — {l.get('title', 'No title')}")
        else:
            print("✗ Guesty connection FAILED — check credentials")
        return

    orchestrator = RateOrchestrator(db)

    if args.rates_only:
        logger.info("[Main] Running rate scraping only")
        for unit in COMPOSITE_UNITS:
            orchestrator.scrape_all_source_units(unit)
        return

    if args.availability:
        logger.info("[Main] Running availability check only")
        checker = AvailabilityChecker(db)
        checker.run_full_check()
        return

    if args.sync:
        logger.info("[Main] Running Guesty sync only")
        guesty = GuestyClient(db)
        checker = AvailabilityChecker(db)
        results = {}
        for unit in COMPOSITE_UNITS:
            if unit.guesty_listing_id:
                windows = db.get_availability_windows(
                    unit.guesty_listing_id, from_date=date.today()
                )
                with db.get_conn() as conn:
                    prices = [
                        dict(p) for p in conn.execute(
                            "SELECT * FROM computed_prices WHERE composite_unit_id=? AND check_in >= ?",
                            (unit.guesty_listing_id, str(date.today()))
                        ).fetchall()
                    ]
                guesty.sync_availability_and_pricing(
                    unit.guesty_listing_id, windows, prices
                )
        return

    if args.once:
        logger.info("[Main] Running full pipeline once")
        orchestrator.run_full_pipeline()
        print_status(db)
        return

    # ── Default: Start the scheduler ──────────────────────────────────────
    logger.info("[Main] Starting the vacation rental engine scheduler")
    logger.info(f"[Main] Database: {DATABASE_PATH}")
    logger.info(f"[Main] Composite units: {len(COMPOSITE_UNITS)}")
    for unit in COMPOSITE_UNITS:
        logger.info(f"  • {unit.display_name} (Guesty: {unit.guesty_listing_id or 'NOT SET'})")

    scheduler = build_scheduler(db, blocking=True)
    try:
        logger.info("[Main] Scheduler running. Press Ctrl+C to stop.")
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("[Main] Shutting down gracefully...")
        scheduler.shutdown()
        logger.info("[Main] Stopped.")


if __name__ == "__main__":
    main()
