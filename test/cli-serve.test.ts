import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agent.ts";
import { mountAgentcore, routesFor } from "../src/cli/serve.ts";
import { text } from "../src/channels/respond.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";

describe("serving surface", () => {
  it("keeps health but does not add the fallback /invoke for a long-connection channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-long-connection-surface-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "socket.mjs"),
      `export default { name: "socket", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) };\n`,
    );
    const surface = await routesFor(dir, {} as Agent, join(dir, ".state"));
    expect(Object.keys(surface.routes)).toEqual(["GET /health"]);
    expect(surface.builtinInvoke).toBe(false);
    expect(surface.longConnections.map((connection) => connection.name)).toEqual(["socket"]);
    expect(surface.routeChannels).toEqual([]);
    const health = surface.routes["GET /health"]!;
    expect((await health(new Request("http://x/health"))).status).toBe(503);
    surface.markReady();
    expect((await health(new Request("http://x/health"))).status).toBe(200);
  });
});

describe("mountAgentcore", () => {
  const agent: Agent = {
    async *invoke() {
      yield { type: "completed" as const };
    },
  };
  const schedule: LoadedSchedule = { name: "job", cron: "0 * * * *", tz: "UTC", prompt: "go" };

  it("mounts /invocations + /ping over the serving routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-mount-"));
    const routes = mountAgentcore(
      { "POST /telegram": () => text("ok\n", 200) },
      { agent, stateRoot: dir, schedules: [] },
    );
    expect(Object.keys(routes).sort()).toEqual(["GET /ping", "POST /invocations", "POST /telegram"]);
    expect(await (await routes["GET /ping"]!(new Request("http://x/ping"))).json()).toEqual({ status: "Healthy" });
  });

  it("fails startup on a channel colliding with the adapter's paths", () => {
    expect(() =>
      mountAgentcore({ "POST /invocations": () => text("mine\n", 200) }, { agent, stateRoot: "/tmp", schedules: [] }),
    ).toThrow(/collide with the AgentCore adapter/);
  });

  it("binds schedule fires by name — an unknown name 404s through the adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-fire-"));
    const routes = mountAgentcore({}, { agent, stateRoot: dir, schedules: [schedule] });
    const fire = (name: string): Promise<Response> | Response =>
      routes["POST /invocations"]!(
        new Request("http://x/invocations", {
          method: "POST",
          body: JSON.stringify({ kind: "schedule-fire", name, slot: "2026-07-07T10:00:00Z" }),
        }),
      );
    expect((await fire("nope")).status).toBe(404);
    const res = await fire("job");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fired: true });
  });
});
