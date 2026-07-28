/**
 * The scheduler: a time-trigger that fires the agent on each schedule's cron. SINGLE-PROCESS (like all
 * fastagent state today) — a deployment with schedules must keep one machine running, since cron has no
 * external wake-up (`deploy` enforces that). Started/stopped by the serve path (dev/start).
 *
 * Fire model:
 *  - **stable session per schedule** (`schedule:<name>`), so a schedule's turns share one continuing
 *    conversation persisted by the core session store; the scheduler is ZERO-touch on session storage.
 *  - **output is the agent's tools' job** — the scheduler only fires and logs the outcome.
 *  - **durability = catch up ONCE** (`state.ts`): on start, if the next instant after the last fire is
 *    already past (the process was down across it), fire once and advance — not once per missed slot.
 *    lastFired is claimed BEFORE the invoke (at-most-once per slot: a crash mid-turn won't re-fire it;
 *    "a digest late once" beats "twice"). Strict at-least-once (a per-turn WAL) is a later tier.
 */
import { type Agent, SESSION_BUSY_CODE } from "../agent.ts";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { appendRun } from "./audit.ts";
import { nextRun } from "./cron.ts";
import type { LoadedSchedule } from "./schedule.ts";
import { loadFires, saveFires } from "./state.ts";
import { deferWakeup, takeFirstDueWakeup } from "./wakeups.ts";

/** A schedule's turns share this stable session — a continuing conversation, like the telegram channel's
 *  per-chat session. Derived at RUNTIME from the name (never an authored field). */
export function scheduleSession(name: string): string {
  return `schedule:${name}`;
}

export interface Scheduler {
  /** Arm every schedule (catching up an overdue one once). Idempotent-ish: call once per process. */
  start(): void;
  /** Clear all armed timers. Does NOT drain an in-flight fire (SIGTERM exits mid-turn by design; the
   *  interrupted turn is not re-fired — lastFired was already claimed). A catch-up fire in flight has NO
   *  timer entry to clear either (the overdue branch fires directly, without arming), so `stop()` simply
   *  lets it run out or be cut by process exit — same non-drain, and its claim is already persisted. */
  stop(): void;
}

export interface SchedulerOptions {
  agent: Agent;
  stateRoot: string;
  schedules: LoadedSchedule[];
  /** Injectable clock for tests; defaults to the wall clock. */
  now?: () => Date;
  /** External-clock mode (the AgentCore deployment): cron slots are DELIVERED by an external
   *  scheduler through the serving surface ({@link fireScheduleOnce} with a `slot`), so `start()`
   *  arms NO cron timers and does NO boot catch-up — delivery, including for instants that passed
   *  while this process was down, is the external clock's job; the adapter's slot-idempotent claim
   *  is the duplicate guard. The wake-up poll still runs (degraded: it only fires while the
   *  process happens to be awake — the deploy path warns about this). */
  externalClock?: boolean;
}

// A single setTimeout maxes out at ~24.8 days and drifts over long sleeps; cap each wait so a long
// interval (or a suspended machine) re-checks against the wall clock rather than firing wildly early/late.
const MAX_WAIT_MS = 6 * 60 * 60 * 1000; // 6h
// How often to poll the agent's self-scheduled wake-ups (wakeups.ts). A wake fires within this of its
// due time — fine for "wake me in N minutes"; cheap (reads a small JSON, writes only when one is due).
const WAKEUP_POLL_MS = 30 * 1000;

/** Drive ONE turn (a cron fire or a wake-up) and log its outcome. Total — never throws (its callers are
 *  void-scheduled). Output is the agent's tools' job; this only fires and logs. Returns the turn's audit
 *  material — `failed` (details, if it failed), the accumulated `reply` text, `ms` — plus `busy`: whether
 *  it failed specifically because the session was BUSY (the turn never started) — the ONLY replay-safe
 *  reason to re-fire a wake-up; every other outcome is terminal (side effects may have run). Module-level
 *  (not a scheduler closure) so {@link fireScheduleOnce} — the external-clock fire path — shares it. */
