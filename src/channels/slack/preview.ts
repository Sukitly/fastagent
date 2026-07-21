/** Slack one-message preview lifecycle: post once, update at most every three seconds, settle in place. */
import type { AgentEvent } from "../../agent.ts";
import { log } from "../../log.ts";
import { type ChannelFailure, defaultErrorMessage, summarizeToolArgs } from "../preview-kit.ts";
import { truncateCodePointSuffix } from "../text.ts";
import { type SlackApi, type SlackTarget, chunkSlackText } from "./slack-api.ts";

export type SlackFailure = ChannelFailure;
export { defaultErrorMessage };

const UPDATE_THROTTLE_MS = 3000;
const THINKING_PREVIEW = 280;

async function finalize(
  api: SlackApi,
  target: SlackTarget,
  previewTs: string | undefined,
  text: string,
): Promise<void> {
  if (text.trim() === "") {
    if (previewTs) await api.deleteMessage(target.channelId, previewTs).catch(() => {});
    return;
  }
  const [head, ...rest] = chunkSlackText(text);
  if (previewTs && head !== undefined) {
    try {
      await api.updateMessage(target.channelId, previewTs, head);
    } catch {
      await api.deleteMessage(target.channelId, previewTs).catch(() => {});
      await api.sendText(target, text);
      return;
    }
    // The updated preview is now authoritative. A continuation failure must propagate without deleting
    // it and resending the full answer (which would duplicate any continuation that already landed).
    for (const chunk of rest) await api.postMessage(target, chunk);
    return;
  }
  await api.sendText(target, text);
}

export async function settleSlackPreview(
  api: SlackApi,
  target: SlackTarget,
  previewTs: string | undefined,
  text: string,
): Promise<void> {
  await finalize(api, target, previewTs, text);
}

export async function streamSlackReply(
  events: AsyncIterable<AgentEvent>,
  api: SlackApi,
  target: SlackTarget,
  formatError: (failure: SlackFailure) => string | undefined,
  initialPreviewTs?: string,
  label = "[slack]",
): Promise<void> {
  const tools: { label: string; status: "running" | "ok" | "error" }[] = [];
  const toolIndex = new Map<string, number>();
  let thinking = "";
  let answer = "";
  let answerPreviewSince: number | undefined;

  const toolView = (): string =>
    tools.map((tool) => `🔧 ${tool.label} ${{ running: "…", ok: "✓", error: "✗" }[tool.status]}`).join("\n");
  const thinkingView = (): string => {
    const value = thinking.replace(/\s+/g, " ").trim();
    return value ? `💭 ${truncateCodePointSuffix(value, THINKING_PREVIEW)}` : "";
  };
  const answerView = (): string =>
    answer.trim() && answerPreviewSince !== undefined && Date.now() - answerPreviewSince >= UPDATE_THROTTLE_MS
      ? answer
      : "";
  const view = (): string =>
    [thinkingView(), toolView(), answerView()]
      .filter((value) => value.trim())
      .join("\n\n")
      .trim() || "💭 Thinking…";

  let previewTs = initialPreviewTs;
  let previewAttempted = previewTs !== undefined;
  let finalized = false;
  let lastSent = "";
  const flushPreview = async (): Promise<void> => {
    const text = chunkSlackText(view())[0] ?? "💭 Thinking…";
    if (text === lastSent) return;
    lastSent = text;
    if (previewTs) {
      await api.updateMessage(target.channelId, previewTs, text);
      return;
    }
    if (previewAttempted) return;
    previewAttempted = true;
    previewTs = await api.postMessage(target, text);
  };

  let dirty = false;
  let pumping = false;
  let stopped = false;
  let previewErrorLogged = false;
  let pumpDone: Promise<void> | undefined;
  let wakeThrottle: (() => void) | undefined;

  const runPump = async (): Promise<void> => {
    pumping = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await flushPreview();
        } catch (error) {
          if (!previewErrorLogged) {
            previewErrorLogged = true;
            log.warn(`${label} live preview failed (final reply still sends): ${String(error)}`);
          }
        }
        if (dirty && !stopped) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, UPDATE_THROTTLE_MS);
            wakeThrottle = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wakeThrottle = undefined;
        }
      }
    } finally {
      pumping = false;
    }
  };
  const touch = (): void => {
    dirty = true;
    if (!pumping) pumpDone = runPump();
  };
  const finish = async (): Promise<void> => {
    stopped = true;
    wakeThrottle?.();
    await pumpDone?.catch(() => {});
  };

  touch();
  try {
    for await (const event of events) {
      if (event.type === "text") {
        answer += event.delta;
        if (answerPreviewSince === undefined && answer.trim()) answerPreviewSince = Date.now();
        touch();
      } else if (event.type === "thinking") {
        thinking += event.delta;
        touch();
      } else if (event.type === "tool_started") {
        const args = summarizeToolArgs(event.args);
        toolIndex.set(event.id, tools.length);
        tools.push({ label: args ? `${event.name} ${args}` : event.name, status: "running" });
        touch();
      } else if (event.type === "tool_ended") {
        const index = toolIndex.get(event.id);
        if (index !== undefined && tools[index]) tools[index].status = event.isError ? "error" : "ok";
        touch();
      } else if (event.type === "completed") {
        await finish();
        finalized = true;
        await finalize(api, target, previewTs, answer.trim() || "(no reply)");
        return;
      } else if (event.type === "failed") {
        await finish();
        finalized = true;
        const notice = formatError({ details: event.details, retryable: event.retryable }) ?? "";
        await finalize(api, target, previewTs, notice).catch((error) =>
          log.error(`${label} failed to deliver the agent-failure notice: ${String(error)}`),
        );
        throw new Error(`agent failed: ${event.details} (retryable=${event.retryable})`);
      }
    }
    throw new Error("stream ended without a terminal event");
  } finally {
    await finish();
    if (!finalized) {
      const notice = formatError({ details: "the turn ended without completing", retryable: false }) ?? "";
      await finalize(api, target, previewTs, notice).catch((error) =>
        log.error(`${label} failed to deliver the abnormal-turn notice: ${String(error)}`),
      );
    }
  }
}
