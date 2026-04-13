"""
database.py — SQLite persistence layer for rates, availability records, and audit trail.
Uses SQLAlchemy Core for portability (swap to Postgres by changing DATABASE_URL).
"""

import sqlite3
import json
import logging
from datetime import datetime, date
from typing import Optional, List, Dict, Any
from contextlib import contextmanager

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SCHEMA
# ─────────────────────────────────────────────────────────────────────────────
SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Raw rate observations scraped from all sources
CREATE TABLE IF NOT EXISTS rate_observations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    scraped_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_platform     TEXT NOT NULL,         -- 'airbnb', 'vrbo', 'booking', 'property_manager', 'google'
    source_name         TEXT,                  -- Listing title or PM company name
    source_url          TEXT,
    listing_id          TEXT,                  -- Platform listing ID if available
    location            TEXT NOT NULL,
    bedrooms            INTEGER NOT NULL,
    unit_type           TEXT,
    check_in            DATE NOT NULL,
    check_out           DATE NOT NULL,
    nightly_rate        REAL NOT NULL,         -- Per-night BASE rate (before fees)
    cleaning_fee        REAL DEFAULT 0,
    total_fees          REAL DEFAULT 0,        -- Sum of all fees beyond nightly rate
    total_cost          REAL NOT NULL,         -- Full stay cost
    currency            TEXT DEFAULT 'USD',
    is_available        INTEGER NOT NULL DEFAULT 1,  -- 0=blocked, 1=available
    raw_data            TEXT                   -- JSON of full scraped payload
);

-- Computed prices per platform for each composite listing
CREATE TABLE IF NOT EXISTS computed_prices (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    composite_unit_id       TEXT NOT NULL,     -- Maps to CompositeUnit.guesty_listing_id
    check_in                DATE NOT NULL,
    check_out               DATE NOT NULL,
    buy_in_rate_nightly     REAL NOT NULL,     -- Median buy-in rate per night
    buy_in_rate_total       REAL NOT NULL,     -- Total for stay
    source_count            INTEGER NOT NULL,  -- How many rate observations used
    -- Platform-specific listed prices
    airbnb_nightly          REAL,
    airbnb_total            REAL,
    vrbo_nightly            REAL,
    vrbo_total              REAL,
    booking_nightly         REAL,
    booking_total           REAL,
    markup_pct              REAL DEFAULT 0.20,
    notes                   TEXT
);

-- Availability windows for composite units
CREATE TABLE IF NOT EXISTS availability_windows (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    composite_unit_id           TEXT NOT NULL,
    check_in                    DATE NOT NULL,
    check_out                   DATE NOT NULL,
    -- Per source unit counts
    source_unit_0_available     INTEGER DEFAULT 0,
    source_unit_1_available     INTEGER DEFAULT 0,
    source_unit_2_available     INTEGER DEFAULT 0,  -- For 3-unit composites
    min_available_across_sources INTEGER NOT NULL,   -- The bottleneck
    is_available                INTEGER NOT NULL,    -- 1=open, 0=blackout
    confidence_score            REAL,               -- 0.0–1.0
    blackout_reason             TEXT,
    UNIQUE(composite_unit_id, check_in, check_out)
);

-- Guesty sync log
CREATE TABLE IF NOT EXISTS guesty_sync_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    listing_id          TEXT NOT NULL,
    action              TEXT NOT NULL,    -- 'price_update', 'blackout', 'open', 'full_sync'
    check_in            DATE,
    check_out           DATE,
    payload             TEXT,            -- JSON of what was sent
    response_status     INTEGER,         -- HTTP status code
    success             INTEGER NOT NULL DEFAULT 0,
    error_message       TEXT
);

-- Scheduler run log
CREATE TABLE IF NOT EXISTS scheduler_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    job_name    TEXT NOT NULL,
    duration_s  REAL,
    success     INTEGER NOT NULL DEFAULT 0,
    records     INTEGER DEFAULT 0,
    error       TEXT
);

