/**
 * EXECUTES the generated forwarder Lambda (not substring assertions): the source is evaluated with a
 * fake `require` handing back fake AWS clients, then driven through real event shapes. This is the
 * deployment's single riskiest generated component — behavior (upsert/conflict/failure propagation,
 * query round-trip, secret gate) must be under test, not trusted.
 */
import { Buffer } from "node:buffer";
import * as nodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwarderSource } from "../src/deploy/agentcore/plan.ts";

type Envelope = Record<string, unknown> & { kind?: string; wake?: { url: string } };

interface HarnessOptions {
  env?: Record<string, string>;
  /** What the container's /invocations returns for a given envelope (transport status + JSON body). */
  containerReply?: (envelope: Envelope) => { statusCode?: number; body: unknown };
  /** Scheduler behavior per call — throw to simulate an API error. */
  onSchedule?: (type: "create" | "update", input: Record<string, unknown>) => void;
}

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function loadForwarder(options: HarnessOptions = {}) {
  const env = {
    RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/x",
    INGRESS_SESSION_ID: "fastagent-ingress-x-0000000000000000",
    INGRESS_SECRET: "ingress-s3cret",
    ...options.env,
  };
  const envelopes: Envelope[] = [];
  const scheduleCalls: { type: "create" | "update"; input: Record<string, unknown> }[] = [];
  let urlLookups = 0;

  const reply: (envelope: Envelope) => { statusCode?: number; body: unknown } =
    options.containerReply ??
    ((envelope: Envelope) =>
      envelope.kind === "webhook"
        ? {
            body: {
              status: 200,
              headers: { "content-type": "text/plain" },
              bodyB64: Buffer.from("ok\n").toString("base64"),
            },
          }
        : { body: { ok: true } });

  class InvokeAgentRuntimeCommand {
    constructor(public input: { payload: Uint8Array }) {}
  }
  class CreateScheduleCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateScheduleCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetFunctionUrlConfigCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  const modules: Record<string, unknown> = {
    "@aws-sdk/client-bedrock-agentcore": {
      InvokeAgentRuntimeCommand,
      BedrockAgentCoreClient: class {
        async send(cmd: InvokeAgentRuntimeCommand) {
          const envelope = JSON.parse(Buffer.from(cmd.input.payload).toString()) as Envelope;
          envelopes.push(envelope);
          const r = reply(envelope);
          return {
            statusCode: r.statusCode ?? 200,
            response: { transformToByteArray: async () => Buffer.from(JSON.stringify(r.body)) },
          };
        }
      },
    },
    "@aws-sdk/client-lambda": {
      GetFunctionUrlConfigCommand,
      LambdaClient: class {
        async send(_cmd: GetFunctionUrlConfigCommand) {
          urlLookups += 1;
          return { FunctionUrl: "https://self.lambda-url.on.aws/" };
        }
      },
    },
    "@aws-sdk/client-scheduler": {
      CreateScheduleCommand,
      UpdateScheduleCommand,
      SchedulerClient: class {
        async send(cmd: CreateScheduleCommand | UpdateScheduleCommand) {
          const type = cmd instanceof CreateScheduleCommand ? "create" : "update";
          scheduleCalls.push({ type, input: cmd.input });
          options.onSchedule?.(type, cmd.input);
          return {};
        }
      },
    },
  };
  const fakeRequire = (name: string): unknown => {
    // node:crypto is the REAL module: the forwarder's SigV4 presigning must be exercised, not faked.
    if (name === "node:crypto") return nodeCrypto;
    const mod = modules[name];
    if (!mod) throw new Error(`unexpected require("${name}")`);
    return mod;
  };
  const exportsObject: { handler?: (event: unknown, ctx?: unknown) => Promise<Record<string, unknown>> } = {};
  const quietConsole = { log: vi.fn() };
  new Function("require", "exports", "process", "console", "Buffer", "TextEncoder", forwarderSource())(
    fakeRequire,
    exportsObject,
    { env },
    quietConsole,
    Buffer,
    TextEncoder,
  );
  const handler = exportsObject.handler;
  if (!handler) throw new Error("forwarder source exported no handler");
  const ctx = { invokedFunctionArn: "arn:aws:lambda:us-east-1:1:function:fwd" };
  return {
    handler: (event: unknown) => handler(event, ctx),
    envelopes,
    scheduleCalls,
    logs: quietConsole.log,
    urlLookups: () => urlLookups,
  };
}

/**
 * SigV4 query-string signing, written straight from the AWS spec and pinned to their published test
 * vector (see the test below) — an INDEPENDENT check on the generated forwarder's own implementation.
 */
