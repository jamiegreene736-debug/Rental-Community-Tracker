"""
scrapers/web_scraper.py — Google Search + Property Management Company scraper.

Sources:
1. SerpAPI (Google Search) — finds PM company listings and nightly rates
2. Direct PM website scraping (BeautifulSoup)
3. Generic JSON-LD / structured data extraction from any rental page

Falls back gracefully if SerpAPI key isn't configured (uses googlesearch-python).
"""

import json
import logging
import re
import time
from datetime import date
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode, urlparse, urljoin

try:
    from bs4 import BeautifulSoup
    BS4_AVAILABLE = True
except ImportError:
    BS4_AVAILABLE = False
    BeautifulSoup = None

try:
    from googlesearch import search as google_search_fallback
    GOOGLESEARCH_AVAILABLE = True
except ImportError:
    GOOGLESEARCH_AVAILABLE = False

from scrapers.base_scraper import BaseScraper
from config import SERP_API_KEY, GOOGLE_PM_SEARCH_QUERIES, PROPERTY_MANAGEMENT_SOURCES

logger = logging.getLogger(__name__)


class GoogleSearchScraper(BaseScraper):
    PLATFORM = "google"

    # ── Google / SERP Searching ───────────────────────────────────────────
    def _serp_search(self, query: str, num_results: int = 10) -> List[Dict]:
        """Use SerpAPI if key is available, else fall back to googlesearch-python."""
        if SERP_API_KEY:
            return self._serpapi_search(query, num_results)
        elif GOOGLESEARCH_AVAILABLE:
            return self._googlesearch_fallback(query, num_results)
        else:
            logger.warning("No Google search method available. Set SERP_API_KEY or install googlesearch-python.")
            return []

    def _serpapi_search(self, query: str, num_results: int = 10) -> List[Dict]:
        url = "https://serpapi.com/search"
        params = {
            "api_key": SERP_API_KEY,
            "q": query,
            "hl": "en",
            "gl": "us",
            "num": num_results,
        }
        resp = self.get(url, params=params)
        data = self.safe_json(resp)
        if not data:
            return []

        results = []
        for r in data.get("organic_results", []):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("link", ""),
                "snippet": r.get("snippet", ""),
            })
        return results

    def _googlesearch_fallback(self, query: str, num_results: int = 10) -> List[Dict]:
        """googlesearch-python — slower, no structured data, but no API key needed."""
        results = []
        try:
            for url in google_search_fallback(query, num_results=num_results, stop=num_results, pause=2.0):
                results.append({"title": "", "url": url, "snippet": ""})
                time.sleep(1)
        except Exception as e:
            logger.warning(f"Google search fallback error: {e}")
        return results

    # ── Price Extraction from Any Page ────────────────────────────────────
    def _extract_price_from_page(self, url: str, bedrooms: int) -> Optional[Dict]:
        """
        Fetch a rental listing page and extract nightly rate using:
        1. JSON-LD structured data
        2. Open Graph / meta tags
        3. Common CSS selectors / regex patterns
        """
        resp = self.get(url)
        if not resp or not BS4_AVAILABLE:
            return None

        soup = BeautifulSoup(resp.text, "html.parser")

        # 1. JSON-LD (most reliable — used by Airbnb, PM sites, schema.org)
        price = self._extract_jsonld_price(soup, url)
        if price:
            return price

        # 2. Common price patterns in HTML
        price = self._extract_html_price(soup, url, bedrooms)
        return price

    def _extract_jsonld_price(self, soup, url: str) -> Optional[Dict]:
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
                if not isinstance(data, (dict, list)):
                    continue
                items = data if isinstance(data, list) else [data]
                for item in items:
                    schema_type = item.get("@type", "")
                    if schema_type in ("LodgingBusiness", "VacationRental", "Accommodation", "Product"):
                        offers = item.get("offers", item.get("priceSpecification", {}))
                        if isinstance(offers, list):
                            offers = offers[0] if offers else {}
                        price_val = (
                            offers.get("price")
                            or offers.get("lowPrice")
                            or item.get("price")
                        )
                        if price_val:
                            return {
                                "nightly_rate": float(re.sub(r"[^\d.]", "", str(price_val))),
                                "source": "json-ld",
                                "url": url,
                            }
            except Exception:
                continue
        return None

    def _extract_html_price(self, soup, url: str, bedrooms: int) -> Optional[Dict]:
        # Common patterns across PM websites
        price_patterns = [
            r"\$\s*([\d,]+(?:\.\d{2})?)\s*/?\s*(?:night|nightly|per night|/nt)",
            r"([\d,]+(?:\.\d{2})?)\s*/?\s*(?:night|nightly|per night)",
            r"from\s+\$\s*([\d,]+)",
            r"starting\s+at\s+\$\s*([\d,]+)",
        ]
        text = soup.get_text(" ", strip=True)

        # First try common CSS selectors
        selectors = [
            "[class*='price']", "[class*='rate']", "[class*='nightly']",
            "[data-price]", "[itemprop='price']", ".price-display",
            ".nightly-rate", ".rental-rate",
        ]
        for selector in selectors:
            elements = soup.select(selector)
            for el in elements:
                el_text = el.get_text(strip=True)
                for pat in price_patterns:
                    m = re.search(pat, el_text, re.IGNORECASE)
                    if m:
                        try:
                            price = float(m.group(1).replace(",", ""))
                            if 50 < price < 5000:  # sanity check
                                return {
                                    "nightly_rate": price,
                                    "source": "html-selector",
                                    "url": url,
                                }
                        except ValueError:
                            pass

        # Full-text search
        for pat in price_patterns:
            m = re.search(pat, text, re.IGNORECASE)
            if m:
                try:
                    price = float(m.group(1).replace(",", ""))
                    if 50 < price < 5000:
                        return {
                            "nightly_rate": price,
                            "source": "html-text",
                            "url": url,
                        }
                except ValueError:
                    pass
        return None

    # ── Search for Rates ──────────────────────────────────────────────────
    def search_listings(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
    ) -> List[Dict[str, Any]]:
        """
        Search Google for vacation rental listings and extract rates.
        """
        queries = [
            f"{bedrooms} bedroom condo {location} vacation rental nightly rate {check_in.year}",
            f"{location} {bedrooms}BR rental per night site:airbnb.com OR site:vrbo.com",
            f"Poipu Kai {bedrooms} bedroom condo rental nightly rate",
        ]

        all_results = []
        for query in queries:
            results = self._serp_search(query, num_results=10)
            all_results.extend(results)

        # Deduplicate by URL
        seen = set()
        unique_results = []
        for r in all_results:
            if r["url"] not in seen:
                seen.add(r["url"])
                unique_results.append(r)

        # Extract prices from snippet text first (faster than fetching pages)
        listings = []
        for result in unique_results:
            price = self._extract_price_from_snippet(result["snippet"])
            if price and 50 < price < 5000:
                listings.append({
                    "id": result["url"],
                    "name": result["title"],
                    "url": result["url"],
                    "nightly_rate": price,
                    "bedrooms": bedrooms,
                    "is_available": True,
                    "source": "google_snippet",
                })

        # For results without snippet prices, fetch the page
        fetched_count = 0
        for result in unique_results:
            if fetched_count >= 5:  # Limit page fetches
                break
            if any(l["url"] == result["url"] for l in listings):
                continue  # Already got price from snippet
            detail = self._extract_price_from_page(result["url"], bedrooms)
            if detail and detail.get("nightly_rate"):
                listings.append({
                    "id": result["url"],
                    "name": result["title"],
                    "url": result["url"],
                    "nightly_rate": detail["nightly_rate"],
                    "bedrooms": bedrooms,
                    "is_available": True,
                    "source": "google_page",
                })
                fetched_count += 1

        logger.info(f"[Google] Found {len(listings)} listings for {location} {bedrooms}BR")
        return listings

    def _extract_price_from_snippet(self, snippet: str) -> Optional[float]:
        if not snippet:
            return None
        patterns = [
            r"\$\s*([\d,]+(?:\.\d{2})?)\s*/?\s*night",
            r"\$\s*([\d,]+(?:\.\d{2})?)\s*per night",
            r"from\s+\$\s*([\d,]+)",
        ]
        for pat in patterns:
            m = re.search(pat, snippet, re.IGNORECASE)
            if m:
                try:
                    return float(m.group(1).replace(",", ""))
                except ValueError:
                    pass
        return None

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
            record = self.build_rate_record(
                location=location,
                bedrooms=bedrooms,
                check_in=check_in,
                check_out=check_out,
                nightly_rate=listing["nightly_rate"],
                is_available=True,
                source_name=listing.get("name", ""),
                source_url=listing.get("url", ""),
                listing_id=listing.get("id", ""),
                unit_type="condo",
            )
            records.append(record)
        return records


