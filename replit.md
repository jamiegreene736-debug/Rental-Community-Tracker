# replit.md

## Overview

Property research dashboard for thevacationrentalexperts.com. Displays all 35 cataloged vacation rental properties in a sortable, filterable table showing property names, resort communities, bedroom counts, guest capacity, low/high pricing ranges, and multi-unit indicators. Built with React frontend and Express backend using TypeScript.

## Recent Changes

- **Mar 5, 2026**: Built Photo Audit page (`/photo-audit`). Analyzes all property photo sources client-side: extracts unit numbers from photo folder names, flags units whose photos may also be listed on VRBO by other management companies, validates community photo folders match property complex names. Features: summary cards (total units, units needing check, stock photos, generic names, community mismatches), per-unit "Check VRBO" buttons that search Google via SearchAPI.io for VRBO listings of the same unit number, "Check All" batch mode with rate limiting, color-coded results (green=safe, amber=found on VRBO, red=conflict with other management company). Pili Mai properties (32, 33) updated from Kiahuna Plantation photos to dedicated stock photos in `community-pili-mai`, `pili-mai-unit-a`, `pili-mai-unit-b` folders. Backend: `GET /api/photo-audit/check-vrbo?unitNumber=&complexName=` searches Google for VRBO conflicts. Navigation: "Photo Audit" button on dashboard.
- **Feb 24, 2026**: Expanded buy-in search to multi-platform: Airbnb (via SearchAPI.io airbnb engine with structured pricing), VRBO & Others (via SearchAPI.io google_hotels engine with `property_type=vacation_rental`), and Suite Paradise (filtered from google_hotels results). All platforms searched in parallel. Results displayed with platform tabs showing result counts. Airbnb has full structured pricing with profitability analysis; VRBO/Others show per-night pricing from Google's vacation rental aggregation (includes VRBO, Booking.com, and other platforms). API: `GET /api/vrbo/search?propertyId=&checkIn=&checkOut=` returns both VRBO and Suite Paradise results using google_hotels engine with bedroom filters and lowest-price sorting. Properties 32 & 33 updated from "Kiahuna Plantation" to "Pili Mai" across all data files.
- **Feb 17, 2026**: Redesigned "Find Best Buy-Ins" to use real-time Airbnb search. Select a property, enter guest travel dates, and the system searches Airbnb via SearchAPI.io for the cheapest available units in the same resort community matching the needed bedroom configuration. Shows real Airbnb listings with prices, ratings, images, and direct "Book on Airbnb" links (dates pre-filled). Results grouped by bedroom type needed (e.g., "2x 3-Bedroom Units Needed"). API: `GET /api/airbnb/search?propertyId=&checkIn=&checkOut=` proxies SearchAPI.io Airbnb engine. Backend maps property IDs to community search locations and unit bedroom needs. Requires `SEARCHAPI_API_KEY` secret.
- **Feb 17, 2026**: Built Buy-In Tracker & Profitability Dashboard (`/buy-in-tracker`). Features: Record Airbnb buy-in purchases with property/unit selection, suggested buy-in rates from pricing data, check-in/check-out dates, cost tracking, Airbnb confirmation numbers. Lodgify booking sync pulls guest reservations (Booking.com, VRBO) from Lodgify API v2. Profitability reports tab shows total buy-in cost vs revenue, profit margins, and monthly breakdown. Database tables: `buy_ins` and `lodgify_bookings` in PostgreSQL via Drizzle ORM. Storage layer migrated from MemStorage to DatabaseStorage. API endpoints: `GET/POST/PATCH/DELETE /api/buy-ins`, `POST /api/lodgify/sync-bookings`, `GET /api/lodgify/bookings`, `GET /api/reports/summary`, `GET /api/reports/monthly`. Navigation: "Buy-In Tracker" button on dashboard, "Buy In" button on unit builder pages.
- **Feb 16, 2026**: Added community/resort amenity photos for all 21 multi-unit properties. 52 stock photos across 10 resort communities (Regency at Poipu Kai, Kekaha Estate, Keauhou Estates, Mauna Kai, Kaha Lani, Lae Nani, Poipu Beachside, Kaiulani, Poipu Oceanfront, Kiahuna Plantation). Photos stored in `client/public/photos/community-{resort-name}/` folders. Each property has `communityPhotos` array with position ("beginning"/"end") and `communityPhotoFolder` field. Lodgify prep page shows community photos section with ordered preview. "Download All Photos (ZIP)" button generates combined zip with community photos at beginning, unit photos in middle, community photos at end, all sequentially numbered. Backend zip-multi endpoint updated to support `communityFolder`, `beginningPhotos`, `endPhotos` query params for ordered zip generation.
- **Feb 14, 2026**: Added queen sleeper sofas to ~22 condo-style units across all multi-unit properties. Updated maxGuests (+2 per sofa bed) and descriptions. Added `combinedDescription` field to PropertyUnitBuilder - each property now has one unified description for Lodgify (describes all units together). Lodgify prep page shows combined description as a single copy field; removed per-unit description tabs from unit cards. Updated step-by-step entry guide to reference combined description.
- **Feb 13, 2026**: Added "Prepare for Lodgify" workflow system. Each multi-unit property now has a dedicated Lodgify prep page (`/lodgify-prep/:id`) with one-click copy buttons for titles/descriptions, amenities checklists with Lodgify category names, ordered photo downloads as individual JPGs (File System Access API with fallback), Lodgify sync status checker via API proxy, and step-by-step entry guide. Photo downloads now save to folder (no zip). Backend route `GET /api/lodgify/properties` proxies Lodgify API for sync checking. Navigation added from dashboard and unit builder pages.
- **Feb 13, 2026**: Built property research dashboard with all 35 properties from thevacationrentalexperts.com. Data includes community assignments (Poipu Kai, Princeville, Kekaha, Hanalei, Keauhou, etc.), pricing, and multi-unit designations. Frontend-only data (no database needed).

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Project Structure
- **`client/`** — React single-page application (SPA)
- **`server/`** — Express API server
- **`shared/`** — Shared TypeScript types and database schema (used by both client and server)
- **`migrations/`** — Drizzle ORM database migrations
- **`script/`** — Build scripts