function referenceSignature(input: {
  method: string;
  host: string;
  key: string;
  stamp: string;
  expires: number;
  region?: string;
  accessKey?: string;
  secret?: string;
}): string {
  const region = input.region ?? "us-east-1";
  const accessKey = input.accessKey ?? "AKIAIOSFODNN7EXAMPLE";
  const secret = input.secret ?? "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const esc = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const hmac = (k: nodeCrypto.BinaryLike, d: string) => nodeCrypto.createHmac("sha256", k).update(d).digest();
  const scope = `${input.stamp.slice(0, 8)}/${region}/s3/aws4_request`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKey}/${scope}`],
    ["X-Amz-Date", input.stamp],
    ["X-Amz-Expires", String(input.expires)],
    ["X-Amz-SignedHeaders", "host"],
  ]
    .map(([k, v]) => `${esc(k!)}=${esc(v!)}`)
    .sort()
    .join("&");
  const uri = `/${input.key.split("/").map(esc).join("/")}`;
  const canonical = [input.method, uri, query, `host:${input.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const sts = [
    "AWS4-HMAC-SHA256",
    input.stamp,
    scope,
    nodeCrypto.createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let key = hmac(`AWS4${secret}`, input.stamp.slice(0, 8));
  for (const part of [region, "s3", "aws4_request"]) key = hmac(key, part);
  return hmac(key, sts).toString("hex");
}

const webhookEvent = (over: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "POST" } },
  rawPath: "/telegram",
  rawQueryString: "",
  headers: { "x-telegram-bot-api-secret-token": "s" },
  body: JSON.stringify({ update_id: 1 }),
  isBase64Encoded: false,
  ...over,
});

