/**
 * Buffered 消费 helper(caller-side,SPEC §7)。
 * 把 AgentEvent 流收成终值,并封装终局纪律:failed → throw,无终局 → 报错。
 * 流式消费(边跑边渲染 / 转 SSE)仍由 caller 自己 for-await——那是各自的 UI/wire,不强求统一。
 */
import type { AgentEvent, Json } from "./agent.ts";

/** failed 事件的异常形态(collect 用)。 */
export class AgentFailure extends Error {
  readonly details: string;
  readonly retryable: boolean;
  constructor(details: string, retryable: boolean) {
    super(details);
    this.name = "AgentFailure";
    this.details = details;
    this.retryable = retryable;
  }
}

export interface CollectResult {
  text: string;
  data?: Json;
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<CollectResult> {
  let text = "";
  for await (const e of events) {
    if (e.type === "text") text += e.delta;
    else if (e.type === "completed") return { text, data: e.data };
    else if (e.type === "failed") throw new AgentFailure(e.details, e.retryable);
  }
  throw new Error("stream ended without a terminal event"); // 违反 SPEC MUST 1
}
