/**
 * SHARED process-wide in-flight work signal. Channels ACK a webhook fast and run the turn
 * fire-and-forget on this process's event loop (host/node.ts) — so "is this process busy?" is not
 * derivable from open HTTP requests. The two shared execution primitives (turn-queue chains,
 * task-tracker side tasks) report here; a serving surface that must stay alive while background
 * work runs (the AgentCore adapter's /ping → HealthyBusy) reads it.
 *
 * Deliberately a counter, not a registry: consumers need only "any work in flight?"; keeping the
 * module dependency-free lets both channel primitives import it without cycles.
 */

let inFlight = 0;

/**
 * Mark one unit of background work as started. Returns its completion callback — idempotent, so a
 * caller may safely settle it from multiple cleanup paths (finally + catch) without double-counting.
 */
export function beginWork(): () => void {
  inFlight += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight -= 1;
  };
}

/** How many units of background work are currently in flight (0 = idle). */
export function activeWork(): number {
  return inFlight;
}
