import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "../src/agent.ts";
import {
  type AgentcoreEnvelope,
  MAX_ENVELOPE_BYTES,
  UnknownScheduleError,
  type WebhookReply,
  agentcoreRoutes,
} from "../src/channels/agentcore.ts";
import type { StateSync } from "../src/channels/agentcore-state.ts";
import type { Routes } from "../src/host/node.ts";
import type { ScheduleFireOutcome } from "../src/schedule/scheduler.ts";

/** A fake agent yielding a scripted stream (the invoke-envelope SSE path). */
function scriptedAgent(events: AgentEvent[] = [{ type: "text", delta: "hi" }, { type: "completed" }]): Agent {
  return {
    async *invoke() {
      for (const e of events) yield e;
    },
  };
}

interface AdapterOverrides {
  routes?: Routes;
  agent?: Agent;
  isBusy?: () => boolean;
  fire?: (name: string, slot: Date) => Promise<ScheduleFireOutcome>;
  stateSync?: StateSync;
}

/** A StateSync double: records the lifecycle without touching S3 or the disk. */
function fakeStateSync(over: Partial<StateSync> = {}): StateSync & { seen: string[]; saves: () => number } {
  const seen: string[] = [];
  let saves = 0;
  const base: StateSync = {
    use: (u) => seen.push(u.getUrl),
    ready: async () => {},
    save: () => {
      saves += 1;
    },
    configured: () => seen.length > 0,
    flush: async () => {},
  };
  return Object.assign(base, over, { seen, saves: () => saves });
}

const stateRoot = await mkdtemp(join(tmpdir(), "fa-agentcore-adapter-"));

const adapter = (over: AdapterOverrides = {}): Routes =>
  agentcoreRoutes({
    routes: over.routes ?? {},
    agent: over.agent ?? scriptedAgent(),
    stateRoot,
    isBusy: over.isBusy ?? (() => false),
    fire: over.fire,
    stateSync: over.stateSync,
  });

const post = (routes: Routes, body: string): Promise<Response> | Response =>
  routes["POST /invocations"]!(new Request("http://x/invocations", { method: "POST", body }));

const postEnvelope = (routes: Routes, envelope: AgentcoreEnvelope): Promise<Response> | Response =>
  post(routes, JSON.stringify(envelope));

describe("agentcore adapter: /ping", () => {
  it("reports Healthy when idle and HealthyBusy while background work is in flight", async () => {
    let busy = false;
    const routes = adapter({ isBusy: () => busy });
    const ping = routes["GET /ping"]!;
    expect(await (await ping(new Request("http://x/ping"))).json()).toEqual({ status: "Healthy" });
    busy = true;
    expect(await (await ping(new Request("http://x/ping"))).json()).toEqual({ status: "HealthyBusy" });
  });
});

