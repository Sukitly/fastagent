import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/agent.ts";
import { type SlackChannelOptions, type SlackEventEnvelope, slackChannel, verifySlackSignature } from "../src/slack.ts";

const SECRET = "slack-signing-secret";
const API = "https://slack.test/api";
const roots: string[] = [];
const idles = new Set<() => Promise<void>>();

function replyingAgent(reply = "done") {
  const calls: { scope: Scope; prompt: Prompt }[] = [];
  const agent: Agent = {
    async *invoke(scope, prompt): AsyncIterable<AgentEvent> {
      calls.push({ scope, prompt });
      if (reply) yield { type: "text", delta: reply };
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fa-slack-"));
  roots.push(value);
  return value;
}

function okFetch() {
  let ts = 100;
  return vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth.test")) return Response.json({ ok: true, team_id: "T1", user_id: "UBOT" });
    if (url.endsWith("/chat.postMessage")) return Response.json({ ok: true, ts: String(ts++) });
    return Response.json({ ok: true });
  });
}

function signedRequest(envelope: unknown, options: { timestamp?: number; signature?: string } = {}): Request {
  const body = JSON.stringify(envelope);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://agent.test/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

function message(ts: string, input: Partial<NonNullable<SlackEventEnvelope["event"]>> = {}): SlackEventEnvelope {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev-${ts}`,
    event: {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "hello",
      ts,
      ...input,
    },
  };
}

function mount(agent: Agent, options: Partial<SlackChannelOptions> = {}) {
  const stateRoot = root();
  const handler = slackChannel({
    botToken: "xoxb-test",
    signingSecret: SECRET,
    apiBaseUrl: API,
    ...options,
  })({ agent, stateRoot })["POST /slack"]!;
  const idle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle;
  if (idle) idles.add(idle);
  return { handler, stateRoot };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([...idles].map((idle) => idle()));
}

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  idles.clear();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Slack signed ingress", () => {
  it("verifies the raw-body HMAC and rejects stale timestamps", () => {
    const body = '{"type":"url_verification","challenge":"x"}';
    const timestamp = "1700000000";
    const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    expect(verifySlackSignature(SECRET, timestamp, signature, body, 1_700_000_000_000)).toBe(true);
    expect(verifySlackSignature(SECRET, timestamp, signature, `${body} `, 1_700_000_000_000)).toBe(false);
    expect(verifySlackSignature(SECRET, timestamp, signature, body, 1_700_001_000_000)).toBe(false);
  });

  it("rejects an invalid group session policy at construction", () => {
    expect(() =>
      slackChannel({
        botToken: "xoxb-test",
        signingSecret: SECRET,
        groupMessageSession: "invalid" as "threaded",
      }),
    ).toThrow(/groupMessageSession/);
  });

  it("answers Slack's signed URL verification challenge and rejects a forged request", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent } = replyingAgent();
    const { handler } = mount(agent);
    const challenge = await handler(signedRequest({ type: "url_verification", challenge: "abc" }));
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "abc" });
    expect((await handler(signedRequest(message("1.0"), { signature: "v0=bad" }))).status).toBe(401);
  });
});

describe("Slack sessions, context, and managed threads", () => {
  it("threads each top-level DM by default and settles the one preview message", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("hello back");
    const { handler } = mount(agent);
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("slack:T1:D1:1.0");
    expect(calls[0]?.prompt.text).toContain("[slack: team T1, channel D1 (direct)");
    const methods = fetchMock.mock.calls.map(([url]) => String(url).split("/").pop());
    expect(methods).toContain("chat.postMessage");
    expect(methods).toContain("chat.update");
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat.postMessage"));
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ channel: "D1", thread_ts: "1.0" });
  });

  it("keeps one linear DM session when continuous mode is explicitly selected", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent, { directMessageSession: "continuous" });
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "first" })));
    await settle();

    expect(calls[0]?.scope.session).toBe("slack:T1:D1");
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat.postMessage"));
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty("thread_ts");
  });

  it("folds unsummoned group context, owns the summoned thread, and dedups logical messages", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve)); // auth.test resolves bot identity

    await handler(signedRequest(message("1.0", { text: "the deploy is broken" })));
    const bufferPath = join(stateRoot, "channels", "slack", "buffers.json");
    expect(readFileSync(bufferPath, "utf8")).toContain("the deploy is broken");

    await handler(signedRequest(message("2.0", { type: "app_mention", text: "<@UBOT> investigate" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("slack:T1:C1:2.0");
    expect(calls[0]?.prompt.text).toContain("the deploy is broken");

    await handler(signedRequest(message("3.0", { text: "compare yesterday too", thread_ts: "2.0" })));
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.scope.session).toBe("slack:T1:C1:2.0");

    await handler(
      signedRequest({
        ...message("3.0", { type: "app_mention", text: "<@UBOT> duplicate", thread_ts: "2.0" }),
        event_id: "different",
      }),
    );
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("answers inside an existing human thread without adopting its later bare replies", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("10.1", { type: "app_mention", text: "<@UBOT> inspect", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("slack:T1:C1:10.0");

    await handler(signedRequest(message("10.2", { text: "bare follow-up", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("bare follow-up");
  });

  it("supports Feishu-compatible continuous top-level group sessions without creating ownership", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent, { groupBehavior: "context", groupMessageSession: "continuous" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("20.0", { type: "app_mention", text: "<@UBOT> top level" })));
    await settle();
    expect(calls[0]?.scope.session).toBe("slack:T1:C1");

    await handler(signedRequest(message("20.1", { text: "not managed", thread_ts: "20.0" })));
    await settle();
    expect(calls).toHaveLength(1);

    await handler(
      signedRequest(message("21.1", { type: "app_mention", text: "<@UBOT> existing topic", thread_ts: "21.0" })),
    );
    await settle();
    expect(calls[1]?.scope.session).toBe("slack:T1:C1:21.0");

    const posts = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/chat.postMessage"))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(posts[0]).not.toHaveProperty("thread_ts");
    expect(posts[1]).toMatchObject({ thread_ts: "21.0" });
  });

  it("mention-only mode neither buffers group traffic nor admits bare thread replies", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "mentions" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("1.0", { text: "background" })));
    await handler(signedRequest(message("2.0", { type: "app_mention", text: "<@UBOT> answer" })));
    await settle();
    await handler(signedRequest(message("3.0", { text: "bare reply", thread_ts: "2.0" })));
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.text).not.toContain("background");
    expect(() => readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toThrow();
  });

  it("persists a turn before ACK and uses only Slack file IDs in the intent", async () => {
    vi.stubGlobal("fetch", okFetch());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        await gate;
        yield { type: "completed" };
      },
    };
    const { handler, stateRoot } = mount(agent);
    const event = message("4.0", {
      type: "app_mention",
      text: "<@UBOT> read this",
      subtype: "file_share",
      files: [{ id: "F1", name: "secret.txt", url_private: "https://temporary.example/file" }],
    });
    const response = await handler(signedRequest(event));
    expect(response.status).toBe(200);
    const turns = readFileSync(join(stateRoot, "channels", "slack", "turns.json"), "utf8");
    expect(turns).toContain('"fileIds":["F1"]');
    expect(turns).not.toContain("temporary.example");
    release();
  });
});
