/**
 * Agent Handler 协议 v0.1 —— 契约层,纯类型,零依赖(sansio)。
 * 这是引擎中立的抽象(见 docs/SPEC.md):caller 与 engine 都依赖它。
 * 不允许 import 任何引擎实现(`@earendil-works/pi-*` 只准出现在 engines/ 下)。
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

/** base64 编码的图片引用。 */
export interface ImageRef {
  mimeType: string;
  data: string;
}

export interface Prompt {
  text: string;
  images?: ImageRef[];
}

/** 调用作用域。核心只一个 `session` 锚;其余字段是扩展(SPEC §8)。 */
export interface Scope {
  /** opaque 会话锚:同一逻辑会话的多次 turn MUST 复用同一值。 */
  session: string;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended"; id: string; isError: boolean; content: Json }
  /** 终局:成功。`data` 仅在引擎能产出结构化结果时附带。 */
  | { type: "completed"; data?: Json }
  /** 终局:失败。`retryable` 表示值得用同一 session 重发。 */
  | { type: "failed"; details: string; retryable: boolean };

/**
 * 一个 turn = 一次 invoke。返回单一异步事件流。
 * 流 MUST 恰好以 completed / failed 终止,或被 caller 取消(无终局事件)。
 * Agent 是契约(interface),不是基类:任意 AsyncIterable 生产者实现它即合规。
 */
export interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
