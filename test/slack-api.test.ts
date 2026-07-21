import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkSlackText, createSlackApi } from "../src/channels/slack/slack-api.ts";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Slack Web API transport", () => {
  it("gates success on ok:true and names the Slack method/error details", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ok: false,
        error: "invalid_arguments",
        needed: "files:read",
        response_metadata: { messages: ["[ERROR] missing required field: file"] },
      }),
    );
    const api = createSlackApi({ botToken: "x", baseUrl: "https://slack.test/api" });
    await expect(api.fileInfo("F1")).rejects.toThrow(
      /files\.info.*invalid_arguments.*files:read.*missing required field: file/,
    );
  });

  it("calls files.info with its required GET query argument and bearer token", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true, file: { id: "F 1/+", mimetype: "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createSlackApi({ botToken: "xoxb-secret", baseUrl: "https://slack.test/api" });

    await expect(api.fileInfo("F 1/+")).resolves.toMatchObject({ id: "F 1/+" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.pathname).toBe("/api/files.info");
    expect(url.searchParams.get("file")).toBe("F 1/+");
    expect(init).toMatchObject({ method: "GET" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-secret");
    expect(init?.body).toBeUndefined();
  });

  it("honours Retry-After for 429 and then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return calls === 1
        ? Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "1" } })
        : Response.json({ ok: true, ts: "2.0" });
    });
    const api = createSlackApi({ botToken: "x", baseUrl: "https://slack.test/api" });
    const pending = api.postMessage({ channelId: "C1" }, "hi");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe("2.0");
    expect(calls).toBe(2);
  });

  it("downloads authenticated Slack-hosted bytes, creates vision refs, and writes ordinary files", async () => {
    const calls: { url: string; authorization?: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined });
      if (String(input).includes("image")) {
        return new Response(Buffer.from("png"), { headers: { "content-type": "image/png", "content-length": "3" } });
      }
      return new Response(Buffer.from("report"), { headers: { "content-type": "text/plain" } });
    });
    const api = createSlackApi({ botToken: "xoxb-secret" });
    const image = await api.fetchImage({
      id: "F1",
      mimetype: "image/png",
      url_private: "https://files.slack.com/image",
    });
    expect(image).toEqual({ mimeType: "image/png", data: Buffer.from("png").toString("base64") });

    const root = mkdtempSync(join(tmpdir(), "fa-slack-files-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const file = await api.fetchFile(
      { id: "F2", name: "../report.txt", mimetype: "text/plain", url_private_download: "https://files.slack.com/file" },
      "C1",
      root,
    );
    expect(file.path).toBe(join(root, "C1", "F2-__report.txt"));
    expect(readFileSync(file.path, "utf8")).toBe("report");
    expect(calls.every((call) => call.authorization === "Bearer xoxb-secret")).toBe(true);
  });

  it("refuses external/non-Slack download hosts and metadata above the 20 MB cap", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = createSlackApi({ botToken: "x" });
    await expect(
      api.fetchFile({ id: "F1", name: "x", url_private: "https://evil.example/file" }, "C1", "/tmp"),
    ).rejects.toThrow(/non-Slack file URL/);
    await expect(
      api.fetchFile(
        { id: "F2", name: "x", size: 21 * 1024 * 1024, url_private: "https://files.slack.com/x" },
        "C1",
        "/tmp",
      ),
    ).rejects.toThrow(/too large/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Slack text splitting", () => {
  it("preserves Unicode code points and prefers newline boundaries", () => {
    expect(chunkSlackText("😀😀😀", 2)).toEqual(["😀😀", "😀"]);
    expect(chunkSlackText("abc\ndef", 5)).toEqual(["abc", "def"]);
  });
});
