"""
guesty/client.py — Guesty Open API v1 client.

Handles:
- OAuth2 token management (auto-refresh)
- Listing price updates (per date range, per channel)
- Calendar blocking / unblocking
- Full listing sync

Guesty API docs: https://open-api.guesty.com/
"""

import json
import logging
import time
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET, GUESTY_BASE_URL
from database import DatabaseManager

logger = logging.getLogger(__name__)

# Guesty API endpoints
GUESTY_AUTH_URL = "https://open-api.guesty.com/oauth2/token"
GUESTY_LISTINGS_URL = f"{GUESTY_BASE_URL}/listings"
GUESTY_CALENDAR_URL = f"{GUESTY_BASE_URL}/availability-pricing/api/v3/listings"
GUESTY_PRICING_URL = f"{GUESTY_BASE_URL}/pricing-rules"


class GuestyClient:
    def __init__(self, db: DatabaseManager):
        self.db = db
        self._token: Optional[str] = None
        self._token_expiry: float = 0
        self._session = self._build_session()

    def _build_session(self) -> requests.Session:
        session = requests.Session()
        retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503])
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("https://", adapter)
        return session

    # ── Auth ──────────────────────────────────────────────────────────────
    def _get_token(self) -> str:
        """Get or refresh OAuth2 access token."""
        if self._token and time.time() < self._token_expiry - 60:
            return self._token

        logger.info("[Guesty] Refreshing access token")
        resp = self._session.post(
            GUESTY_AUTH_URL,
            data={
                "grant_type": "client_credentials",
                "scope": "open-api",
                "client_id": GUESTY_CLIENT_ID,
                "client_secret": GUESTY_CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._token_expiry = time.time() + data.get("expires_in", 3600)
        logger.info("[Guesty] Token refreshed successfully")
        return self._token

    def _headers(self) -> Dict:
        return {
            "Authorization": f"Bearer {self._get_token()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _request(
        self,
        method: str,
        url: str,
        json_data: Optional[Dict] = None,
        params: Optional[Dict] = None,
    ) -> Optional[Dict]:
        try:
            resp = self._session.request(
                method=method,
                url=url,
                json=json_data,
                params=params,
                headers=self._headers(),
                timeout=30,
            )
            resp.raise_for_status()
            return resp.json() if resp.content else {}
        except requests.exceptions.HTTPError as e:
            logger.error(f"[Guesty] HTTP error: {e} — {getattr(e.response, 'text', '')[:200]}")
            return None
        except Exception as e:
            logger.error(f"[Guesty] Request error: {e}")
            return None

    # ── Calendar Operations ───────────────────────────────────────────────
    def block_dates(
        self,
        listing_id: str,
        check_in: date,
        check_out: date,
        reason: str = "Insufficient inventory",
    ) -> bool:
        """
        Block dates on a Guesty listing calendar (marks as unavailable).
        Uses the Guesty Calendar API to set status='unavailable'.
        """
        logger.info(f"[Guesty] BLOCKING {listing_id}: {check_in} → {check_out}")

        url = f"{GUESTY_CALENDAR_URL}/{listing_id}/calendar"
        payload = {
            "startDate": str(check_in),
            "endDate": str(check_out),  # Guesty end date is exclusive
            "status": "unavailable",
            "note": reason[:500],
        }

        result = self._request("PUT", url, json_data=payload)
        success = result is not None

        self.db.log_guesty_sync({
            "listing_id": listing_id,
            "action": "blackout",
            "check_in": str(check_in),
            "check_out": str(check_out),
            "payload": json.dumps(payload),
            "response_status": 200 if success else 0,
            "success": int(success),
            "error_message": "" if success else "Failed to block dates",
        })

        if success:
            logger.info(f"[Guesty] ✓ Blocked {check_in}→{check_out}")
        else:
            logger.error(f"[Guesty] ✗ Failed to block {check_in}→{check_out}")

        return success

    def open_dates(
        self,
        listing_id: str,
        check_in: date,
        check_out: date,
    ) -> bool:
        """Open (unblock) dates on a Guesty listing calendar."""
        logger.info(f"[Guesty] OPENING {listing_id}: {check_in} → {check_out}")

        url = f"{GUESTY_CALENDAR_URL}/{listing_id}/calendar"
        payload = {
            "startDate": str(check_in),
            "endDate": str(check_out),
            "status": "available",
        }

        result = self._request("PUT", url, json_data=payload)
        success = result is not None

        self.db.log_guesty_sync({
            "listing_id": listing_id,
            "action": "open",
            "check_in": str(check_in),
            "check_out": str(check_out),
            "payload": json.dumps(payload),
            "response_status": 200 if success else 0,
            "success": int(success),
            "error_message": "" if success else "Failed to open dates",
        })

        return success

    def get_calendar(
        self,
        listing_id: str,
        from_date: date,
        to_date: date,
    ) -> Optional[Dict]:
        """Fetch the current calendar state from Guesty."""
        url = f"{GUESTY_CALENDAR_URL}/{listing_id}/calendar"
        params = {
            "startDate": str(from_date),
            "endDate": str(to_date),
        }
        return self._request("GET", url, params=params)

    # ── Pricing Operations ────────────────────────────────────────────────
    def update_pricing(
        self,
        listing_id: str,
        check_in: date,
        check_out: date,
        nightly_rate: float,
        min_nights: int = 7,
        channel: Optional[str] = None,  # None = all channels
    ) -> bool:
        """
        Update the nightly price for a specific date range on a Guesty listing.
        Uses Guesty's calendar pricing API.
        """
        logger.info(
            f"[Guesty] PRICING {listing_id}: ${nightly_rate:.2f}/night "
            f"{check_in}→{check_out}"
        )

        url = f"{GUESTY_CALENDAR_URL}/{listing_id}/calendar"
        payload = {
            "startDate": str(check_in),
            "endDate": str(check_out),
            "status": "available",
            "price": round(nightly_rate, 2),
            "minNights": min_nights,
        }

        result = self._request("PUT", url, json_data=payload)
        success = result is not None

        self.db.log_guesty_sync({
            "listing_id": listing_id,
            "action": "price_update",
            "check_in": str(check_in),
            "check_out": str(check_out),
            "payload": json.dumps(payload),
            "response_status": 200 if success else 0,
            "success": int(success),
            "error_message": "" if success else "Failed to update price",
        })

        return success

    def update_pricing_bulk(
        self,
        listing_id: str,
        price_windows: List[Dict],  # [{check_in, check_out, nightly_rate}, ...]
    ) -> Dict[str, int]:
        """Bulk price updates — returns {success: N, failed: N}."""
        success_count = 0
        fail_count = 0

        for window in price_windows:
            ok = self.update_pricing(
                listing_id=listing_id,
                check_in=window["check_in"],
                check_out=window["check_out"],
                nightly_rate=window["nightly_rate"],
            )
            if ok:
                success_count += 1
            else:
                fail_count += 1
            # Small delay to avoid rate limiting
            time.sleep(0.5)

        return {"success": success_count, "failed": fail_count}

    # ── Full Sync ─────────────────────────────────────────────────────────
    def sync_availability_and_pricing(
        self,
        listing_id: str,
        availability_windows: List[Dict],
        computed_prices: Optional[List[Dict]] = None,
    ) -> Dict[str, Any]:
        """
        Master sync function — applies both blackouts and pricing to Guesty.

        availability_windows: from database availability_windows table
        computed_prices: from database computed_prices table (optional)
        """
        logger.info(f"[Guesty] Starting full sync for listing {listing_id}")

        blocked = 0
        opened = 0
        priced = 0
        errors = 0

        # Index prices by check_in for quick lookup
        price_index = {}
        if computed_prices:
            for p in computed_prices:
                price_index[p["check_in"]] = p

        for window in availability_windows:
            ci = date.fromisoformat(window["check_in"])
            co = date.fromisoformat(window["check_out"])

            if not window["is_available"]:
                # Block this window
                ok = self.block_dates(
                    listing_id=listing_id,
                    check_in=ci,
                    check_out=co,
                    reason=window.get("blackout_reason", "Insufficient inventory"),
                )
                if ok:
                    blocked += 1
                else:
                    errors += 1
            else:
                # Open the window
                ok = self.open_dates(listing_id=listing_id, check_in=ci, check_out=co)
                if ok:
                    opened += 1
                else:
                    errors += 1

                # Apply pricing if available
                # Default to Airbnb pricing (primary channel)
                price_data = price_index.get(window["check_in"])
                if price_data and price_data.get("airbnb_nightly"):
                    ok = self.update_pricing(
                        listing_id=listing_id,
                        check_in=ci,
                        check_out=co,
                        nightly_rate=price_data["airbnb_nightly"],
                    )
                    if ok:
                        priced += 1

            # Rate limit protection
            time.sleep(0.3)

        summary = {
            "listing_id": listing_id,
            "blocked": blocked,
            "opened": opened,
            "priced": priced,
            "errors": errors,
            "total": len(availability_windows),
        }

        self.db.log_guesty_sync({
            "listing_id": listing_id,
            "action": "full_sync",
            "check_in": None,
            "check_out": None,
            "payload": json.dumps(summary),
            "response_status": 200,
            "success": 1,
            "error_message": f"{errors} errors" if errors else "",
        })

        logger.info(
            f"[Guesty] Sync complete: {blocked} blocked, {opened} opened, "
            f"{priced} priced, {errors} errors"
        )
        return summary

    # ── Listing Info ──────────────────────────────────────────────────────
    def get_listing(self, listing_id: str) -> Optional[Dict]:
        """Fetch listing details from Guesty."""
        return self._request("GET", f"{GUESTY_LISTINGS_URL}/{listing_id}")

    def list_all_listings(self) -> List[Dict]:
        """Fetch all listings from the Guesty account."""
        data = self._request("GET", GUESTY_LISTINGS_URL, params={"limit": 100})
        if not data:
            return []
        return data.get("results", data.get("data", []))

    # ── Health Check ──────────────────────────────────────────────────────
    def health_check(self) -> bool:
        """Verify Guesty connection is working."""
        try:
            token = self._get_token()
            return bool(token)
        except Exception as e:
            logger.error(f"[Guesty] Health check failed: {e}")
            return False
