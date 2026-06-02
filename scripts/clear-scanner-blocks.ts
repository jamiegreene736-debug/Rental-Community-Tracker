import { dbPool } from "../server/db";
import { clearTrackedScannerBlocks } from "../server/scanner-block-cleanup";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const result = await clearTrackedScannerBlocks({ dryRun });
  console.log(
    `[clear-scanner-blocks] ${dryRun ? "dry run: " : ""}processed ${result.total} active tracked scanner block(s) across ${result.properties} propert${result.properties === 1 ? "y" : "ies"}`,
  );
  console.log(JSON.stringify(result, null, 2));

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(`[clear-scanner-blocks] ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbPool.end().catch(() => undefined);
  });
