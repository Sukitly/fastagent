---
title: Agent Handler — 协议规范
type: spec
status: locked
version: 0.1
updated: 2026-06-09
share_link: https://qsort.me/neypsf87
share_updated: 2026-06-08T16:43:43+08:00
---

# Agent Handler — Protocol Specification v0.1 (locked)

> agent 层的 handler 约定,对标 Web 的 fetch handler。一个函数 + 几条 MUST,让任意 **Caller** 驱动任意 **Agent**,而无需知道对方的引擎、模型、wire 或部署形态。
>
> 关键词 MUST / MUST NOT / SHOULD / MAY 按 RFC 2119 解释。本规范是引擎中立的协议层,不依赖任何具体实现。

## 1. Overview

三个角色:
- **Agent**:实现 `invoke` 的对象。接收一次调用,跑一个 turn,流式产出事件。对 Caller 是黑盒。
- **Caller**:发起调用的一方——channel / trigger / CLI / 对外 wire adapter(A2A、ACP)。
- **Middleware**:同时是 Caller 和 Agent——包装下游 Agent,暴露同一接口(auth / 预算 / 日志)。

`invoke` 不对外。对外 wire 是 HTTP / A2A / ACP;`invoke` 是 Caller 与 Agent 之间的内部约定。

## 2. The Agent Handler

```ts
interface Agent {
  invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>;
}
```

一个 turn = 一次 `invoke`。返回一个异步事件流;buffered 是它的退化(§7)。

返回类型 MUST 是 `AsyncIterable`(`async function*`、`ReadableStream` 等任意实现皆可)。

## 3. Scope

```ts
interface Scope {
  session: string;          // 会话锚:跨 invoke 连接上下文
}
```

`session` 是 opaque 字符串,由 Caller 拥有;同一逻辑会话的多次 turn MUST 复用同一 `session`。其余字段(身份、来源、约束等)是扩展,见 §8。

## 4. Prompt

```ts
interface Prompt { text: string; images?: ImageRef[]; }
interface ImageRef { mimeType: string; data: string; }   // base64
```

不支持 `images` 的 Agent 忽略它。

## 5. AgentEvent

```ts
type AgentEvent =
  | { type: "text";         delta: string }
  | { type: "tool_started"; id: string; name: string; args: Json }
  | { type: "tool_ended";   id: string; isError: boolean; content: Json }
  | { type: "completed";    data?: Json }                        // 终局:成功
  | { type: "failed";       details: string; retryable: boolean }; // 终局:失败

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
```

- 所有文本走 `text` delta;`completed` 是纯终局信号,不重复全文。
- `completed.data` 仅在引擎能产出结构化结果时附带。
- 事件 MUST 可 JSON 序列化。

## 6. Conformance

一次 `invoke` 的流 MUST 恰好以下列三者之一终止:

- **(a) `completed`** — 成功;
- **(b) `failed`** — 失败;
- **(c) 被 Caller 取消** — 无终局事件。

下面的 MUST 是这个三分法在两个角色上的展开。

### Agent MUST

1. **终局唯一**:当 Caller 消费到流自然结束(未取消)时,最后一个事件 MUST 是 `completed` 或 `failed` 之一,其后无任何事件。对应 (a)/(b)。
2. **失败即事件,不 throw**:Agent MUST NOT 让 `invoke` 的迭代抛出异常;所有失败 MUST 表现为一个 `failed` 事件。这是终局集对消费者闭合的前提——失败只有一条通道。
3. **响应 cancel**:当 Caller 停止消费(`for-await` break / 迭代器 `return()` / `ReadableStream` 的 `reader.cancel()`)时,Agent MUST 尽快中止在飞的模型/工具调用并释放资源;此时不要求、也不期望发终局事件。对应 (c)。

### Caller MUST

4. **前向兼容**:终局集 `{ completed, failed }` 冻结,不可扩展;新增事件 MUST 是非终局的。**终局消费者**(消费流以得到结果的 Caller)MUST 忽略 `type` 未知的非终局事件。
5. **中继转发**:作为 **Middleware** 转发下游流的 Caller MUST 原样透传未知的非终局事件,MUST NOT 丢弃——「忽略」只适用于终局消费者,不适用于中继者。否则下游引擎新增的事件会在中继跳被吞掉,破坏 MUST 4 想保证的前向兼容。

### Portable conformance(可选;声明"可 serverless 部署"的 Agent 额外满足)

6. **无位置依赖**:MUST NOT 依赖"同一 `session` 的多次 `invoke` 落在同一进程/实例";会话状态须可从外部重建。常驻有状态 Agent 不满足此项,但仍是合规的 Agent Handler。

