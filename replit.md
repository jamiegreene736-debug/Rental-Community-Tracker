# replit.md

## Overview

This project is **NexStay** — a property research and management dashboard for bundled vacation rental listings. It manages 35+ cataloged multi-unit vacation rental properties, allowing operators to combine individually-owned units in the same community into single large-group listings. Key features include: a sortable/filterable property dashboard, a 5-step Add New Community wizard (research → unit selection → photos → listing draft), an Availability Scanner, a Photo Audit tool, a Buy-In Tracker, **Guesty API integration** for building/publishing listings, and a **Guest Inbox** with auto-approve, messaging, and automated message templates. The tool is rebranded as NexStay throughout. All PMS integration uses **Guesty API only** — Lodgify API has been fully removed.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Project Structure
- **`client/`**: React single-page application (SPA).
- **`server/`**: Express API server.
- **`shared/`**: Shared TypeScript types and database schema.

### Frontend Architecture
- **Framework**: React with TypeScript.
- **Routing**: Wouter.
- **State/Data Fetching**: TanStack React Query.
- **UI Components**: shadcn/ui (new-york style) built on Radix UI primitives.
- **Styling**: Tailwind CSS with CSS custom properties for theming (supports light/dark mode).
- **Build Tool**: Vite.

### Backend Architecture
- **Framework**: Express 5 on Node.js.
- **Language**: TypeScript.
- **API Pattern**: All API routes are prefixed with `/api`.
- **Storage Layer**: Abstracted through an `IStorage` interface, currently using `DatabaseStorage` backed by PostgreSQL via Drizzle ORM.
- **Static Serving**: Serves the built Vite output in production; uses Vite's dev server middleware with HMR in development.

### Database
- **ORM**: Drizzle ORM with PostgreSQL dialect.
- **Schema**: Defined in `shared/schema.ts`, including tables for `users`, `buy_ins`, `lodgify_bookings`, `scanner_runs`, `availability_scans`, and `community_drafts`.
- **Connection**: Requires `DATABASE_URL` environment variable.

### Key Design Decisions
1.  **Shared schema**: Type-safe communication between client and server via `shared/` directory.
2.  **Storage interface pattern**: `IStorage` interface decouples business logic from the data layer.
3.  **API request helper**: `client/src/lib/queryClient.ts` provides `apiRequest()` and `getQueryFn()` for consistent API interaction.

