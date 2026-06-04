# RealtyAPI community discovery (operator runbook)

RealtyAPI (`realtor.realtyapi.io`) discovers **Realtor.com listing URLs and
addresses** for a vacation community using paginated `/search/bylocation`
queries. It replaces the slow RentCast→SearchAPI resolve path for **Realtor**
candidates.

Photos and bed/bath facts still come from the Apify-first portal scrape stack
(`scrapeListingPhotos` / `scrapeListingPhotosDualSource`).

## Railway env vars

| Variable | Purpose |
|----------|---------|
| `REALTYAPI_API_KEY` | API key (`x-realtyapi-key` + `Authorization: Bearer`) |
| `REALTYAPI_DISCOVERY_ENABLED` | Set `0` to disable the RealtyAPI leg only |

Optional tuning:

| Variable | Default (standard) | Effect |
|----------|-------------------|--------|
| `REALTYAPI_RESULT_COUNT` | 100 | Results per page (10–200) |
| `REALTYAPI_MAX_PAGES_PER_LOCATION` | 8 | Pages per location query |
| `REALTYAPI_MAX_LOCATIONS` | 10 | Max location strings tried per run |
| `REALTYAPI_REQUEST_TIMEOUT_MS` | 18000 | HTTP timeout per page |
| `REALTYAPI_PAGE_DELAY_MS` | 250 | Delay between pages (rate limit) |

## Search strategy (community addresses)

For each community (example: **Pili Mai**):

1. `Pili Mai at Poipu` / `Pili Mai` (name aliases from `community-addresses.ts`)
2. Canonical street: `2611 Kiahuna Plantation Dr, Koloa, HI`
3. ZIP `96756`
4. Discovery cities: `Koloa, HI`, etc.

Each query uses `propertyType=Condo,Townhome`, `searchType=For_Sale`,
`pending=false`, `hasPhotos=true`, optional `keywords` from community name,
and bedroom filters when the wizard requests a specific BR count.

Results are filtered to the resort using **street roots** when
`streetAddress` is known, or community keyword anchoring otherwise.

## Wired endpoints

Same stacked discovery as RentCast:

- `POST /api/community/fetch-unit-photos` (combo wizard, queue, preflight)
- `POST /api/replacement/find-unit`
- `POST /api/single-listing/find-clean-unit`

## Log lines

```text
[realtyapi-discovery] community="Pili Mai" locations=8 pages=12 raw=94 kept=31 errors=0
[fetch-unit-photos] stacked discovery for "Pili Mai": ... realtyapi(raw=94 kept=31 added=28 pages=12 locations=8) total=...
[find-unit] stacked RealtyAPI discovery: locations=8 pages=4 raw=40 kept=18 added=15
```

## Admin probe

`GET /api/admin/probe-realtyapi?communityName=Pili+Mai&streetAddress=2611+Kiahuna+Plantation+Dr&city=Koloa&state=HI`

Returns candidate addresses + Realtor URLs without scraping photos.

## Load-bearing

See `AGENTS.md` **#44**. Do not persist RealtyAPI search thumbnails as final
gallery photos without running the scrape pipeline.
