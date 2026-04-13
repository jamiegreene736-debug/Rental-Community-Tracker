"""
pricing/calculator.py — Rate markup engine.

Given a buy-in (cost) rate, compute the correct listed price on each platform
such that after the platform takes its host fee, we net exactly:
    buy_in_cost × (1 + DESIRED_MARKUP_PCT)

Formula:
    net_required   = buy_in_nightly × (1 + markup_pct)
    listed_nightly = net_required / (1 - platform_host_fee_pct)
    listed_total   = listed_nightly × nights + (cleaning_fee / (1 - host_fee_pct))

Each platform has a different fee structure — see config.py for details.
"""

import logging
from dataclasses import dataclass
from typing import Dict, Optional
from config import PLATFORM_FEES, DESIRED_MARKUP_PCT, PlatformFees

logger = logging.getLogger(__name__)


@dataclass
class BuyInRate:
    nightly_rate: float
    cleaning_fee: float = 0.0
    other_fees: float = 0.0      # Resort fees, HOA charges, tax passthroughs, etc.
    nights: int = 1
    currency: str = "USD"
    source_count: int = 1
    confidence: float = 1.0

    @property
    def total_cost(self) -> float:
        return (self.nightly_rate * self.nights) + self.cleaning_fee + self.other_fees


@dataclass
class ListedPrice:
    platform: str
    nightly_rate: float          # What we list per night (before guest service fee)
    cleaning_fee: float          # Our listed cleaning fee
    host_fee_charged: float      # What the platform takes from us
    net_to_host: float           # What we receive after platform fee
    our_cost: float              # Our buy-in cost
    gross_profit: float          # net_to_host - our_cost
    markup_pct_achieved: float   # Actual markup % vs buy-in
    total_listed: float          # Total guest cost displayed on platform (incl guest fee)
    nights: int

    def as_dict(self) -> Dict:
        return {
            "platform": self.platform,
            "nightly_rate": round(self.nightly_rate, 2),
            "cleaning_fee": round(self.cleaning_fee, 2),
            "host_fee_charged": round(self.host_fee_charged, 2),
            "net_to_host": round(self.net_to_host, 2),
            "our_cost": round(self.our_cost, 2),
            "gross_profit": round(self.gross_profit, 2),
            "markup_pct_achieved": round(self.markup_pct_achieved * 100, 2),
            "total_listed_before_guest_fee": round(self.nightly_rate * self.nights + self.cleaning_fee, 2),
            "total_listed_with_guest_fee": round(self.total_listed, 2),
            "nights": self.nights,
        }