### 显式不保证(避免误读)

协议**不**保证下列两点,实现/消费者 MUST NOT 依赖它们:

- **`tool_started` / `tool_ended` 配对**:常态下两者按 `id` 成对、`ended` 跟在对应 `started` 后;但取消 (c) 时可能留下悬空的 `tool_started`。渲染 tool UI 的消费者须容忍悬空 started。
- **`failed.retryable` 的会话洁净度**:`retryable: true` 只表示"值得用同一 `session` 重发",**不**保证失败的 turn 对会话状态是原子的——半跑的 turn 可能已写入 entry / 跑过带副作用的 tool。重试的副作用安全是引擎/工具的责任(§9),不在协议层兑现。

## 7. Buffered

不需要流式的 Caller 用一行 helper 退化成 buffered(caller-side,不属协议):

```ts
async function collect(events: AsyncIterable<AgentEvent>): Promise<{ text: string; data?: Json }> {
  let text = "";
  for await (const e of events) {
    if (e.type === "text") text += e.delta;
    else if (e.type === "completed") return { text, data: e.data };
    else if (e.type === "failed") throw new AgentFailure(e.details, e.retryable);
  }
  throw new Error("stream ended without a terminal event"); // 违反 MUST 1
}
```

## 8. Extension points

核心保持最小;以下通过加 `scope` 字段 / 加非终局事件 / 加可选参数 / Middleware 挂上:

| 扩展 | 怎么挂 |
|---|---|
| 身份 / 多租户 | `scope.principal`(如 `{ type, issuer, subject }`) |
| 触发来源 / trace | `scope.source` 等标识性字段 |
| 执行约束(deadline / budget) | Middleware(`budget_exceeded` 由 Middleware 产出 `failed`) |
| 中途 steering | **(扩展,非 v0.1 核心签名)** `invoke` 增加可选第三参 `input?: AsyncIterable<Prompt>`,把输入塞进正在跑的 turn(对应 pi `steer/followUp/nextTurn`)。注:愿意丢弃当前 turn 的「换个方向」用 cancel + 同 `session` 重新 invoke 即可,无需此扩展 |
| thinking / citation / artifact 流 | 新增非终局 `AgentEvent` type |
| 失败细分 | `failed.code?` |

## 9. Dependency inversion

协议把 Agent 当黑盒。以下全在黑盒内、由实现注入,规范不规定:

| 注入项 | 说明 |
|---|---|
| 会话状态存到哪 | SessionStore(jsonl / pg / ddb) |
| 工具在哪个 env 跑 | 执行环境(local / sandbox / e2b) |
| 用哪个 model | 注入 |
| 有哪些 tools / 加载什么 agent 定义 | driver 注入 |

## 10. Out of scope

- **Wire / transport**:对外用 A2A / ACP / 自定义 HTTP;Agent Handler 是它们内部调到的那一层。
- **引擎内部**:turn loop / tool / model / context 管理。
- **agent 定义格式**:`AGENTS.md` / Agent Skills / MCP consume 既有标准,不另立。
- **打包 / 部署**:OCI / target runtime,consume OCI / ADP。
- **Task 编排**:长任务状态机 / Artifact 版本 = 上层(A2A Task / workflow),用 Caller 造,不进协议。

## 11. 与既有标准的关系

| 层 | Web | agent |
|---|---|---|
| 对外 wire | HTTP | A2A / ACP |
| gateway 约定 | fetch handler `(Request)=>Response` | **Agent Handler `invoke(scope, prompt)=>AsyncIterable<AgentEvent>`** |
| 引擎/app 内部 | 框架/业务 | agent 引擎 |

## 最小示例

```ts
async function* invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
  try {
    for await (const chunk of model.stream(scope.session, prompt.text)) {
      if (chunk.kind === "text") yield { type: "text", delta: chunk.text };
      if (chunk.kind === "tool") {
        yield { type: "tool_started", id: chunk.id, name: chunk.name, args: chunk.args };
        const r = await runTool(chunk);
        yield { type: "tool_ended", id: chunk.id, isError: r.error, content: r.content };
      }
    }
    yield { type: "completed" };
  } catch (e) {
    yield { type: "failed", details: String(e), retryable: isTransient(e) };
  }
}

// 流式
for await (const e of agent.invoke({ session: "s1" }, { text: "triage issue #42" })) {
  if (e.type === "text") process.stdout.write(e.delta);
}
// buffered
const { text } = await collect(agent.invoke({ session: "s1" }, { text: "…" }));
```
