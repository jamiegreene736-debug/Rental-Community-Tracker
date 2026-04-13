"""
scrapers/vrbo_scraper.py — Scrapes rates and availability from VRBO/HomeAway.

Uses VRBO's internal REST API and GraphQL endpoints.
VRBO is owned by Expedia Group — the same backend powers HomeAway.
"""

import json
import logging
import re
from datetime import date
from typing import Any, Dict, List, Optional

from scrapers.base_scraper import BaseScraper

logger = logging.getLogger(__name__)

VRBO_SEARCH_URL = "https://www.vrbo.com/search/api/search/listing"
VRBO_GRAPHQL_URL = "https://www.vrbo.com/graphql"
VRBO_CALENDAR_URL = "https://www.vrbo.com/api/v1/listings/{listing_id}/availability"


class VrboScraper(BaseScraper):
    PLATFORM = "vrbo"

    def _base_headers(self) -> Dict:
        return {
            **self._get_headers(),
            "Content-Type": "application/json",
            "Referer": "https://www.vrbo.com/",
            "Origin": "https://www.vrbo.com",
            "brand": "VRBO",
            "client-info": "shopping-pwa",
        }

    # ── Search Listings ───────────────────────────────────────────────────
    def search_listings(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
    ) -> List[Dict[str, Any]]:
        logger.info(f"[VRBO] Searching: {location}, {bedrooms}BR, {check_in}–{check_out}")

        # Try primary search API
        listings = self._search_rest(location, bedrooms, check_in, check_out)
        if listings:
            return listings

        # Fallback: GraphQL
        listings = self._search_graphql(location, bedrooms, check_in, check_out)
        return listings

    def _search_rest(
        self, location: str, bedrooms: int, check_in: date, check_out: date
    ) -> List[Dict]:
        """VRBO REST search endpoint."""
        payload = {
            "q": location,
            "checkIn": str(check_in),
            "checkOut": str(check_out),
            "minBedrooms": bedrooms,
            "maxBedrooms": bedrooms,
            "adults": bedrooms * 2,
            "petsAllowed": False,
            "pageSize": 40,
            "sort": "RECOMMENDED",
            "filterByTotalPrice": True,
        }
        resp = self.post(VRBO_SEARCH_URL, json_data=payload, headers=self._base_headers())
        data = self.safe_json(resp)
        if not data:
            return []

        listings = []
        for item in data.get("listings", []):
            parsed = self._parse_listing(item, check_in, check_out)
            if parsed:
                listings.append(parsed)

        logger.info(f"[VRBO] REST search returned {len(listings)} listings")
        return listings

    def _search_graphql(
        self, location: str, bedrooms: int, check_in: date, check_out: date
    ) -> List[Dict]:
        """VRBO GraphQL search — more resilient to API changes."""
        query = """
        query SearchListings($request: SearchListingsRequest!) {
          search(searchListingsRequest: $request) {
            listings {
              listing {
                id
                name
                unitsSummary {
                  bedrooms
                }
                webURI
              }
              priceDetail {
                perNight {
                  amount
                  currencyCode
                }
                total {
                  amount
                }
              }
            }
          }
        }
        """
        variables = {
            "request": {
                "q": location,
                "checkInDate": {
                    "year": check_in.year,
                    "month": check_in.month,
                    "day": check_in.day,
                },
                "checkOutDate": {
                    "year": check_out.year,
                    "month": check_out.month,
                    "day": check_out.day,
                },
                "minBedrooms": bedrooms,
                "maxBedrooms": bedrooms,
                "resultsStartingIndex": 0,
                "resultsSize": 40,
            }
        }
        payload = {"query": query, "variables": variables}
        resp = self.post(VRBO_GRAPHQL_URL, json_data=payload, headers=self._base_headers())
        data = self.safe_json(resp)
        if not data:
            return []

        listings = []
        try:
            items = (
                data.get("data", {})
                    .get("search", {})
                    .get("listings", [])
            )
            for item in items:
                listing = item.get("listing", {})
                price = item.get("priceDetail", {})
                nightly = (
                    price.get("perNight", {}).get("amount", 0)
                    or price.get("total", {}).get("amount", 0)
                )
                if not nightly:
                    continue
                listings.append({
                    "id": listing.get("id", ""),
                    "name": listing.get("name", ""),
                    "url": f"https://www.vrbo.com{listing.get('webURI', '')}",
                    "nightly_rate": float(nightly),
                    "bedrooms": bedrooms,
                    "is_available": True,
                    "raw": item,
                })
        except Exception as e:
            logger.debug(f"[VRBO] GraphQL parse error: {e}")

        logger.info(f"[VRBO] GraphQL returned {len(listings)} listings")
        return listings

    def _parse_listing(self, item: Dict, check_in: date, check_out: date) -> Optional[Dict]:
        try:
            listing = item.get("listing", item)
            listing_id = listing.get("listingId") or listing.get("id", "")
            name = listing.get("name", listing.get("headline", ""))

            # Pricing
            price = item.get("priceDetail") or listing.get("pricing") or {}
            nightly = (
                price.get("perNight", {}).get("amount")
                or price.get("nightly", {}).get("amount")
                or listing.get("averageNightlyRate", {}).get("amount")
                or 0
            )
            if not nightly:
                return None

            return {
                "id": str(listing_id),
                "name": name,
                "url": f"https://www.vrbo.com/{listing_id}",
                "nightly_rate": float(nightly),
                "bedrooms": listing.get("unitsSummary", {}).get("bedrooms", 0),
                "is_available": True,
                "raw": item,
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
        listings = self.search_listings(location, bedrooms, check_in, check_out)
        records = []
        for listing in listings:
            # Try to get detailed pricing for cleaning fees
            detail = self._get_listing_detail(
                listing["id"], check_in, check_out
            )
            cleaning_fee = detail.get("cleaning_fee", 0) if detail else 0

            record = self.build_rate_record(
                location=location,
                bedrooms=bedrooms,
                check_in=check_in,
                check_out=check_out,
                nightly_rate=listing["nightly_rate"],
                cleaning_fee=cleaning_fee,
                is_available=listing.get("is_available", True),
                source_name=listing.get("name", ""),
                source_url=listing.get("url", ""),
                listing_id=listing.get("id", ""),
                unit_type="condo",
                raw_data=listing.get("raw"),
            )
            records.append(record)

        logger.info(f"[VRBO] Scraped {len(records)} rate records for {location}")
        return records

    # ── Listing Detail ────────────────────────────────────────────────────
    def _get_listing_detail(
        self, listing_id: str, check_in: date, check_out: date
    ) -> Optional[Dict]:
        """Fetch price breakdown from VRBO listing detail."""
        url = f"https://www.vrbo.com/api/v1/listings/{listing_id}/quote"
        payload = {
            "checkIn": str(check_in),
            "checkOut": str(check_out),
            "adults": 2,
        }
        resp = self.post(url, json_data=payload, headers=self._base_headers())
        data = self.safe_json(resp)
        if not data:
            return None

        try:
            fees = data.get("quote", {}).get("feeDetails", [])
            cleaning_fee = 0.0
            for fee in fees:
                if "clean" in fee.get("type", "").lower():
                    cleaning_fee = float(fee.get("totalAmount", {}).get("amount", 0))
            return {"cleaning_fee": cleaning_fee}
        except Exception:
            return None

    # ── Calendar Availability ─────────────────────────────────────────────
    def check_availability(
        self, listing_id: str, check_in: date, check_out: date
    ) -> bool:
        url = VRBO_CALENDAR_URL.format(listing_id=listing_id)
        params = {
            "startDate": str(check_in),
            "endDate": str(check_out),
        }
        resp = self.get(url, params=params, headers=self._base_headers())
        data = self.safe_json(resp)
        if not data:
            return False
        try:
            # VRBO returns available: true/false for the requested range
            return data.get("available", False)
        except Exception:
            return False

    def get_available_count(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
    ) -> int:
        listings = self.search_listings(location, bedrooms, check_in, check_out)
        return len([l for l in listings if l.get("is_available", True)])
