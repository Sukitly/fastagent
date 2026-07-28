import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SYNC_ATTEMPTS,
  WAKE_ALARM_PATH,
  type WakeAlarmRequest,
  createWakeAlarmSink,
  readWakeAlarmUrl,
  reconcileWakeAlarms,
  rememberWakeAlarmUrl,
  toAlarms,
} from "../src/schedule/wake-alarm.ts";
import { type Wakeup, addWakeup, removeWakeup, setWakeupsSink, takeFirstDueWakeup } from "../src/schedule/wakeups.ts";

const freshRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-wake-alarm-"));

afterEach(() => {
  setWakeupsSink(undefined);
  vi.restoreAllMocks();
});

/** A fetch fake that records calls and resolves 200. */
function fakeFetch(status = 200) {
  const calls: { url: string; body: WakeAlarmRequest }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as WakeAlarmRequest });
    return new Response("ok", { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("schedule/wake-alarm: the URL store", () => {
  it("remembers the forwarder URL (write-if-changed) and reads it back", async () => {
    const root = await freshRoot();
    expect(readWakeAlarmUrl(root)).toBeUndefined();
    rememberWakeAlarmUrl(root, "https://fn.on.aws/");
    expect(readWakeAlarmUrl(root)).toBe("https://fn.on.aws/");
    rememberWakeAlarmUrl(root, "https://fn.on.aws/"); // unchanged — no churn (no throw is the contract)
    expect(readWakeAlarmUrl(root)).toBe("https://fn.on.aws/");
  });
});

describe("schedule/wake-alarm: the sink", () => {
  it("POSTs the pending set (declarative reconcile) to the reserved path with the secret", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws/");
    const { impl, calls } = fakeFetch();
    const sink = createWakeAlarmSink({
      secret: "s3cret",
      fetchImpl: impl,
      now: () => new Date("2026-07-28T09:00:00Z"),
    });
    const pending: Wakeup[] = [
      { id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" },
      { id: "b", session: "s", prompt: "q", fireAt: "2026-07-28T11:00:00.000Z", cron: "0 * * * *" },
    ];
    sink(root, pending);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`https://fn.on.aws${WAKE_ALARM_PATH}`); // trailing slash normalized
    expect(calls[0]!.body).toEqual({
      secret: "s3cret",
      alarms: [
        { id: "a", at: "2026-07-28T10:00:00.000Z" },
        { id: "b", at: "2026-07-28T11:00:00.000Z" },
      ],
    });
  });

  it("filters already-due alarms (the awake box handles those) and skips an all-due/empty set", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    const { impl, calls } = fakeFetch();
    const sink = createWakeAlarmSink({ secret: "x", fetchImpl: impl, now: () => new Date("2026-07-28T10:00:00Z") });
    sink(root, [
      { id: "due", session: "s", prompt: "p", fireAt: "2026-07-28T09:59:00.000Z" }, // past — filtered
      { id: "future", session: "s", prompt: "p", fireAt: "2026-07-28T10:30:00.000Z" },
    ]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.alarms).toEqual([{ id: "future", at: "2026-07-28T10:30:00.000Z" }]);
    sink(root, [{ id: "due", session: "s", prompt: "p", fireAt: "2026-07-28T09:59:00.000Z" }]); // nothing future
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1); // no empty POST — deletion is lazy by design
  });

  it("retries a failed sync with backoff (counted as in-flight work), then gives up loudly", async () => {
    const { activeWork } = await import("../src/channels/busy.ts");
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    const base = activeWork();
    let sawBusy = false;
    const attempts: number[] = [];
    const failing = vi.fn(async () => {
      attempts.push(Date.now());
      sawBusy = sawBusy || activeWork() > base; // the retry window counts as in-flight work
      return new Response("boom", { status: 500 });
    });
    const sink = createWakeAlarmSink({
      secret: "x",
      fetchImpl: failing as unknown as typeof fetch,
      now: () => new Date("2026-07-28T09:00:00Z"),
      delay: async () => {}, // no real waiting in tests
    });
    sink(root, [{ id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" }]);
    await vi.waitFor(() => expect(attempts.length).toBe(MAX_SYNC_ATTEMPTS));
    expect(sawBusy).toBe(true);
    await vi.waitFor(() => expect(activeWork()).toBe(base)); // released after giving up
  });

  it("is a no-op (warned, not thrown) before the first envelope delivered the URL", async () => {
    const root = await freshRoot();
    const { impl, calls } = fakeFetch();
    createWakeAlarmSink({ secret: "x", fetchImpl: impl })(root, []);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });

  it("wired via setWakeupsSink: every store mutation re-mirrors — add, claim-advance, remove", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    const { impl, calls } = fakeFetch();
    const now = new Date("2026-07-28T10:00:00Z");
    setWakeupsSink(createWakeAlarmSink({ secret: "x", fetchImpl: impl, now: () => now }));

    // The one-shot fires LATER than the recurring's first slot, so the claim below takes the recurring.
    const added = addWakeup(root, { session: "s", prompt: "p", fireAt: new Date("2026-07-28T13:00:00Z") }, now);
    expect(added.ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.alarms).toHaveLength(1);

    // A recurring wake's CLAIM advances fireAt in place — the save re-arms its alarm for the next slot.
    const rec = addWakeup(root, { session: "s", prompt: "r", cron: "0 * * * *", tz: "UTC" }, now);
    expect(rec.ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    takeFirstDueWakeup(root, new Date("2026-07-28T11:00:01Z")); // claims the recurring occurrence
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const rearmed = calls[2]!.body.alarms.find((a) => a.id === (rec as { id: string }).id);
    expect(rearmed?.at).toBe("2026-07-28T12:00:00.000Z"); // advanced to the NEXT cron instant

    // unwake mirrors too (the cancelled alarm goes stray and self-deletes on fire — lazy by design).
    removeWakeup(root, (added as { id: string }).id);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
  });

  it("a failing sink never breaks the store write", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    setWakeupsSink(() => {
      throw new Error("boom");
    });
    const added = addWakeup(
      root,
      { session: "s", prompt: "p", fireAt: new Date("2026-07-28T10:30:00Z") },
      new Date("2026-07-28T10:00:00Z"),
    );
    expect(added.ok).toBe(true); // the write survived the sink throw
  });
});

describe("schedule/wake-alarm: boot reconcile", () => {
  it("re-mirrors pending wake-ups once at start; silent when none", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    addWakeup(
      root,
      { session: "s", prompt: "p", fireAt: new Date("2099-07-28T10:30:00Z") }, // far future — survives the due filter under the real clock
      new Date("2099-07-28T10:00:00Z"),
    );
    const { impl, calls } = fakeFetch();
    reconcileWakeAlarms(root, createWakeAlarmSink({ secret: "x", fetchImpl: impl }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const empty = await freshRoot();
    const quiet = fakeFetch();
    reconcileWakeAlarms(empty, createWakeAlarmSink({ secret: "x", fetchImpl: quiet.impl }));
    await new Promise((r) => setTimeout(r, 20));
    expect(quiet.calls).toHaveLength(0);
  });
});

describe("schedule/wake-alarm: helpers", () => {
  it("toAlarms mirrors id + fireAt for FUTURE entries only", () => {
    const now = new Date("2026-07-28T10:00:00Z");
    const entries: Wakeup[] = [
      { id: "future", session: "s", prompt: "p", fireAt: "2026-07-28T11:00:00.000Z" },
      { id: "due", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:01.000Z" }, // inside the due margin
    ];
    expect(toAlarms(entries, now)).toEqual([{ id: "future", at: "2026-07-28T11:00:00.000Z" }]);
  });
});