### Feature Specifications
-   **Dashboard**: Displays 35 vacation rental properties with sortable and filterable data (name, community, bedrooms, capacity, pricing, multi-unit indicator, quality score). Includes a **Quality Score (0–10)** column computed by `client/src/data/quality-score.ts` with 5 factors: Market Value Gap (0–4 pts), Profit Margin (0–2 pts), Location Demand (0–2 pts), Group Size Scarcity (0–1 pt), Unit Pairing Match (0–1 pt). Each score shows a color-coded grade (A/B/C/D) with a hover tooltip breaking down each factor and showing estimated market savings %. Sortable.
-   **Listing Builder**: Guesty-powered listing builder accessible from the dashboard via the "Build" button. Step-by-step workflow to configure and publish listings to Airbnb/VRBO/Booking.com through Guesty. Route: `/builder/:propertyId/preflight` → `/builder/:propertyId/:step`. Tabs: Descriptions, Amenities (120+ Guesty strings, per-community profiles), Pricing (seasonal table, basePrice only pushed to Guesty), Photos (grouped by source), **Availability** (24-month / 14-day window scanner using SearchAPI geo-filtered Airbnb search; green/yellow/red status per window; "Scan All" + "Push Blackouts to Guesty" via `POST /blocks`). Backend endpoint: `GET /api/builder/scan-window?propertyId&checkIn&checkOut`.
-   **Buy-In Tracker & Profitability Dashboard**: Tracks Airbnb buy-in purchases, syncs Lodgify guest reservations, and provides profitability reports (`/buy-in-tracker`).
-   **Real-time Buy-In Search**: Searches Airbnb, VRBO, and Google Hotels for cheapest available units based on property, dates, and bedroom configuration.
-   **Photo Audit**: Analyzes property photos, identifies unit numbers, flags potential VRBO conflicts, and validates community photo folders (`/photo-audit`).
-   **Availability Scanner**: Scans Airbnb and VRBO/Google Hotels for listing availability, automatically creating blackout blocks on Lodgify calendar for unrentable weeks (`/availability-scanner`).
-   **Community Photo Finder**: Searches Google Images for community-specific photos, filters irrelevant images, and allows direct saving to project folders (`/community-photo-finder`).
-   **Add New Community Wizard** (`/add-community`): 5-step workflow to research, validate, and draft new bundled listings. Step 1: State/city selection. Step 2: SearchAPI + Claude (claude-3-5-sonnet-20241022) research with 0-100 confidence scoring. Step 3: Zillow/Homes.com unit pair selection. Step 4: Photo fetch + platform check (reverse image search). Step 5: AI-generated VRBO listing draft with legal disclosure. Saved communities appear on the main dashboard.
-   **Legal Disclosure**: All listing `combinedDescription` fields are automatically prepended with the required two-unit disclosure language when rendered in the Lodgify prep page. The `LISTING_DISCLOSURE` constant is exported from `unit-builder-data.ts`.
-   **Compliance & Registration**: All 22 properties in `unit-builder-data.ts` have `taxMapKey` (Hawaii TMK e.g. `4-2-015-008-0001`) and `tatLicense` (TAT License e.g. `TA-0246301`) sample values. These display in the builder's Descriptions tab under a "Compliance & Registration" section, with copy buttons and a "Push Compliance to Guesty" button (`POST /api/builder/push-compliance`) that saves them to `publicDescription.notes`.
-   **Community Photo Verification Methodology** (apply to every community): For each `client/public/photos/community-{slug}/` folder, every image must be (1) verifiably from the actual community/resort — never a generic "Hawaii beach" or wrong-island shot; (2) sourced from the rental operator's official site (Parrish Collection, Poipu Condo Pros, Elite Pacific, Mauna Kai Condos, Koloa Kai, Jean & Abbott, HawaiiGaga, etc.) or the developer's marketing site; (3) free of third-party watermarks (TripAdvisor, Vrbo, Booking, Expedia overlays); (4) at least 800px wide. Workflow when adding/auditing a community: search SearchAPI for `"<community name>" <town> kauai/big island/maui pool|aerial|exterior`, download 10–14 candidates to `/tmp/community-cands/{slug}/`, visually verify each, copy 5–6 strongest as `01-community.jpg`–`06-community.jpg`, and update the matching `COMMUNITY_*` array in `client/src/data/unit-builder-data.ts` with accurate `label` text describing what's actually in the shot.
-   **Unit Photo Verification Methodology + Source Tracking** (apply to every unit folder): Every folder under `client/public/photos/` (both `community-*` and unit folders) must contain a `_source.json` describing where the photos came from and whether they have been verified. Schema:
    ```json
    {
      "folder": "<folder-name>",
      "type": "unit" | "community" | "unused",
      "referencedBy": [{ "propertyId": <n>, "unitId": "<id>", "address": "<addr>" }],
      "verificationStatus": "verified" | "needs-review" | "broken" | "unused",
      "verifiedDate": "YYYY-MM-DD",
      "verifiedBy": "<name or 'agent-audit'>",
      "sourceListing": { "url": "<rental listing URL>", "platform": "airbnb|vrbo|direct", "scrapedDate": "YYYY-MM-DD" },
      "notes": "<context, especially for broken folders>"
    }
    ```
    Two helper scripts in `scripts/` automate this:
    -   `node scripts/generate-photo-sources.mjs` — scans `client/src/data/unit-builder-data.ts` and writes `_source.json` stubs (skips files unless `verifiedBy === "auto-generated-stub"`; pass `--force` to overwrite).
    -   `node scripts/audit-photos.mjs` — hashes every image, flags duplicates (intra-folder + cross-folder), thin folders (<8 unit photos / <5 community photos), tiny/oversized files, missing `_source.json`, folders not referenced in data, folders shared by multiple units, and any folder whose `_source.json` declares `verificationStatus: "broken"`. Exits non-zero when any CRITICAL finding exists.
    Process for adding/replacing unit photos: download the actual rental listing's photos to `/tmp/unit-cands/{folder}/`, drop them into `client/public/photos/{folder}/`, populate `_source.json` with the listing URL and `verificationStatus: "verified"`, then run `node scripts/audit-photos.mjs` to confirm no critical findings.