async function runTurn(
  agent: Agent,
  label: string,
  session: string,
  prompt: string,
): Promise<{ busy: boolean; failed?: string; reply: string; ms: number }> {
  const startedAt = Date.now();
  log.info(`[schedule] ${label} firing (session=${session})`);
  try {
    let failed: string | undefined;
    let busy = false;
    let reply = "";
    for await (const e of agent.invoke({ session }, { text: prompt })) {
      if (e.type === "text") reply += e.delta;
      if (e.type === "failed") {
        failed = e.details;
        busy = e.code === SESSION_BUSY_CODE; // structured (SPEC §8), not a details-text match
      }
    }
    if (failed) log.error(`[schedule] ${label} failed (${Date.now() - startedAt}ms): ${failed}`);
    else log.info(`[schedule] ${label} completed (${Date.now() - startedAt}ms)`);
    return { busy: failed !== undefined && busy, failed, reply, ms: Date.now() - startedAt };
  } catch (e) {
    // invoke shouldn't throw (SPEC MUST 2 turns failures into events), but stay total regardless. A throw
    // is not the busy case, so don't defer on it.
    log.error(`[schedule] ${label} errored (${Date.now() - startedAt}ms): ${String(e)}`);
    return { busy: false, failed: String(e), reply: "", ms: Date.now() - startedAt };
  }
}

/** One schedule fire's outcome, for the external caller (the AgentCore adapter returns it to the
 *  triggering clock's logs). The resident scheduler ignores it beyond completion. */
export interface ScheduleFireOutcome {
  fired: boolean;
  /** Set when a slot-keyed fire was skipped because that slot (or a later one) was already claimed. */
  skippedReason?: string;
  failed?: string;
  ms: number;
}

/**
 * Fire ONE schedule's turn: claim (persist lastFired BEFORE invoking, so a crash mid-turn does not
 * re-fire on restart), run, audit. Shared by the resident scheduler's timers and the external-clock
 * serving surface (the AgentCore adapter).
 *
 * `slot` is the external clock's idempotency key — the cron instant this fire is FOR. External
 * delivery (EventBridge-style) is at-least-once, so a duplicate slot must not double-fire: when
 * lastFired ≥ slot the fire is SKIPPED (at-most-once per slot, same trade as the resident claim —
 * "a digest late once" beats "twice"). The resident scheduler omits `slot`: its timers fire each
 * slot exactly once, so the unconditional claim is already correct.
 *
 * A state fault while claiming (loadFires/saveFires — both before the invoke, so nothing ran)
 * THROWS: the resident path catches it at its single skip+audit boundary ({@link createScheduler}'s
 * fireThenReArm — skipping rather than firing unclaimed also avoids an infinite catch-up loop on
 * restart), and the external path lets it surface as a failed request (visible in the clock's logs).
 */
export async function fireScheduleOnce(opts: {
  agent: Agent;
  stateRoot: string;
  schedule: LoadedSchedule;
  slot?: Date;
  now?: () => Date;
}): Promise<ScheduleFireOutcome> {
  const { agent, stateRoot, schedule: s, slot, now = () => new Date() } = opts;
  const fires = loadFires(stateRoot);
  const last = fires[s.name];
  if (slot && last && new Date(last).getTime() >= slot.getTime()) {
    const reason = `slot ${slot.toISOString()} already fired (lastFired=${last})`;
    log.info(`[schedule] ${s.name}: skipping — ${reason}`);
    return { fired: false, skippedReason: reason, ms: 0 };
  }
  fires[s.name] = now().toISOString();
  saveFires(stateRoot, fires);
  const firedAt = now().toISOString();
  const r = await runTurn(agent, s.name, scheduleSession(s.name), s.prompt);
  appendRun(stateRoot, {
    name: s.name,
    session: scheduleSession(s.name),
    firedAt,
    ms: r.ms,
    outcome: r.failed ? "failed" : "completed",
    reply: r.failed ? undefined : r.reply,
    error: r.failed,
  });
  return { fired: true, failed: r.failed, ms: r.ms };
}