describe("agentcore adapter: webhook envelope", () => {
  it("reconstructs the original request (method/path/headers/body) and rides the reply back byte-exact", async () => {
    const seen: { method: string; secret: string | null; body: string }[] = [];
    const routes = adapter({
      routes: {
        "POST /telegram": async (req) => {
          seen.push({
            method: req.method,
            secret: req.headers.get("x-telegram-bot-api-secret-token"),
            body: await req.text(),
          });
          return new Response('{"challenge":"pong"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    const res = await postEnvelope(routes, {
      kind: "webhook",
      method: "POST",
      path: "/telegram",
      headers: { "x-telegram-bot-api-secret-token": "s3cret", "content-type": "application/json" },
      bodyB64: Buffer.from('{"update_id":1}').toString("base64"),
    });
    expect(res.status).toBe(200); // transport is ALWAYS 200; the real status rides inside
    const reply = (await res.json()) as WebhookReply;
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(Buffer.from(reply.bodyB64, "base64").toString()).toBe('{"challenge":"pong"}');
    expect(seen).toEqual([{ method: "POST", secret: "s3cret", body: '{"update_id":1}' }]);
  });

  it("carries a non-2xx channel response inside the envelope (transport stays 200)", async () => {
    const routes = adapter({ routes: { "POST /telegram": () => new Response("forbidden\n", { status: 403 }) } });
    const res = await postEnvelope(routes, { kind: "webhook", method: "POST", path: "/telegram" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WebhookReply).status).toBe(403);
  });

  it("an unrouted path rides back as a 404 reply", async () => {
    const res = await postEnvelope(adapter(), { kind: "webhook", method: "POST", path: "/nope" });
    expect(((await res.json()) as WebhookReply).status).toBe(404);
  });

  it("rejects a relative path", async () => {
    const res = await postEnvelope(adapter(), { kind: "webhook", method: "POST", path: "telegram" });
    expect(res.status).toBe(400);
  });

  it("the query string survives the round trip (a channel reading searchParams sees it)", async () => {
    const seen: string[] = [];
    const routes = adapter({
      routes: {
        "GET /hook": (req) => {
          seen.push(new URL(req.url).searchParams.get("code") ?? "(none)");
          return new Response("ok", { status: 200 });
        },
      },
    });
    await postEnvelope(routes, { kind: "webhook", method: "GET", path: "/hook", query: "code=abc&x=1" });
    expect(seen).toEqual(["abc"]);
  });
});

describe("agentcore adapter: schedule-fire envelope", () => {
  const fireEnvelope: AgentcoreEnvelope = { kind: "schedule-fire", name: "job", slot: "2026-07-07T10:00:00Z" };

  it("dispatches to the fire binding with the parsed slot and returns its outcome", async () => {
    const fired: { name: string; slot: string }[] = [];
    const routes = adapter({
      fire: async (name, slot) => {
        fired.push({ name, slot: slot.toISOString() });
        return { fired: true, ms: 5 };
      },
    });
    const res = await postEnvelope(routes, fireEnvelope);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fired: true, ms: 5 });
    expect(fired).toEqual([{ name: "job", slot: "2026-07-07T10:00:00.000Z" }]);
  });

  it("404s when the deployment has no schedules (deploy drift stays visible)", async () => {
    const res = await postEnvelope(adapter(), fireEnvelope);
    expect(res.status).toBe(404);
  });

  it("404s an unknown schedule name (UnknownScheduleError from the binding)", async () => {
    const routes = adapter({
      fire: async (name) => {
        throw new UnknownScheduleError(name);
      },
    });
    const res = await postEnvelope(routes, fireEnvelope);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('unknown schedule "job"');
  });

  it("500s a claim-state fault (fail visibly in the clock's logs)", async () => {
    const routes = adapter({
      fire: async () => {
        throw new Error("fires.json unreadable");
      },
    });
    const res = await postEnvelope(routes, fireEnvelope);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("fires.json unreadable");
  });

  it("a running schedule turn counts as in-flight work (/ping must hold the session)", async () => {
    const { activeWork } = await import("../src/channels/busy.ts");
    const base = activeWork();
    let release: (o: ScheduleFireOutcome) => void = () => {};
    const routes = adapter({ fire: () => new Promise<ScheduleFireOutcome>((r) => (release = r)) });
    const pending = postEnvelope(routes, fireEnvelope) as Promise<Response>;
    await vi.waitFor(() => expect(activeWork()).toBe(base + 1));
    release({ fired: true, ms: 1 });
    await pending;
    expect(activeWork()).toBe(base);
  });

  it("rejects a malformed slot", async () => {
    const res = await postEnvelope(adapter({ fire: async () => ({ fired: true, ms: 0 }) }), {
      kind: "schedule-fire",
      name: "job",
      slot: "not-a-date",
    });
    expect(res.status).toBe(400);
  });
});

describe("agentcore adapter: wake-poke envelope + wake-url capture", () => {
  it("acks a wake-poke (the invocation itself is the payload)", async () => {
    const res = await postEnvelope(adapter(), { kind: "wake-poke" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("persists the forwarder URL ridden on an envelope for the wake-alarm sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-wake-url-"));
    const routes = agentcoreRoutes({
      routes: {},
      agent: scriptedAgent(),
      stateRoot: root,
      isBusy: () => false,
    });
    await routes["POST /invocations"]!(
      new Request("http://x/invocations", {
        method: "POST",
        body: JSON.stringify({ kind: "wake-poke", wake: { url: "https://fn.lambda-url.on.aws/" } }),
      }),
    );
    const { readWakeAlarmUrl } = await import("../src/schedule/wake-alarm.ts");
    expect(readWakeAlarmUrl(root)).toBe("https://fn.lambda-url.on.aws/");
  });
});

describe("agentcore adapter: invoke envelope", () => {
  it("streams the invoke back as SSE", async () => {
    const routes = adapter({ agent: scriptedAgent([{ type: "text", delta: "hello" }, { type: "completed" }]) });
    const res = await postEnvelope(routes, { kind: "invoke", session: "s".repeat(33), text: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain('data: {"type":"text","delta":"hello"}');
    expect(body).toContain('data: {"type":"completed"}');
  });
});

describe("agentcore adapter: envelope validation", () => {
  it("rejects invalid json / a missing kind / an unknown kind", async () => {
    const routes = adapter();
    expect((await post(routes, "{nope")).status).toBe(400);
    expect((await post(routes, '{"no":"kind"}')).status).toBe(400);
    expect((await post(routes, '{"kind":"mystery"}')).status).toBe(400);
  });

  it("caps the envelope body", async () => {
    const routes = adapter();
    const huge = JSON.stringify({
      kind: "webhook",
      method: "POST",
      path: "/x",
      bodyB64: "A".repeat(MAX_ENVELOPE_BYTES),
    });
    expect((await post(routes, huge)).status).toBe(413);
  });
});

describe("agentcore adapter: cross-deploy state", () => {
  const withState = (envelope: AgentcoreEnvelope): AgentcoreEnvelope => ({
    ...envelope,
    state: { getUrl: "https://s3/get", putUrl: "https://s3/put" },
  });

  it("adopts the envelope's URLs and restores BEFORE the request is served", async () => {
    const order: string[] = [];
    const sync = fakeStateSync({
      ready: async () => {
        order.push("restore");
      },
    });
    const routes = adapter({
      stateSync: sync,
      routes: {
        "POST /hook": () => {
          order.push("dispatch");
          return new Response("ok");
        },
      },
    });

    await postEnvelope(routes, withState({ kind: "webhook", method: "POST", path: "/hook" }));

    expect(sync.seen).toEqual(["https://s3/get"]);
    expect(order).toEqual(["restore", "dispatch"]); // never serve from an unrestored state root
  });

  it("a failed restore 503s instead of serving an EMPTY agent (which would then snapshot that emptiness)", async () => {
    const routes = adapter({
      stateSync: fakeStateSync({
        ready: async () => {
          throw new Error("snapshot GET failed: 500");
        },
      }),
      routes: {
        "POST /hook": () => new Response("must not run"),
      },
    });

    const res = await postEnvelope(routes, withState({ kind: "webhook", method: "POST", path: "/hook" }));

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("snapshot GET failed: 500");
  });

  it("snapshots when the envelope leaves nothing in flight, and defers to the idle edge when it does", async () => {
    const idle = fakeStateSync();
    await postEnvelope(adapter({ stateSync: idle, isBusy: () => false }), withState({ kind: "wake-poke" }));
    expect(idle.saves()).toBe(1);

    // Busy = a background turn is still writing; the 0-in-flight edge (busy.ts onIdle) owns that save.
    const busy = fakeStateSync();
    await postEnvelope(adapter({ stateSync: busy, isBusy: () => true }), withState({ kind: "wake-poke" }));
    expect(busy.saves()).toBe(0);
  });

  it("a direct invoke carries no URLs — its isolated session must not read or clobber the snapshot", async () => {
    const sync = fakeStateSync();
    const res = await postEnvelope(adapter({ stateSync: sync }), { kind: "invoke", session: "cli", text: "hi" });
    expect(res.status).toBe(200);
    expect(sync.seen).toEqual([]);
  });
});
