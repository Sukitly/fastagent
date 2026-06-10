/**
 * 最小 HTTP channel(N 侧第一个样本):POST /invoke → SSE 流出 AgentEvent。
 * 处理器在 http-channel.ts(纯、可测);本文件只做接线:代理 + agent + listen。
 *
 * 运行:
 *   node examples/http-server.ts
 *   curl -N -X POST localhost:8787/invoke -d '{"session":"s1","text":"hi in 3 words"}'
 *
 * 同 session 并发:第二个请求会立即收到 SSE `data: {"type":"failed",…,"retryable":true}`("session busy");
 * 不同 session 互不影响。dedupe/排队/steering 由 channel/上层决定,不在 core。
 */
import { createServer } from "node:http";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getModel } from "@earendil-works/pi-ai";
import { createPiAgent } from "../src/index.ts";
import { createInvokeHandler } from "../src/index.ts";

setGlobalDispatcher(new EnvHttpProxyAgent()); // 进程级:本地走代理才能到被墙 provider

const agent = createPiAgent({
  model: getModel("openai-codex", "gpt-5.5"),
  systemPrompt: "You are a concise, helpful assistant. Keep answers short.",
});

const server = createServer(createInvokeHandler(agent));
const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  console.log(`fastagent http channel on :${port}`);
  console.log(`  curl -N -X POST localhost:${port}/invoke -d '{"session":"s1","text":"hi in 3 words"}'`);
});
