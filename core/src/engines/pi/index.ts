/**
 * pi 参考实现:把 pi AgentHarness 的双口
 * (subscribe 事件旁路 + prompt 终值)fan-in 成 SPEC 的单一事件流。
 *
 * createAgent 返回一个**实现 Agent 契约**的对象(组合,非继承):
 * 它 has-a harness + translate + queue,组合出 invoke。
 *
 * 并发:同 session 同一时刻只允许一个在飞 turn。争用 = fail-fast:第二个 invoke
 * 立即 yield `failed{retryable}`("session busy"),把 dedupe/排队/steering 的 UX 决策交给 channel。
 * 每 invoke 现起一个绑该 session 的 harness,用完即弃(无状态多-session)。
 * session 的造法、env/model/tools 注入,全在调用方传入的 buildHarness 工厂里。
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Agent, AgentEvent, Prompt, Scope } from "../../agent.ts";
import type { BuildHarness } from "./harness.ts";
import { type Lease, inProcessLease } from "./lease.ts";
import { EventQueue } from "./queue.ts";
import { errorToTerminal, toAgentEvent, toTerminal } from "./translate.ts";

export interface CreateAgentOptions {
  buildHarness: BuildHarness;
  /** 单写者租约。缺省进程内 per-session mutex(同 session 串行)。 */
  lease?: Lease;
}

export function createAgent(options: CreateAgentOptions): Agent {
  const { buildHarness, lease = inProcessLease() } = options;

  async function* invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
    // fail-fast 单写者:同 session 已有在飞 turn 则立即 busy,不排队。
    // 同步 tryAcquire → acquire 与进 try 之间无 await,取消任意处都能在 finally 释放。
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      yield {
        type: "failed",
        details: "session busy: a turn is already in flight for this session",
        retryable: true,
      };
      return;
    }
    try {
      let harness;
      try {
        harness = await buildHarness(scope.session);
      } catch (error) {
        // setup 失败(session 打不开 / 认证等)也 MUST 是 failed 事件,不能 throw。
        yield errorToTerminal(error);
        return;
      }

      const queue = new EventQueue<AgentEvent>();
      const unsub = harness.subscribe((pe) => {
        const event = toAgentEvent(pe);
        if (event) queue.push(event);
      });
      try {
        const run = harness.prompt(prompt.text, toPromptOptions(prompt));
        // 边跑边 yield text / tool_*,直到 run settle 且缓冲排空。
        yield* queue.drainUntil(run);
        // 终局以 resolved message 的 stopReason 为准;catch 只兜底真 throw。
        let terminal: AgentEvent;
        try {
          terminal = toTerminal(await run);
        } catch (error) {
          terminal = errorToTerminal(error);
        }
        yield terminal;
      } finally {
        // cancel(generator return → finally)与正常结束都走这。清理必须**绝不抛**:
        // 否则 abort()/unsub() 的异常会在已 yield 终局之后让迭代 throw,污染已闭合的
        // 事件流(违 SPEC MUST 2 / MUST 3)。
        try {
          unsub();
        } catch {
          // ignore
        }
        try {
          await harness.abort();
        } catch {
          // ignore
        }
      }
    } finally {
      release(); // cleanup 之后释放租约,让同 session 下一个 invoke 进场
    }
  }

  return { invoke };
}

function toPromptOptions(prompt: Prompt): { images?: ImageContent[] } | undefined {
  if (!prompt.images || prompt.images.length === 0) return undefined;
  return {
    images: prompt.images.map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    })),
  };
}