export function createScheduler({
  agent,
  stateRoot,
  schedules,
  now = () => new Date(),
  externalClock = false,
}: SchedulerOptions): Scheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let wakeupTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** The resident fire path — the shared claim+run+audit, without a slot (see {@link fireScheduleOnce}). */
  async function fire(s: LoadedSchedule): Promise<void> {
    await fireScheduleOnce({ agent, stateRoot, schedule: s, now });
  }

  /**
   * The woken turn's prompt arrives ENVELOPED: without it the model sees its own instruction as a bare
   * user message — in a chat session it may answer a "user" who said nothing — and it has no way to know
   * the wake-up's id (buried in a long-past tool result), which `unwake` needs. Static cron fires stay raw
   * on purpose: their prompt is the AUTHOR's instruction in a dedicated `schedule:<name>` session, where
   * every turn is a fire and an envelope would only dilute it.
   */
  function wakeEnvelope(w: { id: string; prompt: string; cron?: string; tz?: string }): string {
    const tag = w.cron
      ? `[wake-up ${w.id} fired — YOUR recurring self-scheduled turn (cron "${w.cron}"${w.tz ? ` ${w.tz}` : ""}), not a user message; unwake({ id: "${w.id}" }) stops it]`
      : `[wake-up ${w.id} fired — YOUR self-scheduled turn, not a user message]`;
    return `${tag} ${w.prompt}`;
  }

  /**
   * Fire every due self-scheduled wake-up, ONE at a time (claim → fire → claim next) so a crash loses at
   * most one occurrence. Each fires back into the session it was set in. Busy handling splits by kind: a
   * ONE-SHOT that failed because the session was BUSY (`code: session_busy` — the turn never started; the
   * very case "wake me in 10 min" hits while the user is still chatting) is deferred to the next poll,
   * bounded, because a dropped one-shot has no "next time"; a RECURRING busy occurrence is skipped
   * immediately (its claim already advanced the entry — the next occurrence comes by definition). Any
   * other failure is terminal for that occurrence (the turn ran — re-running risks duplicate side effects).
   */
  async function pollWakeups(): Promise<void> {
    for (;;) {
      if (stopped) break; // stop() must halt an in-flight drain, like it clears the cron timers
      const w = takeFirstDueWakeup(stateRoot, now());
      if (!w) break;
      const label = `wake ${w.id.slice(0, 8)}`;
      const firedAt = now().toISOString();
      // A wake turn runs in the BACKGROUND (no open request tracks it) — count it as in-flight work
      // (busy.ts) so a serving surface that must not idle mid-turn (the AgentCore /ping) sees it.
      const workDone = beginWork();
      const r = await runTurn(agent, label, w.session, wakeEnvelope(w)).finally(workDone);
      // Busy handling differs by kind (busy = the turn never started — replay-safe; every other outcome is
      // terminal for this occurrence, since a turn that DID start may have run side effects). ONE-SHOT: defer (bounded) — it has no "next time", dropping it
      // would lose it forever. RECURRING: the claim already ADVANCED the entry to the next instant (see
      // takeFirstDueWakeup), so a busy occurrence is simply SKIPPED and audited — the next one comes by
      // definition, and never touching the stored entry here is what keeps unwake/cancel race-free.
      let kept = false;
      if (r.busy && !w.cron) {
        kept = deferWakeup(stateRoot, w, new Date(now().getTime() + WAKEUP_POLL_MS));
        if (kept) log.info(`[schedule] ${label}: session busy — retrying next poll`);
        else log.error(`[schedule] ${label}: dropped after too many busy retries`);
      } else if (r.busy && w.cron) {
        log.error(`[schedule] ${label}: occurrence skipped (session busy); next fires per cron`);
      }
      // Audit honesty: `deferred` ONLY when the same occurrence was actually re-scheduled. A busy one-shot
      // dropped at the ceiling, and a busy recurring occurrence (skipped — its recurrence survives), are
      // both FINAL for that occurrence → `failed`.
      appendRun(stateRoot, {
        name: "wake",
        session: w.session,
        firedAt,
        ms: r.ms,
        outcome: r.busy ? (kept ? "deferred" : "failed") : r.failed ? "failed" : "completed",
        reply: r.failed || r.busy ? undefined : r.reply,
        error: r.busy
          ? kept
            ? undefined
            : w.cron
              ? "occurrence skipped (session busy); the recurrence continues"
              : "dropped after too many busy retries"
          : r.failed,
      });
    }
  }

  /** Drain due wake-ups, then chain the next poll AFTER — never overlapping two drains. TOTAL: a state-IO
   *  fault (an unreadable store) is caught + logged and the chain continues, never a crash / a silent stop
   *  (this is `void`-scheduled, so an escaping throw would be an unhandled rejection). */
  async function pumpWakeups(): Promise<void> {
    if (stopped) return;
    try {
      await pollWakeups();
    } catch (e) {
      log.error(`[schedule] wake-up poll failed (continuing next poll): ${String(e)}`);
    }
    if (stopped) return;
    wakeupTimer = setTimeout(() => void pumpWakeups(), WAKEUP_POLL_MS);
  }

  /** Arm a timer for `at`, capped so a long wait re-checks the wall clock instead of trusting one sleep. */
  function arm(s: LoadedSchedule, at: Date): void {
    if (stopped) return;
    const delay = Math.min(Math.max(0, at.getTime() - now().getTime()), MAX_WAIT_MS);
    timers.set(
      s.name,
      setTimeout(() => {
        if (stopped) return;
        if (now().getTime() >= at.getTime()) void fireThenReArm(s);
        else arm(s, at); // woke early (the cap) — keep waiting for the real instant
      }, delay),
    );
  }

  /** Fire, then arm the NEXT run computed from now — so a slow fire never double-fires the same slot and
   *  missed slots collapse to the single catch-up already done. TOTAL, like pumpWakeups: this is
   *  void-scheduled from a timer, so an escaping throw (a state-IO fault while claiming — an unreadable
   *  fires.json, an unpersistable claim) would be an unhandled rejection = the WHOLE service crashing over
   *  one skipped fire. Log it and keep the schedule armed instead; boot-time state faults still fail `start()`
   *  loudly (an operator fixes those before serving). */
  async function fireThenReArm(s: LoadedSchedule): Promise<void> {
    try {
      await fire(s);
    } catch (e) {
      // Audited too (appendRun is total, and runs.jsonl ≠ the broken state file) — a skipped fire must
      // show up in `schedule history`, not only in stderr.
      log.error(`[schedule] ${s.name}: fire failed (skipping this run, schedule stays armed): ${String(e)}`);
      appendRun(stateRoot, {
        name: s.name,
        session: scheduleSession(s.name),
        firedAt: now().toISOString(),
        ms: 0,
        outcome: "failed",
        error: `run skipped — fire failed: ${String(e)}`,
      });
    }
    const due = nextRun(s.cron, s.tz, now());
    if (due) arm(s, due);
  }

  return {
    start() {
      stopped = false;
      // External-clock mode: no cron timers, no boot catch-up — slot delivery (including instants
      // that passed while this process was down) belongs to the external clock; only the wake-up
      // pump below runs. See SchedulerOptions.externalClock.
      const fires = externalClock ? {} : loadFires(stateRoot);
      const current = now();
      for (const s of externalClock ? [] : schedules) {
        // Anchor on the last fire (catch-up basis), or `now` on a first-ever run so a brand-new schedule
        // never back-fires before the process first booted.
        const lastFired = fires[s.name];
        const anchor = lastFired ? new Date(lastFired) : current;
        const due = nextRun(s.cron, s.tz, anchor);
        if (!due) {
          log.warn(`[schedule] ${s.name}: cron "${s.cron}" will never fire again — not armed`);
          continue;
        }
        if (due.getTime() <= current.getTime()) {
          log.info(`[schedule] ${s.name}: catching up a missed run`);
          void fireThenReArm(s); // overdue → fire once, then arm the next
        } else {
          arm(s, due);
        }
      }
      // Self-scheduled wake-ups: drain now (catch any overdue while the process was down), then chain the
      // next poll AFTER this drain finishes — a CHAIN, not setInterval, so a wake turn longer than the poll
      // interval never overlaps two drains (which would break the one-at-a-time claim→fire→claim promise).
      void pumpWakeups();
    },
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (wakeupTimer) clearTimeout(wakeupTimer);
      wakeupTimer = undefined;
    },
  };
}
