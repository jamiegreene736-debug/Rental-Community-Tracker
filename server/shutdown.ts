// ── shared graceful-shutdown coordinator ────────────────────────────────────
// Railway sends SIGTERM before replacing the process on EVERY deploy. Multiple
// modules (auto-fill-job.ts, bulk-auto-fill-job.ts) need a last-gasp Postgres
// stamp so in-flight searches read as "interrupted" instead of vanishing — but
// each registering its own process.once("SIGTERM") handler would race the
// others' async writes with its own process.exit(). This module owns the ONE
// handler: every registered task runs (Promise.allSettled), then we exit.
//
// NOTE: registering any SIGTERM handler disables Node's default immediate
// termination, so the exit() here is mandatory. The 2.5s cap keeps a hung DB
// from stalling a deploy; tasks must be fast best-effort stamps, not cleanup
// work. SIGKILL gets no window at all — the durable "running" markers written
// at job start are the backstop that makes even that case detectable on boot.
type ShutdownTask = () => Promise<unknown>;

const tasks: ShutdownTask[] = [];
let handlerInstalled = false;

export function onShutdown(task: ShutdownTask): void {
  tasks.push(task);
  if (handlerInstalled) return;
  handlerInstalled = true;
  process.once("SIGTERM", () => {
    const exit = () => process.exit(0);
    void Promise.allSettled(tasks.map((t) => t().catch(() => undefined))).then(exit, exit);
    setTimeout(exit, 2500).unref();
  });
}
