import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  // Runtime schema maintenance owns these additive virtual-staging tables.
  // Their definitions live outside the desired push schema; these filters also
  // exclude the live tables from introspection so production boot neither asks
  // an interactive create/rename question nor proposes dropping them later.
  tablesFilter: [
    "!photo_original_assets",
    "!virtual_staging_jobs",
    "!virtual_staging_candidates",
  ],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
