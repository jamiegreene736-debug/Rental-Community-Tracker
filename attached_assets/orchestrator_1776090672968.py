"""
orchestrator.py — Master coordinator for the full rate scraping + pricing pipeline.

This module ties together:
1. Rate scraping from Airbnb, VRBO, Google, Property Managers
2. Median rate computation
3. Platform-specific price markup
4. Database persistence
5. Triggers availability check and Guesty sync

Called by the scheduler on its intervals.
"""

import logging
import statistics
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

from config import COMPOSITE_UNITS, DESIRED_MARKUP_PCT, PLATFORM_FEES
from database import DatabaseManager
from pricing.calculator import PricingCalculator, BuyInRate
from scrapers.airbnb_scraper import AirbnbScraper
from scrapers.vrbo_scraper import VrboScraper
from scrapers.web_scraper import GoogleSearchScraper, PropertyManagerScraper
from availability.checker import AvailabilityChecker
from guesty.client import GuestyClient

logger = logging.getLogger(__name__)


class RateOrchestrator:
    """
    Drives the full data pipeline:
    Scrape → Store → Compute Prices → Check Availability → Sync Guesty
    """

    def __init__(self, db: DatabaseManager):
        self.db = db
        self.calculator = PricingCalculator()
        self.airbnb = AirbnbScraper()
        self.vrbo = VrboScraper()
        self.google = GoogleSearchScraper()
        self.pm_scraper = PropertyManagerScraper()
        self.availability_checker = AvailabilityChecker(db)
        self.guesty = GuestyClient(db)

    # ── Full Pipeline ─────────────────────────────────────────────────────
    def run_full_pipeline(self):
        """
        Complete end-to-end run:
        1. Scrape rates for all composite units
        2. Compute prices for all platforms
        3. Check availability for all windows
        4. Sync everything to Guesty
        """
        logger.info("=" * 60)
        logger.info("VACATION RENTAL ENGINE — FULL PIPELINE RUN")
        logger.info(f"  Started: {datetime.now().isoformat()}")
        logger.info("=" * 60)

        total_records = 0
        for unit in COMPOSITE_UNITS:
            if not unit.guesty_listing_id:
                continue
            logger.info(f"\n[Pipeline] Processing: {unit.display_name}")

            # 1. Scrape rates for each source unit
            rate_records = self.scrape_all_source_units(unit)
            total_records += rate_records

            # 2. Compute markups
            self.compute_and_store_prices(unit)

        # 3. Check availability (separate from rate scraping)
        logger.info("\n[Pipeline] Running availability checks...")
        availability_results = self.availability_checker.run_full_check()

        # 4. Sync to Guesty
        logger.info("\n[Pipeline] Syncing to Guesty...")
        self.sync_all_to_guesty(availability_results)

        logger.info(f"\n[Pipeline] ✓ Complete — {total_records} rate records scraped")
        return total_records

    # ── Rate Scraping ─────────────────────────────────────────────────────
    def scrape_all_source_units(self, unit) -> int:
        """Scrape rates for all source units of a composite unit."""
        total = 0
        windows = self._priority_windows()  # Focus on near-term windows

        for i, source_unit in enumerate(unit.source_units):
            logger.info(
                f"[Rates] Scraping source unit {i}: {source_unit.search_query}"
            )
            for check_in, check_out in windows:
                count = self.scrape_single_window(source_unit, check_in, check_out)
                total += count

        return total

    def scrape_single_window(self, source_unit, check_in: date, check_out: date) -> int:
        """Scrape all platforms for one source unit and one date window."""
        records = []

        # Airbnb
        if "airbnb" in source_unit.platforms:
            try:
                r = self.airbnb.scrape_rates(
                    source_unit.location, source_unit.bedrooms, check_in, check_out
                )
                records.extend(r)
            except Exception as e:
                logger.warning(f"[Rates] Airbnb error: {e}")

        # VRBO
        if "vrbo" in source_unit.platforms:
            try:
                r = self.vrbo.scrape_rates(
                    source_unit.location, source_unit.bedrooms, check_in, check_out
                )
                records.extend(r)
            except Exception as e:
                logger.warning(f"[Rates] VRBO error: {e}")

        # Google / PM (less frequent — every other cycle)
        try:
            r = self.google.scrape_rates(
                source_unit.location, source_unit.bedrooms, check_in, check_out
            )
            records.extend(r)
        except Exception as e:
            logger.debug(f"[Rates] Google error: {e}")

        try:
            r = self.pm_scraper.scrape_rates(
                source_unit.location, source_unit.bedrooms, check_in, check_out
            )
            records.extend(r)
        except Exception as e:
            logger.debug(f"[Rates] PM scraper error: {e}")

        # Store all records
        for record in records:
            try:
                self.db.insert_rate_observation(record)
            except Exception as e:
                logger.debug(f"[Rates] DB insert error: {e}")

        if records:
            rates = [r["nightly_rate"] for r in records]
            logger.info(
                f"[Rates] {check_in}–{check_out}: {len(records)} records, "
                f"median=${statistics.median(rates):.2f}, "
                f"range=${min(rates):.2f}–${max(rates):.2f}"
            )
        else:
            logger.warning(f"[Rates] No data for {check_in}–{check_out}")

        return len(records)

    # ── Price Computation ─────────────────────────────────────────────────
    def compute_and_store_prices(self, unit) -> int:
        """
        For each 14-day window, compute the buy-in median and platform prices.
        Stores results in computed_prices table.
        """
        windows = self._priority_windows()
        computed = 0

        for check_in, check_out in windows:
            # Gather buy-in rates for ALL source units for this composite
            source_rates = []
            for source_unit in unit.source_units:
                median_rate = self.db.get_median_nightly_rate(
                    location=source_unit.location,
                    bedrooms=source_unit.bedrooms,
                    check_in=check_in,
                    check_out=check_out,
                    hours_back=72,
                )
                if median_rate is None:
                    break  # Missing rate for at least one source unit

                # Also get cleaning fee median
                rows = self.db.get_recent_rates(
                    source_unit.location, source_unit.bedrooms,
                    check_in, check_out, hours_back=72
                )
                median_cleaning = (
                    statistics.median([r["cleaning_fee"] for r in rows if r["cleaning_fee"]])
                    if rows and any(r["cleaning_fee"] for r in rows) else 0
                )

                nights = (check_out - check_in).days
                source_rates.append(BuyInRate(
                    nightly_rate=median_rate,
                    cleaning_fee=median_cleaning,
                    nights=nights,
                    source_count=len(rows),
                ))

            if len(source_rates) < len(unit.source_units):
                logger.debug(f"[Prices] Insufficient data for {check_in}–{check_out}, skipping")
                continue

            # Compute composite buy-in (sum of all source units)
            nights = (check_out - check_in).days
            composite_nightly = sum(r.nightly_rate for r in source_rates)
            composite_cleaning = sum(r.cleaning_fee for r in source_rates)
            source_count = min(r.source_count for r in source_rates)

            composite_buy_in = BuyInRate(
                nightly_rate=composite_nightly,
                cleaning_fee=composite_cleaning,
                nights=nights,
                source_count=source_count,
            )

            # Compute platform prices
            platform_prices = self.calculator.calculate_all_platforms(composite_buy_in)

            airbnb = platform_prices.get("airbnb")
            vrbo = platform_prices.get("vrbo")
            booking = platform_prices.get("booking")

            self.db.upsert_computed_price({
                "composite_unit_id": unit.guesty_listing_id,
                "check_in": str(check_in),
                "check_out": str(check_out),
                "buy_in_rate_nightly": composite_nightly,
                "buy_in_rate_total": composite_buy_in.total_cost,
                "source_count": source_count,
                "airbnb_nightly": airbnb.nightly_rate if airbnb else None,
                "airbnb_total": airbnb.total_listed if airbnb else None,
                "vrbo_nightly": vrbo.nightly_rate if vrbo else None,
                "vrbo_total": vrbo.total_listed if vrbo else None,
                "booking_nightly": booking.nightly_rate if booking else None,
                "booking_total": booking.total_listed if booking else None,
                "markup_pct": DESIRED_MARKUP_PCT,
                "notes": f"Source count: {source_count}, sources: {len(unit.source_units)} units",
            })

            # Log a nice summary
            if airbnb and logger.isEnabledFor(logging.INFO):
                logger.info(self.calculator.format_summary(composite_buy_in, platform_prices))

            computed += 1

        logger.info(f"[Prices] Computed {computed} price records for {unit.display_name}")
        return computed

    # ── Guesty Sync ───────────────────────────────────────────────────────
    def sync_all_to_guesty(self, availability_results: Dict):
        """Push all availability and pricing updates to Guesty."""
        for composite_unit_id, results in availability_results.items():
            logger.info(f"[Guesty] Syncing listing {composite_unit_id}")

            # Get computed prices from DB
            with self.db.get_conn() as conn:
                prices = conn.execute(
                    "SELECT * FROM computed_prices WHERE composite_unit_id=? "
                    "AND check_in >= ? ORDER BY check_in",
                    (composite_unit_id, str(date.today()))
                ).fetchall()
                price_list = [dict(p) for p in prices]

            # Build availability window dicts
            window_dicts = [
                {
                    "check_in": str(r.check_in),
                    "check_out": str(r.check_out),
                    "is_available": r.is_available,
                    "blackout_reason": r.reason,
                }
                for r in results
            ]

            self.guesty.sync_availability_and_pricing(
                listing_id=composite_unit_id,
                availability_windows=window_dicts,
                computed_prices=price_list,
            )

    # ── Helpers ───────────────────────────────────────────────────────────
    def _priority_windows(self) -> List[Tuple[date, date]]:
        """
        Generate 14-day windows, prioritizing:
        - Next 6 months (weekly granularity check)
        - 6–24 months ahead (bi-weekly)
        """
        windows = []
        today = date.today()

        # Near-term: every 14 days for 6 months
        cursor = today + timedelta(days=1)
        end_near = today + timedelta(days=180)
        while cursor < end_near:
            windows.append((cursor, cursor + timedelta(days=14)))
            cursor += timedelta(days=14)

        # Far-term: every 14 days for 6–24 months
        cursor = end_near
        end_far = today + timedelta(days=730)
        while cursor < end_far:
            windows.append((cursor, cursor + timedelta(days=14)))
            cursor += timedelta(days=14)

        return windows