class PricingCalculator:
    """
    Core pricing engine.

    For each platform, we solve for the listed nightly rate that:
    1. Covers our buy-in cost (after platform host fee)
    2. Provides the desired markup on top of cost
    3. Accounts for cleaning fees and other fees correctly

    Cleaning fees are typically NOT subject to host service fees on Airbnb
    (they are passed through), but ARE subject to commission on Booking.com.
    We handle each platform's nuance explicitly.
    """

    def __init__(self, markup_pct: float = DESIRED_MARKUP_PCT):
        self.markup_pct = markup_pct
        self.fees = PLATFORM_FEES

    # ── Core Calculation ──────────────────────────────────────────────────
    def calculate(self, buy_in: BuyInRate, platform: str) -> Optional[ListedPrice]:
        if platform not in self.fees:
            logger.warning(f"Unknown platform: {platform}")
            return None

        fee_config: PlatformFees = self.fees[platform]
        h = fee_config.host_fee_pct      # Host fee (what platform takes from us)
        g = fee_config.guest_fee_pct     # Guest fee (informational for competitiveness)

        # What we need to NET after platform takes its cut
        # We need: net_nightly = buy_in_nightly * (1 + markup_pct)
        net_nightly_required = buy_in.nightly_rate * (1 + self.markup_pct)

        # Listed nightly rate that, after host fee, yields net_nightly_required
        # net = listed * (1 - h)  →  listed = net / (1 - h)
        listed_nightly = net_nightly_required / (1 - h)

        # Handle cleaning fees — platform-specific behavior
        listed_cleaning = self._listed_cleaning_fee(
            buy_in.cleaning_fee, fee_config, platform
        )

        # What the host fee actually costs us in dollars
        nightly_subtotal = listed_nightly * buy_in.nights
        cleaning_subject_to_fee = self._cleaning_subject_to_fee(
            listed_cleaning, platform
        )
        total_subject_to_fee = nightly_subtotal + cleaning_subject_to_fee
        host_fee_dollars = total_subject_to_fee * h

        # What we actually receive
        net_to_host = (nightly_subtotal + listed_cleaning) - host_fee_dollars

        # Our total cost (buy-in)
        our_cost = buy_in.total_cost

        # Profit metrics
        gross_profit = net_to_host - our_cost
        markup_achieved = gross_profit / our_cost if our_cost > 0 else 0

        # Total guest sees on platform (incl. their service fee)
        guest_facing_total = (
            (listed_nightly * buy_in.nights + listed_cleaning) * (1 + g)
        )

        return ListedPrice(
            platform=platform,
            nightly_rate=listed_nightly,
            cleaning_fee=listed_cleaning,
            host_fee_charged=host_fee_dollars,
            net_to_host=net_to_host,
            our_cost=our_cost,
            gross_profit=gross_profit,
            markup_pct_achieved=markup_achieved,
            total_listed=guest_facing_total,
            nights=buy_in.nights,
        )

    def calculate_all_platforms(self, buy_in: BuyInRate) -> Dict[str, ListedPrice]:
        """Calculate listed prices for all configured platforms."""
        results = {}
        for platform in self.fees:
            price = self.calculate(buy_in, platform)
            if price:
                results[platform] = price
        return results

    # ── Platform-Specific Fee Handling ────────────────────────────────────
    def _listed_cleaning_fee(
        self, buy_in_cleaning: float, fee_config: PlatformFees, platform: str
    ) -> float:
        """
        How to list the cleaning fee so we don't lose money on it.

        Airbnb:  Cleaning fee is passed through (not subject to 3% host fee on
                 the cleaning fee itself in most configurations). We list it 1:1
                 but apply our markup.
        VRBO:    Cleaning fee IS included in the amount subject to 8% commission.
                 So we gross it up.
        Booking: Full 15% commission applies to everything including cleaning.
                 Gross up cleaning fee too.
        """
        if buy_in_cleaning == 0:
            return 0

        required_net_cleaning = buy_in_cleaning * (1 + self.markup_pct)

        if platform == "airbnb":
            # Airbnb cleaning fees are shown separately and typically NOT
            # subject to the full host fee pass-through (complex — we gross up
            # slightly to be safe with the 3% host fee)
            return required_net_cleaning / (1 - fee_config.host_fee_pct)
        elif platform == "vrbo":
            return required_net_cleaning / (1 - fee_config.host_fee_pct)
        elif platform == "booking":
            # Booking charges commission on total including cleaning
            return required_net_cleaning / (1 - fee_config.host_fee_pct)
        else:
            return required_net_cleaning / (1 - fee_config.host_fee_pct)

    def _cleaning_subject_to_fee(self, listed_cleaning: float, platform: str) -> float:
        """How much of the cleaning fee is in the commission base."""
        # Airbnb: debated, but we conservatively include it
        # VRBO/Booking: yes
        return listed_cleaning  # Conservative — include everywhere

    # ── Composite Unit Pricing ────────────────────────────────────────────
    def calculate_composite(
        self,
        source_unit_rates: list,   # List of BuyInRate (one per source unit)
        platform: str,
        nights: int
    ) -> Optional[ListedPrice]:
        """
        For a composite listing (e.g., 6BR = two 3BR units), sum the buy-in
        costs of all required source units, then compute a single listed price.
        """
        if not source_unit_rates:
            return None

        total_nightly = sum(r.nightly_rate for r in source_unit_rates)
        total_cleaning = sum(r.cleaning_fee for r in source_unit_rates)
        total_other = sum(r.other_fees for r in source_unit_rates)

        combined_buy_in = BuyInRate(
            nightly_rate=total_nightly,
            cleaning_fee=total_cleaning,
            other_fees=total_other,
            nights=nights,
        )
        return self.calculate(combined_buy_in, platform)

    # ── Validation & Sanity Checks ────────────────────────────────────────
    def validate_price(self, listed: ListedPrice, floor_price: float = 0.0) -> bool:
        """Ensure the listed price is sane."""
        if listed.nightly_rate < floor_price:
            logger.warning(
                f"[{listed.platform}] Listed nightly ${listed.nightly_rate:.2f} "
                f"below floor ${floor_price:.2f}"
            )
            return False
        if listed.markup_pct_achieved < (self.markup_pct * 0.95):
            logger.warning(
                f"[{listed.platform}] Markup achieved {listed.markup_pct_achieved*100:.1f}% "
                f"below target {self.markup_pct*100:.1f}%"
            )
            return False
        return True

    # ── Rate Summary String ───────────────────────────────────────────────
    def format_summary(self, buy_in: BuyInRate, listings: Dict[str, ListedPrice]) -> str:
        lines = [
            f"\n{'='*60}",
            f"  PRICING SUMMARY — {buy_in.nights}-Night Stay",
            f"{'='*60}",
            f"  Buy-In Cost:      ${buy_in.nightly_rate:.2f}/night  |  "
            f"${buy_in.total_cost:.2f} total ({buy_in.source_count} sources)",
            f"  Target Markup:    {self.markup_pct*100:.0f}%",
            f"{'─'*60}",
        ]
        for platform, p in listings.items():
            lines.append(
                f"  {platform.upper():12s}  "
                f"List: ${p.nightly_rate:.2f}/night  |  "
                f"Net: ${p.net_to_host:.2f}  |  "
                f"Profit: ${p.gross_profit:.2f} ({p.markup_pct_achieved*100:.1f}%)  |  "
                f"Guest sees: ${p.total_listed:.2f}"
            )
        lines.append(f"{'='*60}\n")
        return "\n".join(lines)