class PropertyManagerScraper(BaseScraper):
    """
    Scraper for known property management company websites.
    Fetches their search/availability pages directly and extracts nightly rates.
    """
    PLATFORM = "property_manager"

    def search_listings(
        self,
        location: str,
        bedrooms: int,
        check_in: date,
        check_out: date,
    ) -> List[Dict[str, Any]]:
        all_listings = []
        for pm in PROPERTY_MANAGEMENT_SOURCES:
            logger.info(f"[PM] Scraping: {pm['name']}")
            listings = self._scrape_pm_site(pm, bedrooms, check_in, check_out)
            all_listings.extend(listings)
        return all_listings

    def _scrape_pm_site(
        self, pm: Dict, bedrooms: int, check_in: date, check_out: date
    ) -> List[Dict]:
        """Generic PM site scraper — appends date params and extracts prices."""
        base_url = pm["search_url"]

        # Append dates to URL if it accepts them
        sep = "&" if "?" in base_url else "?"
        url_with_dates = (
            f"{base_url}{sep}checkin={check_in}&checkout={check_out}"
            f"&bedrooms={bedrooms}&arrival={check_in}&departure={check_out}"
        )

        resp = self.get(url_with_dates)
        if not resp or not BS4_AVAILABLE:
            return []

        soup = BeautifulSoup(resp.text, "html.parser")

        # Try JSON-LD first
        listings = self._extract_jsonld_listings(soup, pm)
        if listings:
            return listings

        # Try structured property card extraction
        listings = self._extract_property_cards(soup, pm, bedrooms)
        return listings

    def _extract_jsonld_listings(self, soup, pm: Dict) -> List[Dict]:
        listings = []
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
                items = data if isinstance(data, list) else [data]
                for item in items:
                    if item.get("@type") in ("LodgingBusiness", "VacationRental", "ItemList"):
                        if item.get("@type") == "ItemList":
                            for sub in item.get("itemListElement", []):
                                price = self._extract_offer_price(sub.get("item", sub))
                                if price:
                                    listings.append({
                                        "id": sub.get("url", pm["search_url"]),
                                        "name": sub.get("name", pm["name"]),
                                        "url": sub.get("url", pm["search_url"]),
                                        "nightly_rate": price,
                                        "is_available": True,
                                    })
                        else:
                            price = self._extract_offer_price(item)
                            if price:
                                listings.append({
                                    "id": item.get("url", pm["search_url"]),
                                    "name": item.get("name", pm["name"]),
                                    "url": item.get("url", pm["search_url"]),
                                    "nightly_rate": price,
                                    "is_available": True,
                                })
            except Exception:
                continue
        return listings

    def _extract_offer_price(self, item: Dict) -> Optional[float]:
        offers = item.get("offers", item.get("priceSpecification", {}))
        if isinstance(offers, list):
            offers = offers[0] if offers else {}
        price_str = str(offers.get("price") or offers.get("lowPrice") or 0)
        try:
            price = float(re.sub(r"[^\d.]", "", price_str))
            return price if price > 0 else None
        except ValueError:
            return None

    def _extract_property_cards(
        self, soup, pm: Dict, bedrooms: int
    ) -> List[Dict]:
        """Extract listings from common property card HTML patterns."""
        listings = []
        price_re = re.compile(r"\$\s*([\d,]+(?:\.\d{2})?)", re.IGNORECASE)

        # Common card selectors
        card_selectors = [
            ".property-card", ".listing-card", ".rental-card",
            ".unit-listing", "[class*='property']", "[class*='listing']",
            "article", ".result-item",
        ]

        cards = []
        for selector in card_selectors:
            found = soup.select(selector)
            if len(found) >= 2:  # Found meaningful results
                cards = found
                break

        for card in cards[:20]:  # Limit to 20 cards
            text = card.get_text(" ", strip=True)
            m = price_re.search(text)
            if m:
                try:
                    price = float(m.group(1).replace(",", ""))
                    if 50 < price < 5000:
                        # Try to get the link
                        link_tag = card.find("a", href=True)
                        url = pm["search_url"]
                        if link_tag:
                            href = link_tag["href"]
                            if href.startswith("http"):
                                url = href
                            else:
                                base = f"{urlparse(pm['search_url']).scheme}://{urlparse(pm['search_url']).netloc}"
                                url = urljoin(base, href)

                        name_tag = card.find(["h2", "h3", "h4", ".title", ".name"])
                        name = name_tag.get_text(strip=True) if name_tag else pm["name"]

                        listings.append({
                            "id": url,
                            "name": name,
                            "url": url,
                            "nightly_rate": price,
                            "bedrooms": bedrooms,
                            "is_available": True,
                        })
                except ValueError:
                    pass

        return listings

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
            record = self.build_rate_record(
                location=location,
                bedrooms=bedrooms,
                check_in=check_in,
                check_out=check_out,
                nightly_rate=listing["nightly_rate"],
                is_available=True,
                source_name=listing.get("name", ""),
                source_url=listing.get("url", ""),
                listing_id=str(listing.get("id", "")),
                unit_type="condo",
            )
            records.append(record)
        return records