describe("agentcore forwarder (executed)", () => {
  it("forwards a webhook verbatim — method/path/QUERY/headers/body — and re-emits the reply", async () => {
    const f = loadForwarder();
    const res = await f.handler(webhookEvent({ rawQueryString: "code=abc&x=1" }));
    expect(f.envelopes[0]).toMatchObject({
      kind: "webhook",
      method: "POST",
      path: "/telegram",
      query: "code=abc&x=1",
      headers: { "x-telegram-bot-api-secret-token": "s" },
      bodyB64: Buffer.from(JSON.stringify({ update_id: 1 })).toString("base64"),
    });
    expect(res).toMatchObject({ statusCode: 200, isBase64Encoded: true });
    expect(Buffer.from(res.body as string, "base64").toString()).toBe("ok\n");
  });

  it("strips hop-by-hop headers from the reply and maps a transport failure to 502", async () => {
    const withHeaders = loadForwarder({
      containerReply: () => ({
        body: { status: 201, headers: { "content-length": "3", connection: "keep-alive", "x-keep": "y" }, bodyB64: "" },
      }),
    });
    const ok = await withHeaders.handler(webhookEvent());
    expect(ok.statusCode).toBe(201);
    expect(ok.headers).toEqual({ "x-keep": "y" });

    const broken = loadForwarder({ containerReply: () => ({ statusCode: 424, body: "boom" }) });
    const res = await broken.handler(webhookEvent());
    expect(res.statusCode).toBe(502);
  });

  it("schedule fires throw on a failed container outcome (the miss must land in CloudWatch)", async () => {
    const ok = loadForwarder();
    await ok.handler({ scheduleFire: { name: "digest", slot: "2026-07-28T09:00:00Z" } });
    expect(ok.envelopes[0]).toMatchObject({ kind: "schedule-fire", name: "digest" });

    const failing = loadForwarder({ containerReply: () => ({ statusCode: 500, body: "nope" }) });
    await expect(failing.handler({ scheduleFire: { name: "digest", slot: "x" } })).rejects.toThrow(/digest failed/);
  });

  it("a wakePoke event forwards a wake-poke envelope (the invocation itself is the payload)", async () => {
    const f = loadForwarder();
    await f.handler({ wakePoke: true });
    expect(f.envelopes[0]).toMatchObject({ kind: "wake-poke" });
  });

  describe("wake alarms", () => {
    const env = { WAKE_SECRET: "s3cret", WAKE_ROLE_ARN: "arn:role", WAKE_PREFIX: "fa-x-wk-" };
    const alarmEvent = (secret: string, alarms: unknown[]) =>
      webhookEvent({ rawPath: "/__fastagent/wake-alarm", body: JSON.stringify({ secret, alarms }) });
    const alarm = { id: "abcd1234-rest-of-uuid", at: "2026-07-28T10:30:00.000Z" };

    it("gates on the shared secret — wrong or unconfigured is 403, never forwarded", async () => {
      const f = loadForwarder({ env });
      expect((await f.handler(alarmEvent("wrong", [alarm]))).statusCode).toBe(403);
      const unconfigured = loadForwarder(); // no WAKE_SECRET in env
      expect((await unconfigured.handler(alarmEvent("s3cret", [alarm]))).statusCode).toBe(403);
      expect(f.envelopes).toHaveLength(0); // handled locally, never sent to the container
    });

    it("creates a self-deleting one-shot at(fireAt) poking itself", async () => {
      const f = loadForwarder({ env });
      const res = await f.handler(alarmEvent("s3cret", [alarm]));
      expect(res.statusCode).toBe(200);
      expect(f.scheduleCalls).toEqual([
        {
          type: "create",
          input: expect.objectContaining({
            Name: expect.stringMatching(/^fa-x-wk-[0-9a-f]{16}$/),
            ScheduleExpression: "at(2026-07-28T10:30:00)",
            ActionAfterCompletion: "DELETE",
            Target: expect.objectContaining({
              Arn: "arn:aws:lambda:us-east-1:1:function:fwd",
              RoleArn: "arn:role",
              Input: '{"wakePoke":true}',
            }),
          }),
        },
      ]);
    });

    it("upserts: an existing schedule (Conflict) is updated in place", async () => {
      const f = loadForwarder({
        env,
        onSchedule: (type) => {
          if (type === "create") throw awsError("ConflictException");
        },
      });
      const res = await f.handler(alarmEvent("s3cret", [alarm]));
      expect(res.statusCode).toBe(200);
      expect(f.scheduleCalls.map((c) => c.type)).toEqual(["create", "update"]);
    });

    it("propagates failures — a swallowed error would strand a pending wake with no alarm", async () => {
      const createFails = loadForwarder({
        env,
        onSchedule: (type) => {
          if (type === "create") throw awsError("AccessDeniedException");
        },
      });
      expect((await createFails.handler(alarmEvent("s3cret", [alarm]))).statusCode).toBe(500);

      const updateFails = loadForwarder({
        env,
        onSchedule: (type) => {
          throw awsError(type === "create" ? "ConflictException" : "ValidationException");
        },
      });
      expect((await updateFails.handler(alarmEvent("s3cret", [alarm]))).statusCode).toBe(500);
    });
  });

  it("with WAKE_SECRET set, resolves its own URL ONCE and rides it on every envelope", async () => {
    const f = loadForwarder({ env: { WAKE_SECRET: "s3cret", WAKE_ROLE_ARN: "r", WAKE_PREFIX: "p-" } });
    await f.handler(webhookEvent());
    await f.handler({ wakePoke: true });
    expect(f.urlLookups()).toBe(1); // cached across invocations (cold-start once)
    expect(f.envelopes[0]!.wake).toEqual({ url: "https://self.lambda-url.on.aws/" });
    expect(f.envelopes[1]!.wake).toEqual({ url: "https://self.lambda-url.on.aws/" });
  });

  it("without WAKE_SECRET, no URL lookup and no wake field (lean deployments stay lean)", async () => {
    const f = loadForwarder();
    await f.handler(webhookEvent());
    expect(f.urlLookups()).toBe(0);
    expect(f.envelopes[0]!.wake).toBeUndefined();
  });

  describe("state snapshot URLs (the container has NO AWS credentials — presigning is its only reach)", () => {
    const stateEnv = {
      STATE_BUCKET: "fa-agent-123456789012",
      STATE_KEY: "state/snapshot.json.gz",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rides a GET/PUT pair on every envelope, signed for the one snapshot object", async () => {
      const f = loadForwarder({ env: stateEnv });
      await f.handler(webhookEvent());
      await f.handler({ scheduleFire: { name: "digest", slot: "2026-07-28T09:00:00Z" } });

      for (const envelope of f.envelopes) {
        const state = envelope.state as { getUrl: string; putUrl: string };
        for (const url of [state.getUrl, state.putUrl]) {
          const parsed = new URL(url);
          expect(parsed.origin).toBe("https://fa-agent-123456789012.s3.us-east-1.amazonaws.com");
          expect(parsed.pathname).toBe("/state/snapshot.json.gz");
          expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
          expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
          expect(parsed.searchParams.get("X-Amz-Credential")).toMatch(/AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\//);
          expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
          // 12 h — longer than a session's 8 h compute ceiling, so a late settle can still push.
          expect(parsed.searchParams.get("X-Amz-Expires")).toBe("43200");
        }
        // The method is part of the canonical request: one signature cannot serve both verbs.
        expect(state.getUrl).not.toBe(state.putUrl);
      }
    });

    it("REFERENCE: the signing algorithm reproduces AWS's published query-string vector", () => {
      // Anchors the cross-check below in something external. From the S3 docs' worked example
      // (GET examplebucket/test.txt, 86400s, the canonical AKIAIOSFODNN7EXAMPLE credential).
      expect(
        referenceSignature({
          method: "GET",
          host: "examplebucket.s3.amazonaws.com",
          key: "test.txt",
          stamp: "20130524T000000Z",
          expires: 86400,
        }),
      ).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    });

    it("the forwarder's signature MATCHES that reference — a wrong one 403s and the agent loses its memory", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-28T09:00:00.000Z"));
      const f = loadForwarder({ env: stateEnv });
      await f.handler(webhookEvent());

      const state = f.envelopes[0]!.state as { getUrl: string; putUrl: string };
      for (const [method, url] of [
        ["GET", state.getUrl],
        ["PUT", state.putUrl],
      ] as const) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("X-Amz-Date")).toBe("20260728T090000Z");
        expect(parsed.searchParams.get("X-Amz-Signature")).toBe(
          referenceSignature({
            method,
            host: "fa-agent-123456789012.s3.us-east-1.amazonaws.com",
            key: "state/snapshot.json.gz",
            stamp: "20260728T090000Z",
            expires: 43200,
          }),
        );
      }
    });

    it("carries the role's session token when present — Lambda credentials are always temporary", async () => {
      const f = loadForwarder({ env: { ...stateEnv, AWS_SESSION_TOKEN: "FwoGZXIvYXdzEJr//////////wEaDA==" } });
      await f.handler(webhookEvent());
      const url = new URL((f.envelopes[0]!.state as { getUrl: string }).getUrl);
      expect(url.searchParams.get("X-Amz-Security-Token")).toBe("FwoGZXIvYXdzEJr//////////wEaDA==");
      // Canonical-query order is signed: the token must sort into place, not append.
      const keys = [...url.searchParams.keys()].filter((k) => k !== "X-Amz-Signature");
      expect(keys).toEqual([...keys].sort());
    });

    it("no STATE_BUCKET, no state field — an invoke-only deployment keeps nothing durable", async () => {
      const f = loadForwarder();
      await f.handler(webhookEvent());
      expect(f.envelopes[0]!.state).toBeUndefined();
    });
  });
});

