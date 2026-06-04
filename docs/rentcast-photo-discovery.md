# RentCast photo discovery (operator runbook)

RentCast expands **which addresses** we try before scraping. It does not
provide photos. All photo bytes still come from Zillow/Realtor/Redfin/Homes
via the Apify-first scrape stack (`scrapeListingPhotos`).

## Required Railway env vars

| Variable | Purpose |
|----------|---------|
| `RENTCAST_API_KEY` | RentCast API (`X-Api-Key` header) |
| `SEARCHAPI_API_KEY` | Resolves each RentCast address → Zillow/Realtor detail URLs |
| `APIFY_API_TOKEN` | Recommended — primary Zillow/Realtor search + scrape |

Optional: `RENTCAST_DISCOVERY_ENABLED=0` turns off the RentCast leg only.

## Discovery flows wired

1. **Combo preflight** — `POST /api/community/fetch-unit-photos`
2. **Replacement photos** — `POST /api/replacement/find-unit`
3. **Single-listing wizard** — `POST /api/single-listing/find-clean-unit`

Each runs **in parallel**: Apify search, Zillow `site:` SearchAPI, RentCast
harvest + resolve, **RealtyAPI** community Realtor search (see
`docs/realtyapi-photo-discovery.md`), plus supplemental Realtor/Redfin/Homes
where applicable.

## Log lines to verify after deploy

**fetch-unit-photos**

```text
[fetch-unit-photos] stacked discovery for "Resort Name": apify(zillow=… realtor=…) zillowSearchApi=+… rentcast(raw=… kept=… resolvedZ=… resolvedR=…) total=…
```

**find-unit**

```text
[find-unit] stacked RentCast discovery: cities=… raw=… kept=… resolvedZ=… resolvedR=… added=…
```

**find-clean-unit**

```text
[find-clean-unit] stacked discovery for "…": rentcast(raw=… kept=… resolvedZ=… resolvedR=…) total=…
```

**RentCast API module**

```text
[rentcast-discovery] cities=… state=… raw=… kept=… errors=0
[rentcast-discovery] portal resolve lookups=… zillow=… realtor=…
```

## Tuning (no code deploy)

Overrides apply on top of per-route profiles (`bounded`, `standard`,
`cityWide`, `findUnit`). See `rentCastDiscoveryTuning()` in
`server/rentcast-discovery.ts`.

| Env var | Default (standard) | Effect |
|---------|-------------------|--------|
| `RENTCAST_LIMIT_PER_CITY` | 100 | Max sale listings fetched per discovery city (10–500) |
| `RENTCAST_RESOLVER_MAX_LOOKUPS` | 40 | Max unique street roots sent to SearchAPI per run (5–80) |
| `RENTCAST_REQUEST_TIMEOUT_MS` | 12000 | RentCast + resolver HTTP timeout (3000–30000) |
| `RENTCAST_RESOLVER_CONCURRENCY` | 6 | Parallel SearchAPI resolve batches (1–12) |

### When to turn knobs

- **`raw` high, `resolvedZ`/`resolvedR` near zero** — increase resolver
  lookups or check SearchAPI quota; verify city names match RentCast casing.
- **`raw` always 0** — wrong city/state for resort; check
  `discoverySearchCitiesForPhotoSearch` aliases in logs; confirm market has
  active Condo/Townhouse on RentCast.
- **Discovery slow / timeouts** — lower `RENTCAST_LIMIT_PER_CITY` or
  `RENTCAST_RESOLVER_MAX_LOOKUPS`; raise `RENTCAST_REQUEST_TIMEOUT_MS` only
  if RentCast API is consistently slow.
- **Too many SearchAPI calls** — lower `RENTCAST_RESOLVER_MAX_LOOKUPS` and
  `RENTCAST_RESOLVER_CONCURRENCY`.

## Load-bearing policy

Documented in `AGENTS.md` Load-Bearing **#43**. Do not scrape RentCast for
photos or skip portal resolution.
