import pg from "pg";

// Unit-swap hydration can spend minutes on remote scrapers. Keep those
// cross-instance locks off the application's default query pool, and bound the
// dedicated pool so normal requests always retain their database capacity.
const unitSwapWriteLockPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  application_name: "unit-swap-write-locks",
});
unitSwapWriteLockPool.on("error", (error) => {
  console.error(`[unit-swap-lock] pool error: ${error?.message ?? error}`);
});

const UNIT_SWAP_WRITE_LOCK_NAMESPACE = 0x555357;

export async function withUnitSwapPropertyWriteLock<T>(
  propertyId: number,
  work: () => Promise<T>,
): Promise<T> {
  const client = await unitSwapWriteLockPool.connect();
  let acquired = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::int, $2::int)", [
      UNIT_SWAP_WRITE_LOCK_NAMESPACE,
      propertyId | 0,
    ]);
    acquired = true;
    return await work();
  } finally {
    try {
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [
          UNIT_SWAP_WRITE_LOCK_NAMESPACE,
          propertyId | 0,
        ]).catch((error) => {
          console.warn(`[unit-swap-lock] property ${propertyId}: unlock failed: ${error?.message ?? error}`);
        });
      }
    } finally {
      client.release();
    }
  }
}