### Frontend Architecture
- **Framework:** React with TypeScript
- **Routing:** Wouter (lightweight client-side router)
- **State/Data Fetching:** TanStack React Query for server state management
- **UI Components:** shadcn/ui component library (new-york style) built on Radix UI primitives
- **Styling:** Tailwind CSS with CSS custom properties for theming (supports light/dark mode)
- **Build Tool:** Vite
- **Path Aliases:** `@/` maps to `client/src/`, `@shared/` maps to `shared/`

### Backend Architecture
- **Framework:** Express 5 on Node.js
- **Language:** TypeScript, executed with `tsx`
- **API Pattern:** All API routes should be prefixed with `/api`
- **Storage Layer:** Abstracted through an `IStorage` interface in `server/storage.ts`. Uses `DatabaseStorage` backed by PostgreSQL via Drizzle ORM for buy-ins, bookings, and user data.
- **Static Serving:** In production, the server serves the built Vite output from `dist/public`. In development, Vite's dev server middleware is used with HMR.

### Database
- **ORM:** Drizzle ORM with PostgreSQL dialect
- **Schema Location:** `shared/schema.ts` — defines tables and Zod validation schemas using `drizzle-zod`
- **Current Schema:** `users` table (UUID PK), `buy_ins` table (serial PK - Airbnb buy-in purchases with property/unit IDs, dates, costs, confirmations), `lodgify_bookings` table (serial PK - synced guest reservations from Lodgify with guest info, dates, amounts, source)
- **Schema Push:** Use `npm run db:push` (runs `drizzle-kit push`) to sync schema to the database
- **Connection:** Requires `DATABASE_URL` environment variable pointing to a PostgreSQL database
- **Note:** Storage uses `DatabaseStorage` class backed by PostgreSQL/Drizzle. Connection via `server/db.ts`.

### Build Process
- **Development:** `npm run dev` — runs the Express server with tsx, Vite dev middleware handles frontend with HMR
- **Production Build:** `npm run build` — Vite builds the client to `dist/public`, esbuild bundles the server to `dist/index.cjs`
- **Production Start:** `npm start` — runs the bundled server from `dist/index.cjs`

### Key Design Decisions
1. **Shared schema between client and server:** The `shared/` directory allows type-safe communication. Drizzle schemas generate both database types and Zod validation schemas.
2. **Storage interface pattern:** `IStorage` interface in `server/storage.ts` decouples business logic from the data layer, making it easy to swap between in-memory and database-backed storage.
3. **API request helper:** `client/src/lib/queryClient.ts` provides `apiRequest()` for mutations and `getQueryFn()` for queries, with built-in error handling and 401 behavior configuration.
4. **Monorepo without workspaces:** Single `package.json` manages all dependencies for both client and server.

## External Dependencies

### Database
- **PostgreSQL** — Primary database, connected via `DATABASE_URL` environment variable
- **Drizzle ORM** — Database toolkit for type-safe queries and schema management
- **connect-pg-simple** — PostgreSQL session store (available for session management)

### Frontend Libraries
- **Radix UI** — Headless UI primitives (accordion, dialog, dropdown, tabs, tooltip, etc.)
- **shadcn/ui** — Pre-styled component library built on Radix
- **TanStack React Query** — Async state management
- **Embla Carousel** — Carousel component
- **React Hook Form + Zod** — Form handling and validation
- **Recharts** — Charting library
- **Lucide React** — Icon library
- **date-fns** — Date utility library
- **Wouter** — Client-side routing
- **vaul** — Drawer component

### Build Tools
- **Vite** — Frontend bundler and dev server
- **esbuild** — Server bundler for production
- **tsx** — TypeScript execution for development
- **Tailwind CSS + PostCSS** — Utility-first CSS framework

### Replit-Specific
- **@replit/vite-plugin-runtime-error-modal** — Runtime error overlay in development
- **@replit/vite-plugin-cartographer** — Dev tooling (dev only)
- **@replit/vite-plugin-dev-banner** — Dev banner (dev only)