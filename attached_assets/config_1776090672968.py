"""
config.py — Central configuration for the Vacation Rental Rate & Availability Engine.
All platform fees, unit definitions, scraping intervals, and thresholds live here.
"""

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from dotenv import load_dotenv

load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
# GUESTY CREDENTIALS
# ─────────────────────────────────────────────────────────────────────────────
GUESTY_CLIENT_ID     = os.getenv("GUESTY_CLIENT_ID", "")
GUESTY_CLIENT_SECRET = os.getenv("GUESTY_CLIENT_SECRET", "")
GUESTY_BASE_URL      = "https://open-api.guesty.com/v1"

# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL API KEYS (improves scraping reliability)
# ─────────────────────────────────────────────────────────────────────────────
SCRAPER_API_KEY     = os.getenv("SCRAPER_API_KEY", "")      # scraperapi.com
SERP_API_KEY        = os.getenv("SERP_API_KEY", "")         # serpapi.com (Google search)
OXYLABS_USER        = os.getenv("OXYLABS_USER", "")
OXYLABS_PASS        = os.getenv("OXYLABS_PASS", "")

# ─────────────────────────────────────────────────────────────────────────────
# DATABASE
# ─────────────────────────────────────────────────────────────────────────────
DATABASE_PATH = os.getenv("DATABASE_PATH", "vacation_rental.db")

# ─────────────────────────────────────────────────────────────────────────────
# PLATFORM FEE STRUCTURES
# Host-side fees (what WE pay the platform per booking).
# Formula: listed_price = (buy_in * DESIRED_MARGIN) / (1 - host_fee_pct)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class PlatformFees:
    name: str
    host_fee_pct: float         # Fee the platform charges the HOST (us)
    payment_processing_pct: float   # Payment processor cut (included in host fee for most)
    guest_fee_pct: float        # Fee charged to GUEST (informational — affects competitiveness)
    notes: str = ""

PLATFORM_FEES: Dict[str, PlatformFees] = {
    "airbnb": PlatformFees(
        name="Airbnb",
        host_fee_pct=0.03,          # 3% host service fee (channel manager / API hosts)
        payment_processing_pct=0.03, # Included in the 3%
        guest_fee_pct=0.142,         # ~14.2% added to guest total (varies 5–20% by booking size)
        notes="Airbnb charges hosts 3% via API/CM; guests pay ~14.2% service fee separately."
    ),
    "vrbo": PlatformFees(
        name="VRBO",
        host_fee_pct=0.08,           # 5% commission + 3% credit card processing
        payment_processing_pct=0.03,
        guest_fee_pct=0.10,          # ~6–12% guest service fee
        notes="VRBO charges 8% total owner fees. Subscription model also available (~$499/yr + 3% CC)."
    ),
    "booking": PlatformFees(
        name="Booking.com",
        host_fee_pct=0.15,           # 15% commission on full booking value (no guest fee)
        payment_processing_pct=0.00,  # Handled within 15%
        guest_fee_pct=0.00,
        notes="Booking.com charges 15% commission; no separate guest fee. Price parity required."
    ),
}

# ─────────────────────────────────────────────────────────────────────────────
# DESIRED PROFIT MARGIN (applied on top of buy-in cost BEFORE platform fee div)
# ─────────────────────────────────────────────────────────────────────────────
DESIRED_MARKUP_PCT = 0.20  # 20% gross margin on buy-in cost

# ─────────────────────────────────────────────────────────────────────────────
# UNIT DEFINITIONS
# Maps a composite Guesty listing to the source units that must be bought.
# A 6BR Poipu listing = two 3BR condos in Poipu Kai.
# Add as many composite units as needed.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class SourceUnit:
    """A buyable rental unit (what we source from Airbnb/VRBO/PM)."""
    search_query: str           # Search term used to find this unit
    location: str               # City / neighborhood
    bedrooms: int
    unit_type: str              # "condo", "house", "villa", etc.
    platforms: List[str] = field(default_factory=lambda: ["airbnb", "vrbo", "booking"])
    additional_keywords: List[str] = field(default_factory=list)

@dataclass
class CompositeUnit:
    """A Guesty listing that requires multiple source units purchased together."""
    guesty_listing_id: str      # Guesty listing ID to manage calendar/pricing for
    display_name: str
    total_bedrooms: int
    source_units: List[SourceUnit]  # ALL must be available simultaneously
    min_available_per_source: int = 3   # Minimum available listings per source unit needed to allow booking (buffer)
    required_per_source: int = 1        # How many of each source unit we actually buy

