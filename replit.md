# replit.md

## Overview

This project is a property research dashboard designed for thevacationrentalexperts.com. Its primary purpose is to display and manage information for 35 cataloged vacation rental properties. Key functionalities include a sortable and filterable table showing property names, resort communities, bedroom counts, guest capacity, pricing ranges, and multi-unit indicators. Beyond the core dashboard, the project offers advanced tools for property management, including an Availability Scanner to identify and block unrentable inventory, a Photo Audit tool to manage and verify property photos, and a Buy-In Tracker for monitoring Airbnb purchases and profitability. It also facilitates the preparation of property data for integration with Lodgify, a property management system. The system aims to streamline property research, inventory management, and marketing efforts for vacation rental experts.

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
- **Schema**: Defined in `shared/schema.ts`, including tables for `users`, `buy_ins`, `lodgify_bookings`, `scanner_runs`, and `availability_scans`.
- **Connection**: Requires `DATABASE_URL` environment variable.

### Key Design Decisions
1.  **Shared schema**: Type-safe communication between client and server via `shared/` directory.
2.  **Storage interface pattern**: `IStorage` interface decouples business logic from the data layer.
3.  **API request helper**: `client/src/lib/queryClient.ts` provides `apiRequest()` and `getQueryFn()` for consistent API interaction.

### Feature Specifications
-   **Dashboard**: Displays 35 vacation rental properties with sortable and filterable data (name, community, bedrooms, capacity, pricing, multi-unit indicator).
-   **Lodgify Preparation**: Dedicated pages (`/lodgify-prep/:id`) for each multi-unit property with tools for generating titles, descriptions, amenity checklists, ordered photo downloads, and sync status checking with Lodgify. Includes combined descriptions for all units.
-   **Buy-In Tracker & Profitability Dashboard**: Tracks Airbnb buy-in purchases, syncs Lodgify guest reservations, and provides profitability reports (`/buy-in-tracker`).
-   **Real-time Buy-In Search**: Searches Airbnb, VRBO, and Google Hotels for cheapest available units based on property, dates, and bedroom configuration.
-   **Photo Audit**: Analyzes property photos, identifies unit numbers, flags potential VRBO conflicts, and validates community photo folders (`/photo-audit`).
-   **Availability Scanner**: Scans Airbnb and VRBO/Google Hotels for listing availability, automatically creating blackout blocks on Lodgify calendar for unrentable weeks (`/availability-scanner`).
-   **Community Photo Finder**: Searches Google Images for community-specific photos, filters irrelevant images, and allows direct saving to project folders (`/community-photo-finder`).

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
-   **Lodgify API**: Integrates for property data synchronization, availability blocking, and booking information.