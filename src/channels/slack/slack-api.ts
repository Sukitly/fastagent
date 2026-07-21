/** Slack Web API transport: one JSON pipeline plus authenticated, capped private-file downloads. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageRef } from "../../agent.ts";
import { codePointPrefix } from "../text.ts";
import type { SlackFile } from "./model.ts";

const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const RETRIES = 3;
const MAX_RETRY_AFTER_S = 30;
const MAX_REDIRECTS = 3;
export const SLACK_MAX_TEXT = 39_000;

export interface SlackTarget {
  channelId: string;
  threadTs?: string;
}

export interface DownloadedSlackFile {
  path: string;
  name: string;
  size: number;
}

interface SlackBody {
  ok?: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: { messages?: string[] };
  [key: string]: unknown;
}

class SlackApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly slackError?: string;

  constructor(method: string, status: number, description: string, slackError?: string, options?: { cause?: unknown }) {
    super(
      status === 0 ? `slack ${method}: ${description}` : `slack ${method} failed: ${status} ${description}`,
      options,
    );
    this.name = "SlackApiError";
    this.method = method;
    this.status = status;
    this.slackError = slackError;
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SlackApiOptions {
  botToken: string;
  baseUrl?: string;
}

export interface SlackApi {
  authTest(): Promise<{ teamId?: string; userId?: string; botId?: string }>;
  postMessage(target: SlackTarget, text: string): Promise<string>;
  updateMessage(channelId: string, ts: string, text: string): Promise<void>;
  deleteMessage(channelId: string, ts: string): Promise<void>;
  sendText(target: SlackTarget, text: string): Promise<string | undefined>;
  fileInfo(fileId: string): Promise<SlackFile>;
  fetchImage(file: SlackFile): Promise<ImageRef>;
  fetchFile(file: SlackFile, channelId: string, filesDir: string): Promise<DownloadedSlackFile>;
}

/** Split at Slack's practical message cap, preserving code points and preferring a newline. */
export function chunkSlackText(text: string, maxPoints = SLACK_MAX_TEXT): string[] {
  if (!Number.isSafeInteger(maxPoints) || maxPoints <= 0) throw new RangeError("maxPoints must be a positive integer");
  const points = Array.from(text);
  if (points.length <= maxPoints) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(points.length, offset + maxPoints);
    if (end < points.length) {
      const window = points.slice(offset, end).join("");
      const newline = window.lastIndexOf("\n");
      if (newline > 0) end = offset + Array.from(window.slice(0, newline)).length;
    }
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
    if (points[offset] === "\n") offset++;
  }
  return chunks.length ? chunks : [""];
}

function safeFileName(file: SlackFile): string {
  const raw = file.name ?? file.title ?? file.id ?? "file";
  const safe = raw.replace(/[/\\]/g, "_").replace(/^\.+/, "_") || "file";
  return `${file.id ?? "slack"}-${safe}`;
}