describe("agentcore forwarder: envelope authentication + alarm identity", () => {
  it("stamps the ingress secret on EVERY envelope — the runtime cannot otherwise tell it from any IAM caller", async () => {
    const f = loadForwarder();
    await f.handler(webhookEvent());
    await f.handler({ scheduleFire: { name: "digest", slot: "2026-07-28T09:00:00Z" } });
    await f.handler({ wakePoke: true });
    expect(f.envelopes.map((e) => e.auth)).toEqual(["ingress-s3cret", "ingress-s3cret", "ingress-s3cret"]);
  });

  it("names an alarm by a hash of the WHOLE wake id — a shared prefix must not steal another's fire time", async () => {
    const env = { WAKE_SECRET: "s", WAKE_ROLE_ARN: "r", WAKE_PREFIX: "fa-x-wk-" };
    const shared = "abcd1234";
    const f = loadForwarder({ env });
    const res = await f.handler(
      webhookEvent({
        rawPath: "/__fastagent/wake-alarm",
        body: JSON.stringify({
          secret: "s",
          alarms: [
            { id: `${shared}-first-wake`, at: "2026-07-28T10:30:00.000Z" },
            { id: `${shared}-second-wake`, at: "2026-07-28T22:00:00.000Z" },
          ],
        }),
      }),
    );

    expect(res.statusCode).toBe(200);
    const names = f.scheduleCalls.map((c) => c.input.Name as string);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2); // two wakes, two alarms — not one silently overwritten
    for (const name of names) expect(name).toMatch(/^fa-x-wk-[0-9a-f]{16}$/);
    expect(f.scheduleCalls.map((c) => c.type)).toEqual(["create", "create"]); // no bogus "update"
  });

  it("a genuine name collision is a FAILURE, not a silent update", async () => {
    const env = { WAKE_SECRET: "s", WAKE_ROLE_ARN: "r", WAKE_PREFIX: "fa-x-wk-" };
    const f = loadForwarder({ env });
    const res = await f.handler(
      webhookEvent({
        rawPath: "/__fastagent/wake-alarm",
        body: JSON.stringify({
          secret: "s",
          alarms: [
            { id: "same-id", at: "2026-07-28T10:30:00.000Z" },
            { id: "same-id", at: "2026-07-28T22:00:00.000Z" },
          ],
        }),
      }),
    );
    expect(res.statusCode).toBe(500);
    expect(f.scheduleCalls).toHaveLength(1);
  });
});
