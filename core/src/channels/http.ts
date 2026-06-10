/**
 * 最小 HTTP channel 的纯处理器(无副作用,可测):把 invoke 的单流 fan-out 到 SSE。
 *   - POST /invoke {session,text} → text/event-stream,每个 AgentEvent 一行 `data:`;
 *   - 客户端断开 → iterator.return() → invoke 取消(SPEC MUST 3);
 *   - 同 session 并发 → createAgent 的 fail-fast lease 让第二个收到 `failed{session busy}`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "../agent.ts";

export function createInvokeHandler(agent: Agent) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404, { "content-type": "text/plain" }).end("POST /invoke\n");
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("invalid json\n");
      return;
    }
    const { session, text } = (payload ?? {}) as { session?: unknown; text?: unknown };
    if (typeof session !== "string" || typeof text !== "string") {
      res.writeHead(400, { "content-type": "text/plain" }).end('need { "session": string, "text": string }\n');
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // 显式取迭代器:客户端断开时 return() 它 → invoke 走 cancel 清理(MUST 3)。
    const iterator = agent.invoke({ session }, { text })[Symbol.asyncIterator]();
    req.on("close", () => void iterator.return?.());
    try {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        res.write(`data: ${JSON.stringify(value)}\n\n`);
      }
    } finally {
      res.end();
    }
  };
}
