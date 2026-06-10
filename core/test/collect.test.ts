import { describe, expect, it } from "vitest";
import { AgentFailure, collect, type AgentEvent } from "../src/index.ts";

async function* stream(...events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

describe("collect (buffered 消费)", () => {
  it("拼接 text,completed 返回 {text, data}", async () => {
    const result = await collect(
      stream(
        { type: "text", delta: "hello " },
        { type: "text", delta: "world" },
        { type: "completed", data: { ok: true } },
      ),
    );
    expect(result).toEqual({ text: "hello world", data: { ok: true } });
  });

  it("failed → throw AgentFailure(带 details/retryable)", async () => {
    await expect(
      collect(stream({ type: "text", delta: "x" }, { type: "failed", details: "boom", retryable: true })),
    ).rejects.toMatchObject({ name: "AgentFailure", details: "boom", retryable: true });
    expect(AgentFailure).toBeTypeOf("function");
  });

  it("无终局 → throw(违反 MUST 1)", async () => {
    await expect(collect(stream({ type: "text", delta: "x" }))).rejects.toThrow(/terminal/);
  });
});
