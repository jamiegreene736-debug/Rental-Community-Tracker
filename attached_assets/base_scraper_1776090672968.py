"""
scrapers/base_scraper.py — Base class for all platform scrapers.
Handles: proxy rotation, user-agent rotation, rate limiting, retries, session management.
"""

import time
import random
import logging
import json
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, List
from datetime import date, timedelta

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import (
    REQUEST_TIMEOUT_SECONDS,
    REQUEST_DELAY_MIN,
    REQUEST_DELAY_MAX,
    MAX_RETRIES,
    USE_PROXY_ROTATION,
    SCRAPER_API_KEY,
    USER_AGENTS,
)

logger = logging.getLogger(__name__)


class BaseScraper(ABC):
    """
    Abstract base scraper.

    Subclasses implement:
        scrape_rates(location, bedrooms, check_in, check_out) -> List[Dict]
        check_availability(listing_url_or_id, check_in, check_out) -> bool
        search_listings(location, bedrooms) -> List[Dict]
    """

    PLATFORM = "base"

    def __init__(self):
        self.session = self._build_session()
        self._last_request_time = 0.0

    def _build_session(self) -> requests.Session:
        session = requests.Session()
        retry_strategy = Retry(
            total=MAX_RETRIES,
            backoff_factor=2,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET", "POST"],
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    # ── Request Helpers ───────────────────────────────────────────────────
    def _get_headers(self, extra: Optional[Dict] = None) -> Dict:
        headers = {
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "application/json, text/html, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "DNT": "1",
        }
        if extra:
            headers.update(extra)
        return headers

    def _rate_limit(self):
        """Enforce minimum delay between requests."""
        elapsed = time.time() - self._last_request_time
        delay = random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX)
        if elapsed < delay:
            time.sleep(delay - elapsed)
        self._last_request_time = time.time()

    def _build_url(self, url: str) -> str:
        """Optionally route through ScraperAPI proxy."""
        if USE_PROXY_ROTATION and SCRAPER_API_KEY:
            return (
                f"http://api.scraperapi.com/?api_key={SCRAPER_API_KEY}"
                f"&url={requests.utils.quote(url, safe='')}"
                f"&render=false&country_code=us"
            )
        return url

    def get(self, url: str, params: Optional[Dict] = None,
            headers: Optional[Dict] = None, **kwargs) -> Optional[requests.Response]:
        self._rate_limit()
        try:
            resp = self.session.get(
                self._build_url(url),
                params=params,
                headers=headers or self._get_headers(),
                timeout=REQUEST_TIMEOUT_SECONDS,
                **kwargs
            )
            resp.raise_for_status()
            logger.debug(f"GET {url[:80]} → {resp.status_code}")
            return resp
        except requests.exceptions.HTTPError as e:
            logger.warning(f"HTTP error on {url[:80]}: {e}")
        except requests.exceptions.RequestException as e:
            logger.warning(f"Request failed on {url[:80]}: {e}")
        return None

    def post(self, url: str, json_data: Optional[Dict] = None,
             headers: Optional[Dict] = None, **kwargs) -> Optional[requests.Response]:
        self._rate_limit()
        try:
            resp = self.session.post(
                url,  # Don't proxy POST requests — proxy handles GET
                json=json_data,
                headers=headers or self._get_headers(),
                timeout=REQUEST_TIMEOUT_SECONDS,
                **kwargs
            )
            resp.raise_for_status()
            logger.debug(f"POST {url[:80]} → {resp.status_code}")
            return resp
        except requests.exceptions.RequestException as e:
            logger.warning(f"POST failed on {url[:80]}: {e}")
        return None

    def safe_json(self, resp: Optional[requests.Response]) -> Optional[Dict]:
        if resp is None:
            return None
        try:
            return resp.json()
        except Exception as e:
            logger.warning(f"JSON parse failed: {e}")
            return None

    # ── Date Helpers ──────────────────────────────────────────────────────
    @staticmethod
    def date_range_windows(
        months_ahead: int = 24,
        interval_days: int = 14,
        start: Optional[date] = None
    ) -> List[tuple]:
        """
        Generate (check_in, check_out) tuples for 14-day windows
        across the next N months.
        """
        if start is None:
            start = date.today()
        end_date = start + timedelta(days=months_ahead * 30)
        windows = []
        current = start
        while current < end_date:
            check_out = current + timedelta(days=interval_days)
            if check_out <= end_date:
                windows.append((current, check_out))
            current += timedelta(days=interval_days)
        return windows

    # ── Abstract Interface ────────────────────────────────────────────────
    @abstractmethod
    def scrape_rates(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
        **kwargs
    ) -> List[Dict[str, Any]]:
        """
        Scrape nightly rates for listings matching location/bedrooms for the
        given dates. Returns list of dicts with standardized fields.
        """

    @abstractmethod
    def search_listings(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
    ) -> List[Dict[str, Any]]:
        """
        Search and return available listings. Returns list of listing dicts
        with at minimum: {id, name, url, nightly_rate, is_available}.
        """

    # ── Standardized Output Format ────────────────────────────────────────
    def build_rate_record(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
        nightly_rate: float,
        cleaning_fee: float = 0.0,
        total_fees: float = 0.0,
        is_available: bool = True,
        source_name: str = "",
        source_url: str = "",
        listing_id: str = "",
        unit_type: str = "condo",
        raw_data: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        nights = (check_out - check_in).days
        return {
            "source_platform": self.PLATFORM,
            "source_name": source_name,
            "source_url": source_url,
            "listing_id": str(listing_id),
            "location": location,
            "bedrooms": bedrooms,
            "unit_type": unit_type,
            "check_in": str(check_in),
            "check_out": str(check_out),
            "nightly_rate": round(nightly_rate, 2),
            "cleaning_fee": round(cleaning_fee, 2),
            "total_fees": round(total_fees, 2),
            "total_cost": round(nightly_rate * nights + cleaning_fee + total_fees, 2),
            "currency": "USD",
            "is_available": int(is_available),
            "raw_data": json.dumps(raw_data) if raw_data else None,
        }
