# replit.md

## Overview

Property research dashboard for thevacationrentalexperts.com. Displays all 35 cataloged vacation rental properties in a sortable, filterable table showing property names, resort communities, bedroom counts, guest capacity, low/high pricing ranges, and multi-unit indicators. Built with React frontend and Express backend using TypeScript.

## Recent Changes

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
- **Storage Layer:** Abstracted through an `IStorage` interface in `server/storage.ts`. Currently uses in-memory storage (`MemStorage`), but the interface is designed to be swapped for database-backed storage.
- **Static Serving:** In production, the server serves the built Vite output from `dist/public`. In development, Vite's dev server middleware is used with HMR.

### Database
- **ORM:** Drizzle ORM with PostgreSQL dialect
- **Schema Location:** `shared/schema.ts` — defines tables and Zod validation schemas using `drizzle-zod`
- **Current Schema:** A `users` table with `id` (UUID primary key), `username`, and `password` fields
- **Schema Push:** Use `npm run db:push` (runs `drizzle-kit push`) to sync schema to the database
- **Connection:** Requires `DATABASE_URL` environment variable pointing to a PostgreSQL database
- **Note:** The current runtime storage uses in-memory `MemStorage`. When connecting to Postgres, replace `MemStorage` with a Drizzle-backed implementation of `IStorage`.

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