-- Index for fast date-range queries
CREATE INDEX IF NOT EXISTS idx_rate_obs_checkin    ON rate_observations(check_in, location, bedrooms);
CREATE INDEX IF NOT EXISTS idx_avail_composite     ON availability_windows(composite_unit_id, check_in);
CREATE INDEX IF NOT EXISTS idx_computed_composite  ON computed_prices(composite_unit_id, check_in);
"""

# ─────────────────────────────────────────────────────────────────────────────
# DATABASE MANAGER
# ─────────────────────────────────────────────────────────────────────────────
class DatabaseManager:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialize()

    def _initialize(self):
        with self.get_conn() as conn:
            conn.executescript(SCHEMA_SQL)
            conn.commit()
        logger.info(f"Database initialized at {self.db_path}")

    @contextmanager
    def get_conn(self):
        conn = sqlite3.connect(self.db_path, detect_types=sqlite3.PARSE_DECLTYPES)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    # ── Rate Observations ─────────────────────────────────────────────────
    def insert_rate_observation(self, data: Dict[str, Any]) -> int:
        sql = """
            INSERT INTO rate_observations
                (source_platform, source_name, source_url, listing_id, location,
                 bedrooms, unit_type, check_in, check_out,
                 nightly_rate, cleaning_fee, total_fees, total_cost,
                 currency, is_available, raw_data)
            VALUES
                (:source_platform, :source_name, :source_url, :listing_id, :location,
                 :bedrooms, :unit_type, :check_in, :check_out,
                 :nightly_rate, :cleaning_fee, :total_fees, :total_cost,
                 :currency, :is_available, :raw_data)
        """
        with self.get_conn() as conn:
            cur = conn.execute(sql, data)
            conn.commit()
            return cur.lastrowid

    def get_recent_rates(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
        hours_back: int = 48
    ) -> List[Dict]:
        sql = """
            SELECT * FROM rate_observations
            WHERE location LIKE :loc
              AND bedrooms = :beds
              AND check_in = :checkin
              AND check_out = :checkout
              AND is_available = 1
              AND scraped_at >= datetime('now', :hours)
            ORDER BY scraped_at DESC
        """
        with self.get_conn() as conn:
            rows = conn.execute(sql, {
                "loc": f"%{location}%",
                "beds": bedrooms,
                "checkin": str(check_in),
                "checkout": str(check_out),
                "hours": f"-{hours_back} hours"
            }).fetchall()
        return [dict(r) for r in rows]

    def get_median_nightly_rate(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
        hours_back: int = 48
    ) -> Optional[float]:
        """Returns median nightly rate across all sources for a given window."""
        rows = self.get_recent_rates(location, bedrooms, check_in, check_out, hours_back)
        if not rows:
            return None
        rates = sorted(r["nightly_rate"] for r in rows)
        n = len(rates)
        mid = n // 2
        if n % 2 == 0:
            return (rates[mid - 1] + rates[mid]) / 2.0
        return rates[mid]

    # ── Computed Prices ───────────────────────────────────────────────────
    def upsert_computed_price(self, data: Dict[str, Any]):
        sql = """
            INSERT INTO computed_prices
                (composite_unit_id, check_in, check_out,
                 buy_in_rate_nightly, buy_in_rate_total, source_count,
                 airbnb_nightly, airbnb_total,
                 vrbo_nightly, vrbo_total,
                 booking_nightly, booking_total, markup_pct, notes)
            VALUES
                (:composite_unit_id, :check_in, :check_out,
                 :buy_in_rate_nightly, :buy_in_rate_total, :source_count,
                 :airbnb_nightly, :airbnb_total,
                 :vrbo_nightly, :vrbo_total,
                 :booking_nightly, :booking_total, :markup_pct, :notes)
        """
        with self.get_conn() as conn:
            conn.execute(sql, data)
            conn.commit()

    # ── Availability Windows ──────────────────────────────────────────────
    def upsert_availability_window(self, data: Dict[str, Any]):
        sql = """
            INSERT INTO availability_windows
                (composite_unit_id, check_in, check_out,
                 source_unit_0_available, source_unit_1_available, source_unit_2_available,
                 min_available_across_sources, is_available,
                 confidence_score, blackout_reason, checked_at)
            VALUES
                (:composite_unit_id, :check_in, :check_out,
                 :source_unit_0_available, :source_unit_1_available, :source_unit_2_available,
                 :min_available_across_sources, :is_available,
                 :confidence_score, :blackout_reason, :checked_at)
            ON CONFLICT(composite_unit_id, check_in, check_out) DO UPDATE SET
                source_unit_0_available     = excluded.source_unit_0_available,
                source_unit_1_available     = excluded.source_unit_1_available,
                source_unit_2_available     = excluded.source_unit_2_available,
                min_available_across_sources= excluded.min_available_across_sources,
                is_available                = excluded.is_available,
                confidence_score            = excluded.confidence_score,
                blackout_reason             = excluded.blackout_reason,
                checked_at                  = excluded.checked_at
        """
        with self.get_conn() as conn:
            conn.execute(sql, data)
            conn.commit()

    def get_availability_windows(
        self,
        composite_unit_id: str,
        from_date: Optional[date] = None
    ) -> List[Dict]:
        sql = """
            SELECT * FROM availability_windows
            WHERE composite_unit_id = :uid
        """
        params: Dict = {"uid": composite_unit_id}
        if from_date:
            sql += " AND check_in >= :from_date"
            params["from_date"] = str(from_date)
        sql += " ORDER BY check_in"
        with self.get_conn() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    # ── Guesty Sync Log ───────────────────────────────────────────────────
    def log_guesty_sync(self, data: Dict[str, Any]):
        sql = """
            INSERT INTO guesty_sync_log
                (listing_id, action, check_in, check_out,
                 payload, response_status, success, error_message)
            VALUES
                (:listing_id, :action, :check_in, :check_out,
                 :payload, :response_status, :success, :error_message)
        """
        with self.get_conn() as conn:
            conn.execute(sql, data)
            conn.commit()

    # ── Scheduler Runs ────────────────────────────────────────────────────
    def log_scheduler_run(self, job_name: str, duration_s: float,
                           success: bool, records: int = 0, error: str = ""):
        with self.get_conn() as conn:
            conn.execute(
                "INSERT INTO scheduler_runs (job_name, duration_s, success, records, error) "
                "VALUES (?, ?, ?, ?, ?)",
                (job_name, duration_s, int(success), records, error)
            )
            conn.commit()

    # ── Analytics Helpers ─────────────────────────────────────────────────
    def get_rate_summary(self, composite_unit_id: str) -> Dict:
        """Returns a summary dict for dashboard/logging."""
        with self.get_conn() as conn:
            total_obs = conn.execute(
                "SELECT COUNT(*) as cnt FROM rate_observations"
            ).fetchone()["cnt"]
            blackout_count = conn.execute(
                "SELECT COUNT(*) as cnt FROM availability_windows "
                "WHERE composite_unit_id=? AND is_available=0", (composite_unit_id,)
            ).fetchone()["cnt"]
            open_count = conn.execute(
                "SELECT COUNT(*) as cnt FROM availability_windows "
                "WHERE composite_unit_id=? AND is_available=1", (composite_unit_id,)
            ).fetchone()["cnt"]
        return {
            "total_rate_observations": total_obs,
            "blackout_windows": blackout_count,
            "open_windows": open_count,
        }