function fileDownloadUrl(file: SlackFile): string {
  if (file.file_access === "check_file_info") throw new Error(`Slack file ${file.id ?? "(unknown)"} is not ready`);
  if (file.file_access === "access_denied") throw new Error(`Slack file ${file.id ?? "(unknown)"} is not accessible`);
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    const kind = file.is_external ? `external (${file.external_type ?? "unknown"})` : (file.mode ?? "unknown");
    throw new Error(`Slack file ${file.id ?? "(unknown)"} has no downloadable bytes (${kind})`);
  }
  if ((file.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("Slack file is too large (max 20 MB)");
  return url;
}

async function readBytesCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
    throw new Error("Slack file is too large (max 20 MB)");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel("download exceeds cap").catch(() => {});
      throw new Error("Slack file is too large (max 20 MB)");
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

export function createSlackApi({ botToken, baseUrl = "https://slack.com/api" }: SlackApiOptions): SlackApi {
  const apiBase = baseUrl.replace(/\/$/, "");
  const configuredOrigin = new URL(apiBase).origin;

  const trustedDownloadUrl = (value: string): URL => {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const slackHost =
      host === "slack-files.com" ||
      host.endsWith(".slack-files.com") ||
      host === "slack.com" ||
      host.endsWith(".slack.com") ||
      host === "slack-edge.com" ||
      host.endsWith(".slack-edge.com");
    if (!slackHost && url.origin !== configuredOrigin) throw new Error(`refusing non-Slack file URL host ${host}`);
    if (url.protocol !== "https:" && url.origin !== configuredOrigin)
      throw new Error("refusing non-HTTPS Slack file URL");
    return url;
  };

  const call = async <T extends SlackBody>(
    method: string,
    body: Record<string, unknown>,
    httpMethod: "GET" | "POST" = "POST",
  ): Promise<T> => {
    const url = new URL(`${apiBase}/${method}`);
    if (httpMethod === "GET") {
      for (const [name, value] of Object.entries(body)) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let raw: string;
      try {
        response = await fetch(url, {
          method: httpMethod,
          headers: {
            authorization: `Bearer ${botToken}`,
            ...(httpMethod === "POST" ? { "content-type": "application/json; charset=utf-8" } : {}),
          },
          ...(httpMethod === "POST" ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        raw = await response.text();
      } catch (error) {
        throw new SlackApiError(method, 0, String(error), undefined, { cause: error });
      }
      let data: T;
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = {} as T;
      }
      if (response.ok && data.ok === true) return data;
      const rateLimited = response.status === 429 || data.error === "ratelimited";
      if (rateLimited && attempt < RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after") ?? attempt + 1);
        if (Number.isFinite(retryAfter) && retryAfter <= MAX_RETRY_AFTER_S) {
          await wait(Math.max(1, retryAfter) * 1000);
          continue;
        }
      }
      const detail = [
        data.error ?? "response was not the expected Slack JSON",
        data.needed ? `needed ${data.needed}` : undefined,
        ...(data.response_metadata?.messages ?? []),
      ]
        .filter(Boolean)
        .join("; ");
      throw new SlackApiError(method, response.status, detail, data.error);
    }
  };

  const download = async (file: SlackFile): Promise<{ bytes: Buffer; contentType?: string }> => {
    let url = trustedDownloadUrl(fileDownloadUrl(file));
    for (let redirect = 0; ; redirect++) {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${botToken}` },
          redirect: "manual",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        throw new SlackApiError("file download", 0, String(error), undefined, { cause: error });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect >= MAX_REDIRECTS) {
          throw new SlackApiError("file download", response.status, "invalid or excessive redirect");
        }
        await response.body?.cancel().catch(() => {});
        url = trustedDownloadUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        const detail = codePointPrefix(await response.text().catch(() => ""), 300) || "file bytes were rejected";
        throw new SlackApiError("file download", response.status, detail);
      }
      return { bytes: await readBytesCapped(response), contentType: response.headers.get("content-type") ?? undefined };
    }
  };

  const api: SlackApi = {
    async authTest() {
      const data = await call<SlackBody & { team_id?: string; user_id?: string; bot_id?: string }>("auth.test", {});
      return { teamId: data.team_id, userId: data.user_id, botId: data.bot_id };
    },
    async postMessage(target, text) {
      const data = await call<SlackBody & { ts?: string }>("chat.postMessage", {
        channel: target.channelId,
        text,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!data.ts) throw new SlackApiError("chat.postMessage", 200, "response carried no ts");
      return data.ts;
    },
    async updateMessage(channelId, ts, text) {
      try {
        await call("chat.update", { channel: channelId, ts, text });
      } catch (error) {
        if (error instanceof SlackApiError && error.slackError === "message_not_modified") return;
        throw error;
      }
    },
    async deleteMessage(channelId, ts) {
      await call("chat.delete", { channel: channelId, ts });
    },
    async sendText(target, text) {
      let first: string | undefined;
      for (const chunk of chunkSlackText(text)) {
        const ts = await api.postMessage(target, chunk);
        first ??= ts;
      }
      return first;
    },
    async fileInfo(fileId) {
      const data = await call<SlackBody & { file?: SlackFile }>("files.info", { file: fileId }, "GET");
      if (!data.file?.id) throw new SlackApiError("files.info", 200, `response carried no file for ${fileId}`);
      return data.file;
    },
    async fetchImage(file) {
      const { bytes, contentType } = await download(file);
      const mime = (file.mimetype ?? contentType?.split(";")[0]?.trim() ?? "").toLowerCase();
      if (!mime.startsWith("image/"))
        throw new Error(`Slack file ${file.id ?? "(unknown)"} is not an image (${mime || "unknown type"})`);
      return { mimeType: mime, data: bytes.toString("base64") };
    },
    async fetchFile(file, channelId, filesDir) {
      const { bytes } = await download(file);
      const dir = join(filesDir, channelId);
      await mkdir(dir, { recursive: true });
      const name = safeFileName(file);
      const path = join(dir, name);
      await writeFile(path, bytes);
      return { path, name, size: bytes.byteLength };
    },
  };
  return api;
}
