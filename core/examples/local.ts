/**
 * 本地真跑最小串行 agent。
 *
 * 认证、session 持久化、执行环境都由 createPiAgent 的默认处理(dev batteries-included),
 * 本文件只管两件 **应用级** 的事:进程级代理、选哪个 model。
 *
 * 运行(Node 26 原生跑 .ts):
 *   node examples/local.ts "say hi in 3 words"   # 一次性
 *   node examples/local.ts                        # REPL,同一 session 多轮有记忆,/exit 退出
 *   node examples/local.ts --busy-demo            # 同 session 并发 → 一个跑、一个 session busy
 */
import { createInterface } from "node:readline/promises";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getModel } from "@earendil-works/pi-ai";
import { AgentFailure, collect, createPiAgent, type AgentEvent } from "../src/index.ts";

// 进程级网络配置归应用入口:Node 的 fetch 默认不读 HTTPS_PROXY,本地走代理才能到被墙的 provider。
setGlobalDispatcher(new EnvHttpProxyAgent());

const agent = createPiAgent({
  model: getModel("openai-codex", "gpt-5.5"),
  systemPrompt: "You are a concise, helpful assistant. Keep answers short.",
});

/** 流式渲染一个 turn 到 stdout。 */
async function turn(text: string): Promise<void> {
  process.stdout.write("agent> ");
  for await (const e of agent.invoke({ session: "local" }, { text })) {
    if (e.type === "text") process.stdout.write(e.delta);
    else if (e.type === "tool_started") process.stdout.write(`\n[tool ${e.name} ${JSON.stringify(e.args)}]\n`);
    else if (e.type === "tool_ended") process.stdout.write(`[tool done]\n`);
    else if (e.type === "completed") process.stdout.write("\n");
    else if (e.type === "failed") process.stdout.write(`\n[failed: ${e.details} (retryable=${e.retryable})]\n`);
  }
}

const arg = process.argv.slice(2).join(" ").trim();

if (arg === "--busy-demo") {
  // 演示 fail-fast:同 session 并发 → A 跑、B 立即 session busy(REPL 是串行的,只能这样演示)。
  console.log("同 session 并发:A 跑、B 应立即 session busy\n");
  const summarize = async (label: string, stream: AsyncIterable<AgentEvent>) => {
    try {
      const { text } = await collect(stream); // buffered 消费 + 终局纪律
      console.log(`[${label}] completed: ${text.slice(0, 60)}…`);
    } catch (e) {
      if (e instanceof AgentFailure) console.log(`[${label}] failed: ${e.details} (retryable=${e.retryable})`);
      else throw e;
    }
  };
  await Promise.all([
    summarize("A", agent.invoke({ session: "d" }, { text: "Count slowly from 1 to 8." })),
    summarize("B", agent.invoke({ session: "d" }, { text: "Say hi." })),
  ]);
  process.exit(0);
}

if (arg) {
  await turn(arg);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("最小串行 agent。输入消息,/exit 退出。同一 session 多轮有记忆。\n");
  while (true) {
    const text = (await rl.question("you> ")).trim();
    if (!text || text === "/exit") break;
    await turn(text);
  }
  rl.close();
}

// undici 代理 agent 的 keep-alive 连接会吊住事件循环;demo 跑完显式退出。
process.exit(0);
