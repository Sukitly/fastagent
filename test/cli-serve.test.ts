import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agent.ts";
import { routesFor } from "../src/cli/serve.ts";

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
