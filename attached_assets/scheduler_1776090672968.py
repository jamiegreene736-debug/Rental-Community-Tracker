"""
scheduler.py — Job scheduler for the vacation rental engine.

Jobs:
  - rate_refresh        Every 6h  — scrape latest buy-in rates
  - availability_check  Every 4h  — check 14-day availability windows
  - guesty_sync         Every 1h  — push changes to Guesty
  - full_pipeline       Every 24h — complete deep scan

Uses APScheduler (BackgroundScheduler for daemon mode, BlockingScheduler for main thread).
"""

import logging
import time
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.executors.pool import ThreadPoolExecutor

from config import (
    RATE_REFRESH_INTERVAL_HOURS,
    AVAILABILITY_REFRESH_INTERVAL_HOURS,
    GUESTY_SYNC_INTERVAL_HOURS,
    FULL_REFRESH_INTERVAL_HOURS,
    DATABASE_PATH,
)
from database import DatabaseManager
from orchestrator import RateOrchestrator
from availability.checker import AvailabilityChecker
from guesty.client import GuestyClient

logger = logging.getLogger(__name__)


def _timed_job(db: DatabaseManager, job_name: str, fn, *args, **kwargs):
    """Wraps a job function with timing and error logging."""
    start = time.time()
    success = False
    records = 0
    error = ""
    try:
        logger.info(f"[Scheduler] ▶ Starting: {job_name}")
        result = fn(*args, **kwargs)
        if isinstance(result, int):
            records = result
        success = True
        logger.info(f"[Scheduler] ✓ Completed: {job_name} in {time.time()-start:.1f}s")
    except Exception as e:
        error = str(e)
        logger.error(f"[Scheduler] ✗ Failed: {job_name} — {e}", exc_info=True)
    finally:
        db.log_scheduler_run(job_name, time.time() - start, success, records, error)


def build_scheduler(db: DatabaseManager, blocking: bool = True):
    """
    Build and configure the APScheduler instance.

    blocking=True  → use BlockingScheduler (runs as main thread, good for Replit)
    blocking=False → use BackgroundScheduler (runs as daemon, good for embedding)
    """
    orchestrator = RateOrchestrator(db)
    availability_checker = AvailabilityChecker(db)
    guesty = GuestyClient(db)

    jobstores = {
        "default": SQLAlchemyJobStore(url=f"sqlite:///{DATABASE_PATH}")
    }
    executors = {
        "default": ThreadPoolExecutor(max_workers=2)
    }
    job_defaults = {
        "coalesce": True,      # If missed, run once instead of N times
        "max_instances": 1,    # Never run the same job twice simultaneously
        "misfire_grace_time": 300,  # 5 minutes grace for misfires
    }

    SchedulerClass = BlockingScheduler if blocking else BackgroundScheduler
    scheduler = SchedulerClass(
        jobstores=jobstores,
        executors=executors,
        job_defaults=job_defaults,
    )

    # ── Job 1: Full Pipeline (deepest scan — runs once per day) ──────────
    scheduler.add_job(
        func=lambda: _timed_job(db, "full_pipeline", orchestrator.run_full_pipeline),
        trigger="interval",
        hours=FULL_REFRESH_INTERVAL_HOURS,
        id="full_pipeline",
        name="Full Rate + Availability + Guesty Sync",
        replace_existing=True,
        next_run_time=datetime.now(),  # Run immediately on startup
    )

    # ── Job 2: Rate Refresh Only (frequent, lightweight) ─────────────────
    def rate_refresh_job():
        from config import COMPOSITE_UNITS
        from scrapers.base_scraper import BaseScraper
        total = 0
        today = __import__("datetime").date.today()
        from datetime import timedelta
        # Refresh only next 30 days on quick runs
        windows = [(today + timedelta(days=i*14), today + timedelta(days=i*14+14))
                   for i in range(1, 5)]
        for unit in COMPOSITE_UNITS:
            for source_unit in unit.source_units:
                for ci, co in windows:
                    total += orchestrator.scrape_single_window(source_unit, ci, co)
        return total

    scheduler.add_job(
        func=lambda: _timed_job(db, "rate_refresh", rate_refresh_job),
        trigger="interval",
        hours=RATE_REFRESH_INTERVAL_HOURS,
        id="rate_refresh",
        name="Rate Scraping Refresh",
        replace_existing=True,
    )

    # ── Job 3: Availability Check ─────────────────────────────────────────
    scheduler.add_job(
        func=lambda: _timed_job(
            db, "availability_check",
            availability_checker.run_full_check
        ),
        trigger="interval",
        hours=AVAILABILITY_REFRESH_INTERVAL_HOURS,
        id="availability_check",
        name="Availability Window Check",
        replace_existing=True,
    )

    # ── Job 4: Guesty Sync Only ───────────────────────────────────────────
    def guesty_sync_job():
        from config import COMPOSITE_UNITS
        from datetime import date
        for unit in COMPOSITE_UNITS:
            if not unit.guesty_listing_id:
                continue
            windows = db.get_availability_windows(
                unit.guesty_listing_id, from_date=date.today()
            )
            with db.get_conn() as conn:
                prices = conn.execute(
                    "SELECT * FROM computed_prices WHERE composite_unit_id=? "
                    "AND check_in >= ?",
                    (unit.guesty_listing_id, str(date.today()))
                ).fetchall()
            guesty.sync_availability_and_pricing(
                listing_id=unit.guesty_listing_id,
                availability_windows=windows,
                computed_prices=[dict(p) for p in prices],
            )

    scheduler.add_job(
        func=lambda: _timed_job(db, "guesty_sync", guesty_sync_job),
        trigger="interval",
        hours=GUESTY_SYNC_INTERVAL_HOURS,
        id="guesty_sync",
        name="Guesty Calendar & Price Sync",
        replace_existing=True,
    )

    logger.info("[Scheduler] All jobs registered:")
    for job in scheduler.get_jobs():
        logger.info(f"  • {job.name} — every {job.trigger}")

    return scheduler
