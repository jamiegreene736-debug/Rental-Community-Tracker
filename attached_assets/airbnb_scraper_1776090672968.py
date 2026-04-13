"""
scrapers/airbnb_scraper.py — Scrapes rates and availability from Airbnb.

Uses Airbnb's internal v3 GraphQL API (the same one their web app uses).
No official API key needed — uses the public API key embedded in their web app.
Falls back to HTML parsing if the API is blocked.
"""

import json
import logging
import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

from scrapers.base_scraper import BaseScraper
from config import AIRBNB_API_KEY

logger = logging.getLogger(__name__)

# Airbnb internal API endpoints
AIRBNB_SEARCH_URL = "https://www.airbnb.com/api/v3/StaysSearch"
AIRBNB_LISTING_URL = "https://www.airbnb.com/api/v3/StaysPdpSections"
AIRBNB_CALENDAR_URL = "https://www.airbnb.com/api/v2/calendar_months"

# GraphQL hash for StaysSearch (changes periodically with Airbnb deploys)
# This is the operation hash for the stays search query
STAYS_SEARCH_DOC_ID = "13085786166122475"


class AirbnbScraper(BaseScraper):
    PLATFORM = "airbnb"

    def _base_headers(self) -> Dict:
        return {
            **self._get_headers(),
            "X-Airbnb-API-Key": AIRBNB_API_KEY,
            "Content-Type": "application/json",
            "X-Airbnb-GraphQL-Platform": "web",
            "X-Airbnb-GraphQL-Platform-Client": "minimalist-niobe",
            "X-Airbnb-Supports-Airlock-V2": "true",
            "Referer": "https://www.airbnb.com/",
            "Origin": "https://www.airbnb.com",
        }

    # ── Search Listings ───────────────────────────────────────────────────
    def search_listings(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
    ) -> List[Dict[str, Any]]:
        """
        Search Airbnb for listings matching location/bedrooms/dates.
        Returns list of standardized listing dicts.
        """
        logger.info(f"[Airbnb] Searching: {location}, {bedrooms}BR, {check_in}–{check_out}")

        params = self._build_search_params(location, bedrooms, check_in, check_out)

        # Try v3 API first
        listings = self._search_v3_api(params)
        if listings:
            return listings

        # Fallback: v2 explore API
        listings = self._search_v2_api(location, bedrooms, check_in, check_out)
        if listings:
            return listings

        logger.warning(f"[Airbnb] No results for {location} {bedrooms}BR {check_in}")
        return []

    def _build_search_params(
        self, location: str, bedrooms: int, check_in: date, check_out: date
    ) -> Dict:
        return {
            "operationName": "StaysSearch",
            "locale": "en-US",
            "currency": "USD",
            "variables": json.dumps({
                "isInitialLoad": True,
                "hasLoggedIn": False,
                "cdnCacheSafe": False,
                "request": {
                    "metaData": {"amenityIds": []},
                    "rawParams": [
                        {"filterName": "query",          "filterValues": [location]},
                        {"filterName": "checkin",        "filterValues": [str(check_in)]},
                        {"filterName": "checkout",       "filterValues": [str(check_out)]},
                        {"filterName": "minBedrooms",    "filterValues": [str(bedrooms)]},
                        {"filterName": "maxBedrooms",    "filterValues": [str(bedrooms)]},
                        {"filterName": "propertyTypeId", "filterValues": ["1", "2"]},  # apt + condo
                        {"filterName": "itemsPerGrid",   "filterValues": ["40"]},
                        {"filterName": "adults",         "filterValues": [str(bedrooms * 2)]},
                        {"filterName": "channel",        "filterValues": ["EXPLORE"]},
                        {"filterName": "datePickerType", "filterValues": ["calendar"]},
                        {"filterName": "source",         "filterValues": ["structured_search_input_header"]},
                        {"filterName": "searchType",     "filterValues": ["filter_change"]},
                    ],
                },
            }),
            "extensions": json.dumps({
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": STAYS_SEARCH_DOC_ID,
                }
            }),
        }

    def _search_v3_api(self, params: Dict) -> List[Dict]:
        resp = self.get(
            AIRBNB_SEARCH_URL,
            params=params,
            headers=self._base_headers()
        )
        data = self.safe_json(resp)
        if not data:
            return []

        listings = []
        try:
            results = (
                data.get("data", {})
                    .get("presentation", {})
                    .get("explore", {})
                    .get("sections", {})
                    .get("sections", [])
            )
            for section in results:
                items = section.get("items", [])
                for item in items:
                    listing_data = item.get("listing", {})
                    if not listing_data:
                        continue
                    parsed = self._parse_listing(listing_data)
                    if parsed:
                        listings.append(parsed)
        except Exception as e:
            logger.debug(f"[Airbnb] v3 parse error: {e}")

        logger.info(f"[Airbnb] v3 API returned {len(listings)} listings")
        return listings

    def _search_v2_api(
        self, location: str, bedrooms: int, check_in: date, check_out: date
    ) -> List[Dict]:
        """Fallback: v2 ExploreSearch endpoint."""
        url = "https://www.airbnb.com/api/v2/explore_tabs"
        params = {
            "version": "1.8.3",
            "_format": "for_explore_search_web",
            "auto_ib": False,
            "currency": "USD",
            "query": location,
            "checkin": str(check_in),
            "checkout": str(check_out),
            "min_bedrooms": bedrooms,
            "max_bedrooms": bedrooms,
            "items_per_grid": 40,
            "key": AIRBNB_API_KEY,
            "locale": "en-US",
        }
        resp = self.get(url, params=params, headers=self._base_headers())
        data = self.safe_json(resp)
        if not data:
            return []

        listings = []
        try:
            tabs = data.get("explore_tabs", [{}])
            for tab in tabs:
                for section in tab.get("sections", []):
                    for item in section.get("listings", []):
                        parsed = self._parse_listing_v2(item.get("listing", {}))
                        if parsed:
                            listings.append(parsed)
        except Exception as e:
            logger.debug(f"[Airbnb] v2 parse error: {e}")

        logger.info(f"[Airbnb] v2 API returned {len(listings)} listings")
        return listings

    # ── Parse Listing Data ────────────────────────────────────────────────
    def _parse_listing(self, listing: Dict) -> Optional[Dict]:
        try:
            listing_id = listing.get("id", "")
            name = listing.get("name", "")
            bedrooms = (
                listing.get("roomAndBed", {}).get("bedroomsText", "")
                or listing.get("bedrooms", 0)
            )

            # Extract pricing
            price_data = listing.get("structuredDisplayPrice", {})
            primary = price_data.get("primaryLine", {})
            nightly = self._extract_price(primary.get("price", "0"))
            if not nightly:
                nightly = self._extract_price(
                    listing.get("price", {}).get("amount", "0")
                )

            if not nightly:
                return None

            return {
                "id": listing_id,
                "name": name,
                "url": f"https://www.airbnb.com/rooms/{listing_id}",
                "nightly_rate": nightly,
                "bedrooms": bedrooms,
                "is_available": True,
                "raw": listing,
            }
        except Exception:
            return None

    def _parse_listing_v2(self, listing: Dict) -> Optional[Dict]:
        try:
            listing_id = listing.get("id", "")
            name = listing.get("name", "")
            price_data = listing.get("pricing_quote", {})
            nightly = price_data.get("rate", {}).get("amount", 0)
            if not nightly:
                return None
            return {
                "id": listing_id,
                "name": name,
                "url": f"https://www.airbnb.com/rooms/{listing_id}",
                "nightly_rate": float(nightly),
                "bedrooms": listing.get("bedrooms", 0),
                "is_available": True,
                "raw": listing,
            }
        except Exception:
            return None

    # ── Scrape Rates ──────────────────────────────────────────────────────
    def scrape_rates(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
        **kwargs
    ) -> List[Dict[str, Any]]:
        """
        Return standardized rate records for all found listings.
        """
        listings = self.search_listings(location, bedrooms, check_in, check_out)
        records = []
        for listing in listings:
            # For each listing, optionally fetch detailed pricing (incl. cleaning fee)
            detail = self._get_listing_detail(
                listing["id"], check_in, check_out
            )
            cleaning_fee = detail.get("cleaning_fee", 0) if detail else 0
            total_fees = detail.get("total_fees", 0) if detail else 0

            record = self.build_rate_record(
                location=location,
                bedrooms=bedrooms,
                check_in=check_in,
                check_out=check_out,
                nightly_rate=listing["nightly_rate"],
                cleaning_fee=cleaning_fee,
                total_fees=total_fees,
                is_available=listing.get("is_available", True),
                source_name=listing.get("name", ""),
                source_url=listing.get("url", ""),
                listing_id=listing.get("id", ""),
                unit_type="condo",
                raw_data=listing.get("raw"),
            )
            records.append(record)

        logger.info(f"[Airbnb] Scraped {len(records)} rate records for {location}")
        return records

    # ── Listing Detail (Cleaning Fees, Full Price Breakdown) ──────────────
    def _get_listing_detail(
        self, listing_id: str, check_in: date, check_out: date
    ) -> Optional[Dict]:
        """Fetch the full price breakdown for a specific listing and dates."""
        url = "https://www.airbnb.com/api/v2/pdp_listing_booking_details"
        params = {
            "key": AIRBNB_API_KEY,
            "_format": "for_web_with_date",
            "listing_id": listing_id,
            "check_in": str(check_in),
            "check_out": str(check_out),
            "number_of_adults": 2,
            "currency": "USD",
            "locale": "en-US",
        }
        resp = self.get(url, params=params, headers=self._base_headers())
        data = self.safe_json(resp)
        if not data:
            return None

        try:
            price_details = (
                data.get("pdp_listing_booking_details", [{}])[0]
                    .get("price", {})
                    .get("price_items", [])
            )
            cleaning_fee = 0.0
            total_fees = 0.0
            for item in price_details:
                if "clean" in item.get("type", "").lower():
                    cleaning_fee = float(item.get("total", {}).get("amount", 0))
                elif item.get("type") not in ("ACCOMMODATION", "DISCOUNT"):
                    total_fees += float(item.get("total", {}).get("amount", 0))
            return {"cleaning_fee": cleaning_fee, "total_fees": total_fees}
        except Exception as e:
            logger.debug(f"[Airbnb] Detail parse error for {listing_id}: {e}")
            return None

    # ── Calendar Availability ─────────────────────────────────────────────
    def check_availability(
        self, listing_id: str, check_in: date, check_out: date
    ) -> bool:
        """Check if a specific Airbnb listing is available for given dates."""
        url = AIRBNB_CALENDAR_URL
        params = {
            "key": AIRBNB_API_KEY,
            "currency": "USD",
            "locale": "en-US",
            "listing_id": listing_id,
            "month": check_in.month,
            "year": check_in.year,
            "count": 2,  # Fetch 2 months
        }
        resp = self.get(url, params=params, headers=self._base_headers())
        data = self.safe_json(resp)
        if not data:
            return False

        try:
            calendar_months = data.get("calendar_months", [])
            blocked_dates = set()
            for month in calendar_months:
                for day in month.get("days", []):
                    if not day.get("available", True):
                        blocked_dates.add(day.get("date", ""))

            # Check if any date in range is blocked
            current = check_in
            while current < check_out:
                if str(current) in blocked_dates:
                    return False
                current = date(current.year, current.month, current.day + 1
                               if current.day < 28 else 1)
            return True
        except Exception as e:
            logger.debug(f"[Airbnb] Calendar parse error: {e}")
            return False

    def get_available_count(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
    ) -> int:
        """Return how many listings are available for the given window."""
        listings = self.search_listings(location, bedrooms, check_in, check_out)
        return len([l for l in listings if l.get("is_available", True)])

    # ── Utility ───────────────────────────────────────────────────────────
    @staticmethod
    def _extract_price(price_str: Any) -> Optional[float]:
        if isinstance(price_str, (int, float)):
            return float(price_str)
        if isinstance(price_str, str):
            cleaned = re.sub(r"[^\d.]", "", price_str)
            try:
                return float(cleaned)
            except ValueError:
                pass
        return None
