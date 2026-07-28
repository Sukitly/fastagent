/**
 * EXECUTES the generated forwarder Lambda (not substring assertions): the source is evaluated with a
 * fake `require` handing back fake AWS clients, then driven through real event shapes. This is the
 * deployment's single riskiest generated component — behavior (upsert/conflict/failure propagation,
 * query round-trip, secret gate) must be under test, not trusted.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
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
            Name: "fa-x-wk-abcd1234",
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
});
