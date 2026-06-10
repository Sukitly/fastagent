/**
 * pi 事件/终值 → SPEC AgentEvent 的映射。
 *   - toAgentEvent: 流内事件(text / tool_*),其余 pi 事件返回 null 丢弃。
 *   - toTerminal:   pi `prompt()` resolve 的 AssistantMessage → completed / failed。
 *   - errorToTerminal: catch 兜底,真正 throw 的异常 → failed。
 */
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, Json } from "../../agent.ts";

/** 流内事件映射。非 text/tool_* 的 pi 事件(turn_start、message_start…)一律丢弃。 */
export function toAgentEvent(pe: AgentHarnessEvent): AgentEvent | null {
  switch (pe.type) {
    case "message_update":
      if (pe.assistantMessageEvent.type === "text_delta") {
        return { type: "text", delta: pe.assistantMessageEvent.delta };
      }
      return null;
    case "tool_execution_start":
      return {
        type: "tool_started",
        id: pe.toolCallId,
        name: pe.toolName,
        args: pe.args as Json,
      };
    case "tool_execution_end":
      return {
        type: "tool_ended",
        id: pe.toolCallId,
        isError: pe.isError,
        content: pe.result as Json,
      };
    default:
      return null;
  }
}

/**
 * 终局映射。**以 resolved message 的 stopReason 为准**(core-design §8):
 * pi 的 prompt() 在模型错误/abort 时不一定 throw,常态是 resolve 一个
 * stopReason: "error" | "aborted" 的 message。光靠 catch 会漏掉这类失败(违反 MUST 1)。
 */
export function toTerminal(message: AssistantMessage): AgentEvent {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const details = message.errorMessage ?? `model stopped: ${message.stopReason}`;
    return { type: "failed", details, retryable: isRetryable(details) };
  }
  return { type: "completed" };
}

/** catch 兜底:真正 throw 出来的异常 → failed。 */
export function errorToTerminal(error: unknown): AgentEvent {
  const details = error instanceof Error ? error.message : String(error);
  return { type: "failed", details, retryable: isRetryable(details) };
}

/** 极简 retryable 启发式(pi 的 _isRetryableError 未导出)。命中瞬时类错误模式即可重发。 */
const RETRYABLE =
  /\b(429|5\d\d|timeout|timed out|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up)\b/i;

function isRetryable(details: string): boolean {
  return RETRYABLE.test(details);
}
