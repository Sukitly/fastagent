/**
 * The cross-deploy state snapshot. AgentCore erases the /mnt/state mount on every runtime version
 * update (= every deploy), so these paths ARE the agent's memory: a regression here loses sessions,
 * channel dedup and pending wake-ups silently. Each test states the loss it prevents.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeWork } from "../src/channels/busy.ts";
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_VERSION,
  createStateSync,
  packStateRoot,
  unpackIntoStateRoot,
} from "../src/channels/agentcore-state.ts";

const dirs: string[] = [];
async function stateRoot(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fastagent-state-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fetch double: records calls, replies from a script. */
function fakeFetch(script: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; body?: Uint8Array }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body instanceof Uint8Array ? init.body : undefined,
    });
    return script(String(url), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const urls = { getUrl: "https://s3/get", putUrl: "https://s3/put" };

describe("agentcore state snapshot", () => {
  it("round-trips the whole state root, nested paths included", async () => {
    const source = await stateRoot({
      "auth.json": '{"token":"t"}',
      "sessions/8335403535.jsonl": '{"role":"user"}\n{"role":"assistant"}\n',
      "schedule/wakeups.json": '{"pending":[{"id":"a"}]}',
    });
    const target = await stateRoot();
    const written = await unpackIntoStateRoot(target, await packStateRoot(source));

    expect(written).toBe(3);
    expect(await readFile(join(target, "sessions/8335403535.jsonl"), "utf8")).toBe(
      '{"role":"user"}\n{"role":"assistant"}\n',
    );
    expect(await readFile(join(target, "schedule/wakeups.json"), "utf8")).toBe('{"pending":[{"id":"a"}]}');
  });

  it("the snapshot's auth.json WINS over the deploy seed — the box's copy is the refreshed one", async () => {
    // Same rule as every other host's volume: "a credential already refreshed is never overwritten".
    // The seed is bootstrap for a snapshot that has none, not an authority over one that does.
    const source = await stateRoot({ "auth.json": "REFRESHED-ON-THE-BOX", "sessions/s.jsonl": "keep" });
    const target = await stateRoot({ "auth.json": "SEEDED-BY-THIS-DEPLOY" });

    await unpackIntoStateRoot(target, await packStateRoot(source));

    expect(await readFile(join(target, "auth.json"), "utf8")).toBe("REFRESHED-ON-THE-BOX");
    expect(await readFile(join(target, "sessions/s.jsonl"), "utf8")).toBe("keep");
  });

  it("never carries control.json — it is this boot's URL+token, worthless (and misleading) to the next", async () => {
    const source = await stateRoot({ "control.json": '{"url":"http://127.0.0.1:8787","token":"old"}' });
    const target = await stateRoot({ "control.json": '{"url":"http://127.0.0.1:9000","token":"current"}' });

    const packed = await packStateRoot(source);
    expect(JSON.parse(gunzipSync(packed).toString()).files["control.json"]).toBeUndefined();

    await unpackIntoStateRoot(target, packed);
    expect(await readFile(join(target, "control.json"), "utf8")).toContain("current"); // untouched
  });

  it("packing an empty/absent state root is valid (first boot), and restores as zero files", async () => {
    const packed = await packStateRoot(join(await stateRoot(), "nonexistent"));
    expect(await unpackIntoStateRoot(await stateRoot(), packed)).toBe(0);
  });

  it("refuses a snapshot that would escape the state root, or one from an unknown version", async () => {
    const target = await stateRoot();
    const escaping = gzipSync(
      Buffer.from(
        JSON.stringify({ v: SNAPSHOT_VERSION, files: { "../escaped": Buffer.from("x").toString("base64") } }),
      ),
    );
    await expect(unpackIntoStateRoot(target, escaping)).rejects.toThrow(/unsafe path/);

    const future = gzipSync(Buffer.from(JSON.stringify({ v: 99, files: {} })));
    await expect(unpackIntoStateRoot(target, future)).rejects.toThrow(/unsupported shape/);

    await expect(unpackIntoStateRoot(target, Buffer.from("not gzip"))).rejects.toThrow(/unreadable/);
  });

  it("caps the packed size — a runaway state root fails visibly instead of OOMing the microVM", async () => {
    const dir = await stateRoot();
    await writeFile(join(dir, "big.bin"), Buffer.alloc(4096));

    // Drive the real guard through an injected cap (writing 64 MiB to prove a branch is not a test).
    await expect(packStateRoot(dir, 1024)).rejects.toThrow(/exceeds 1024 bytes/);
    await expect(packStateRoot(dir, MAX_SNAPSHOT_BYTES)).resolves.toBeInstanceOf(Buffer);
  });

  describe("sync lifecycle", () => {
    it("restores on the first ready() and pushes the packed root on save()", async () => {
      const remote = await packStateRoot(await stateRoot({ "sessions/a.jsonl": "history" }));
      const local = await stateRoot();
      const { impl, calls } = fakeFetch((_url, init) =>
        init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(new Uint8Array(remote)),
      );
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });

      sync.use(urls);
      await sync.ready();
      expect(await readFile(join(local, "sessions/a.jsonl"), "utf8")).toBe("history");

      sync.save();
      await sync.flush();
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
      expect(calls[1]!.body!.byteLength).toBeGreaterThan(0);
    });

    it("a 404 is first boot (empty root, no error) — and only then may a snapshot be written", async () => {
      const local = await stateRoot();
      const { impl, calls } = fakeFetch((_u, init) =>
        init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(null, { status: 404 }),
      );
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await expect(sync.ready()).resolves.toBeUndefined();
      sync.save();
      await sync.flush();
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    });

    it("a FAILED restore rejects and blocks saving — never overwrite good state with an empty root", async () => {
      const local = await stateRoot();
      const { impl, calls } = fakeFetch(() => new Response("boom", { status: 500 }));
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);

      await expect(sync.ready()).rejects.toThrow(/GET failed: 500/);
      await expect(sync.ready()).rejects.toThrow(/GET failed: 500/); // sticky: one attempt per process
      sync.save();
      await sync.flush();
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    });

    it("without URLs nothing happens — a direct invoke must not read or clobber the ingress snapshot", async () => {
      const { impl, calls } = fakeFetch(() => new Response(null, { status: 404 }));
      const sync = createStateSync({ stateRoot: await stateRoot(), fetchImpl: impl });

      expect(sync.configured()).toBe(false);
      await expect(sync.ready()).resolves.toBeUndefined();
      sync.save();
      await sync.flush();
      expect(calls).toHaveLength(0);

      // …and the skipped restore is not cached: the first envelope that DOES carry URLs still runs it.
      sync.use(urls);
      expect(sync.configured()).toBe(true);
      await sync.ready();
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    });

    it("coalesces saves: a burst while one upload is in flight collapses to ONE follow-up", async () => {
      const local = await stateRoot({ "a.json": "1" });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const { impl, calls } = fakeFetch(async (_u, init) => {
        if (init?.method === "PUT" && calls.filter((c) => c.method === "PUT").length === 1) await gate;
        return new Response(init?.method === "PUT" ? null : new Uint8Array(await packStateRoot(local)), {
          status: 200,
        });
      });
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await sync.ready();

      sync.save(); // starts, blocks on the gate
      sync.save();
      sync.save();
      sync.save(); // three more requests while it is in flight
      release();
      await sync.flush();

      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2); // the in-flight one + one catch-up
    });

    it("counts the upload as in-flight work — the platform may reclaim the microVM the instant it idles", async () => {
      const local = await stateRoot({ "a.json": "1" });
      const base = activeWork();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const { impl } = fakeFetch(async (_u, init) => {
        if (init?.method === "PUT") await gate;
        return new Response(init?.method === "PUT" ? null : null, { status: init?.method === "PUT" ? 200 : 404 });
      });
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await sync.ready();

      sync.save();
      await vi.waitFor(() => expect(activeWork()).toBe(base + 1)); // /ping still says HealthyBusy
      release();
      await sync.flush();
      expect(activeWork()).toBe(base);
    });

    it("an upload failure is logged, not thrown — the local mount still holds the data until next settle", async () => {
      const local = await stateRoot({ "a.json": "1" });
      const { impl } = fakeFetch((_u, init) =>
        init?.method === "PUT" ? new Response(null, { status: 403 }) : new Response(null, { status: 404 }),
      );
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await sync.ready();

      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      sync.save();
      await expect(sync.flush()).resolves.toBeUndefined();
      spy.mockRestore();
    });
  });
});