COMPOSITE_UNITS: List[CompositeUnit] = [
    CompositeUnit(
        guesty_listing_id=os.getenv("GUESTY_LISTING_ID_POIPU_6BR", ""),
        display_name="6BR Poipu Vacation Rental",
        total_bedrooms=6,
        source_units=[
            SourceUnit(
                search_query="3 bedroom condo Poipu Kai",
                location="Poipu, Kauai, Hawaii",
                bedrooms=3,
                unit_type="condo",
                platforms=["airbnb", "vrbo"],
                additional_keywords=["Poipu Kai", "Kauai", "3BR", "3 bed"]
            ),
            SourceUnit(
                search_query="3 bedroom condo Poipu Kai",
                location="Poipu, Kauai, Hawaii",
                bedrooms=3,
                unit_type="condo",
                platforms=["airbnb", "vrbo"],
                additional_keywords=["Poipu Kai", "Kauai", "3BR", "3 bed"]
            ),
        ],
        min_available_per_source=3,  # Need 3 available to safely book 1 (buffer against fake availability)
        required_per_source=1,       # We buy 1 of each (total = 2 units = 6BR)
    ),
    # ── Add more composite units here ─────────────────────────────────────
]

# ─────────────────────────────────────────────────────────────────────────────
# AVAILABILITY CHECK SETTINGS
# ─────────────────────────────────────────────────────────────────────────────
AVAILABILITY_WINDOW_MONTHS    = 24    # How far ahead to check availability
AVAILABILITY_INTERVAL_DAYS    = 14   # Check in 14-day rolling windows
MIN_LISTINGS_PER_SEARCH       = 5    # Minimum listings to find before results are trusted
AVAILABILITY_CONFIDENCE_PCT   = 0.60 # >60% of sampled sources must show available

# "Fake availability" buffer:
# Some listings show available but aren't actually bookable.
# We require MIN_AVAILABLE_PER_SOURCE listings available (not just 1 or 2).
# If fewer than this are found across all sources for a window → BLACKOUT.
HARD_BLACKOUT_THRESHOLD       = 2    # If < this many available → immediate blackout
SOFT_BLACKOUT_THRESHOLD       = 3    # If < this many → mark as "risky" (still blackout by default)

# ─────────────────────────────────────────────────────────────────────────────
# SCHEDULER INTERVALS (in minutes unless noted)
# ─────────────────────────────────────────────────────────────────────────────
RATE_REFRESH_INTERVAL_HOURS        = 6   # Refresh buy-in rates every 6 hours
AVAILABILITY_REFRESH_INTERVAL_HOURS = 4  # Check availability every 4 hours
GUESTY_SYNC_INTERVAL_HOURS         = 1   # Push updates to Guesty every hour
FULL_REFRESH_INTERVAL_HOURS        = 24  # Full deep scan once daily

# ─────────────────────────────────────────────────────────────────────────────
# SCRAPING SETTINGS
# ─────────────────────────────────────────────────────────────────────────────
REQUEST_TIMEOUT_SECONDS  = 30
REQUEST_DELAY_MIN        = 2.0   # Seconds between requests (min)
REQUEST_DELAY_MAX        = 5.0   # Seconds between requests (max)
MAX_RETRIES              = 3
USE_PROXY_ROTATION       = bool(SCRAPER_API_KEY)   # Auto-enable if ScraperAPI key set

# Airbnb unofficial API key (public, embedded in their web app)
AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20"

# User-Agent rotation pool
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
]

# ─────────────────────────────────────────────────────────────────────────────
# PROPERTY MANAGEMENT COMPANIES TO SCRAPE (Kauai/Poipu specific)
# Add URLs of PM companies' search/availability pages here
# ─────────────────────────────────────────────────────────────────────────────
PROPERTY_MANAGEMENT_SOURCES = [
    {
        "name": "Poipu Kai Resort Rentals",
        "search_url": "https://www.poipukairesort.com/rentals/",
        "type": "property_manager",
        "location": "Poipu Kai, Kauai",
    },
    {
        "name": "Parrish Kauai",
        "search_url": "https://www.parrishkauai.com/vacation-rentals/search?location=poipu&bedrooms=3",
        "type": "property_manager",
        "location": "Poipu, Kauai",
    },
    {
        "name": "Kauai Exclusive Management",
        "search_url": "https://www.kauaiexclusive.com/vacation-rentals/?bedrooms=3&area=poipu",
        "type": "property_manager",
        "location": "Poipu, Kauai",
    },
    {
        "name": "Coldwell Banker Kauai",
        "search_url": "https://www.cbislandvacations.com/vacation-rentals/kauai/poipu/?beds=3",
        "type": "property_manager",
        "location": "Poipu, Kauai",
    },
    {
        "name": "ResortQuest Kauai",
        "search_url": "https://www.destinationhotels.com/outrigger/kauai",
        "type": "property_manager",
        "location": "Poipu, Kauai",
    },
]

# Google search queries to find additional PM sources
GOOGLE_PM_SEARCH_QUERIES = [
    "3 bedroom condo Poipu Kai rental rates per night",
    "Poipu Kai Resort 3 bedroom condo nightly rate",
    "Poipu Kauai 3BR condo vacation rental nightly price",
    "Poipu Kai vacation rental management company rates",
    "Kauai Poipu 3 bedroom condo rental weekly rate",
]

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FILE   = os.getenv("LOG_FILE", "vacation_rental.log")