-   **Known photo issues** (currently flagged BROKEN by `scripts/audit-photos.mjs`):
    -   `poipu-beachside/` — all 16 photos byte-identical to `poipu-oceanfront/`; 2298 Ho'one Rd needs distinct photos sourced from its actual rental listing.
    -   `keauhou-estate/` — only 5 photos shared across 4 units spanning two distinct properties (78-6855 vs 78-6920 Ali'i Dr) and very different sizes (4000 sqft estate vs 800 sqft casita); split into per-unit folders with ≥10 photos each.
    Three folders are populated but unused by data (`kekaha-ohana`, `kiahuna-101`, `kiahuna-134`, `community-kiahuna`) — wire them up in `unit-builder-data.ts` if a corresponding property is added, or delete.
-   **Guesty `publicDescription` fix**: Guesty Open API v1 uses `publicDescription` (singular), NOT `publicDescriptions` (plural). All description pushes (via `updateDescriptions` in `guestyService.ts` and `POST /api/builder/push-descriptions`) now use the correct field name. A GET-after-PUT verification confirms what Guesty actually stored.

## External Dependencies

### Database
-   **PostgreSQL**: Primary database.
-   **Drizzle ORM**: Database toolkit.

### Frontend Libraries
-   **Radix UI**: Headless UI primitives.
-   **shadcn/ui**: Pre-styled component library.
-   **TanStack React Query**: Async state management.
-   **Wouter**: Client-side routing.
-   **React Hook Form + Zod**: Form handling and validation.
-   **Embla Carousel**: Carousel component.
-   **Recharts**: Charting library.
-   **Lucide React**: Icon library.
-   **date-fns**: Date utility library.
-   **vaul**: Drawer component.

### Build Tools
-   **Vite**: Frontend bundler.
-   **esbuild**: Server bundler.
-   **tsx**: TypeScript execution.
-   **Tailwind CSS + PostCSS**: Utility-first CSS framework.

### Third-Party Services
-   **SearchAPI.io**: Used for real-time Airbnb, VRBO, and Google Hotels search queries for property availability and photo auditing.
-   **Lodgify**: All Lodgify API routes have been removed. The database tables (`lodgify_bookings`, `lodgify_property_map`) are preserved for historical data. Storage methods remain for profitability report queries against existing data.
-   **Guesty Open API v1**: Primary listing builder. All Guesty API calls are proxied server-side through `app.all("/api/guesty-proxy/*path")` in `server/routes.ts` — the browser never calls Guesty directly. Token managed with file+memory caching (`/.guesty_token_cache.json`). `client/src/services/guestyService.ts` uses `GUESTY_API_BASE = "/api/guesty-proxy"`. Builder page: `/builder/:propertyId/:step`.
-   **Airbnb Geo-Filtering**: The `/api/airbnb/search` endpoint uses `COMMUNITY_BOUNDS` (SW/NE bounding boxes for all 8 communities) to pass `sw_lat/sw_lng/ne_lat/ne_lng` params to SearchAPI, plus a post-filter step that drops properties outside the box. A "Community area only" badge appears in the Buy-In Tracker UI when results are geo-filtered.
-   **Buy-In Tracker**: Full unit selection workflow — clicking listing cards adds them to selection, a sticky summary card shows buy-in cost / sell rate / estimated profit, and "Record Buy-Ins" creates database records when all required units are selected.