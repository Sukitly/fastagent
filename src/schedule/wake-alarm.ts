/**
 * Wake ALARMS for the AgentCore deployment: the piece that makes the agent's self-scheduled
 * wake-ups (`wake`) reliable on a host with NO resident process. The mechanism, end to end:
 *
 *   wake written → wakeups store save → the SINK here → POST the full pending set to the
 *   forwarder's reserved path → the forwarder (which has the AWS SDK + an IAM role) mirrors each
 *   pending wake-up into a ONE-SHOT EventBridge schedule (`at(fireAt)`, self-deleting) → at the
 *   instant, EventBridge pokes the forwarder → InvokeAgentRuntime wakes the container → the boot /
 *   30s wake pump finds the due entry and fires it (the existing overdue catch-up — no new fire
 *   path). A RECURRING wake re-arms itself: its claim advances `fireAt` in the store, which is a
 *   save, which re-runs this sink, which re-upserts its alarm for the next occurrence.
 *
 * The container itself never calls AWS (no SDK dependency, no SigV4, no credential chain): it only
 * POSTs to its own deployment's public forwarder URL, authenticated by a shared secret
 * (`FASTAGENT_WAKE_SECRET`, a CloudFormation NoEcho parameter both sides receive). The URL is not
 * baked anywhere — the forwarder INJECTS it into every envelope it forwards (it resolves its own
 * Function URL at cold start), and the adapter persists it here; every wake write happens inside a
 * turn, and every ingress turn arrived through an envelope, so the URL is always known by then.
 *
 * Reconciliation is DECLARATIVE (the full pending set travels each time) and deletion is lazy: a
 * cancelled wake-up's alarm still fires its poke, finds nothing due, and self-deletes — a harmless
 * wasted wake-up of the box, traded for never needing list/delete choreography.
 */
import { readFileSync } from "node:fs";
import { log } from "../log.ts";
import { scheduleFile, writeScheduleFile } from "./state.ts";
import type { Wakeup } from "./wakeups.ts";
import { listWakeups } from "./wakeups.ts";

/** The forwarder's reserved wake-alarm path — never forwarded to channel routes. */
export const WAKE_ALARM_PATH = "/__fastagent/wake-alarm";

/** One desired alarm: mirror of a pending wake-up (id names the EventBridge schedule; at = fireAt). */
export interface WakeAlarm {
  id: string;
  at: string;
}

/** The wire shape the sink POSTs to {@link WAKE_ALARM_PATH} (the forwarder validates `secret`). */
export interface WakeAlarmRequest {
  secret: string;
  alarms: WakeAlarm[];
}

const URL_FILE = "wake-alarm-url";

/**
 * Persist the forwarder URL the adapter saw in an envelope (write-if-changed — envelopes arrive on
 * every turn, the file should not churn). Durable under <stateRoot>/schedule/ so a freshly booted
 * container whose FIRST action is a wake fire (recurring advance → save → sink) knows the URL
 * before any envelope of its own has arrived.
 */
export function rememberWakeAlarmUrl(stateRoot: string, url: string): void {
  if (readWakeAlarmUrl(stateRoot) === url) return;
  writeScheduleFile(scheduleFile(stateRoot, URL_FILE), { url });
}

/** The persisted forwarder URL, or undefined before the first envelope ever seen. */
export function readWakeAlarmUrl(stateRoot: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(scheduleFile(stateRoot, URL_FILE), "utf8")) as { url?: unknown };
    return typeof v.url === "string" ? v.url : undefined;
  } catch {
    return undefined; // absent/corrupt — the next envelope rewrites it
  }
}

/** Pending wake-ups → the desired alarm set. */
export function toAlarms(pending: Wakeup[]): WakeAlarm[] {
  return pending.map((w) => ({ id: w.id, at: w.fireAt }));
}

/**
 * Build the wakeups sink for an AgentCore deployment (registered via `setWakeupsSink` by `start`
 * when `FASTAGENT_AGENTCORE=1` + `FASTAGENT_WAKE_SECRET` are present). Fire-and-forget by contract:
 * failures are logged, never thrown — a broken alarm degrades to the pre-alarm behavior (the wake
 * still fires on the next time the box happens to be awake), it must never break the store write.
 */
export function createWakeAlarmSink(options: {
  secret: string;
  fetchImpl?: typeof fetch;
}): (stateRoot: string, pending: Wakeup[]) => void {
  const { secret, fetchImpl = fetch } = options;
  return (stateRoot, pending) => {
    const url = readWakeAlarmUrl(stateRoot);
    if (!url) {
      // First-ever boot before any envelope: nothing to call yet. The wake itself is stored; the
      // alarm catches up on the next store mutation after an envelope has arrived.
      log.warn("[schedule] wake alarm skipped — forwarder URL not seen yet (it arrives with the first envelope)");
      return;
    }
    const body: WakeAlarmRequest = { secret, alarms: toAlarms(pending) };
    void fetchImpl(`${url.replace(/\/$/, "")}${WAKE_ALARM_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(
      (res) => {
        if (!res.ok) log.error(`[schedule] wake alarm sync failed: HTTP ${res.status}`);
      },
      (e) => log.error(`[schedule] wake alarm sync failed: ${String(e)}`),
    );
  };
}

/**
 * One boot-time reconcile: pending wake-ups may exist while their alarms were lost (a deploy
 * replaced the forwarder, a sink call failed) — re-mirror the current set once at start.
 */
export function reconcileWakeAlarms(stateRoot: string, sink: (stateRoot: string, pending: Wakeup[]) => void): void {
  const pending = listWakeups(stateRoot);
  if (pending.length > 0) sink(stateRoot, pending);
}
