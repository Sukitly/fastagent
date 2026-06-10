/**
 * 旗舰 demo:「指向定义文件夹 → agent」(#3 driver)。
 *
 * examples/agent/ 里只有标准文件(AGENTS.md + skills/),零代码;
 * driver 读出 instructions + skills,组装 system prompt,挂上 read 工具 → 可服务的 agent。
 *
 * 运行:
 *   node examples/definition.ts "My app crashes when I click save"
 *   node examples/definition.ts "Can I get my money back? Bought it 3 weeks ago"   # 触发 refund-policy skill
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getModel } from "@earendil-works/pi-ai";
import { createPiAgentFromDefinition, piDefaultTools } from "../src/index.ts";
import lookupOrderTool from "./lookup-order-tool.ts";

setGlobalDispatcher(new EnvHttpProxyAgent());

// 自定义 code tool = 显式 import + 注入(类型检查、可重构,无魔法目录)。
const dir = join(dirname(fileURLToPath(import.meta.url)), "agent");
const { agent, definition } = await createPiAgentFromDefinition(dir, {
  model: getModel("openai-codex", "gpt-5.5"),
  tools: [...piDefaultTools(dir), lookupOrderTool],
});

console.error(`[definition] ${definition.dir}`);
console.error(`[instructions] ${definition.instructions ? "AGENTS.md loaded" : "(none)"}`);
console.error(`[skills] ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
for (const d of definition.diagnostics) console.error(`[warn] ${d.code}: ${d.message}`);
console.error();

const text = process.argv.slice(2).join(" ").trim() || "My app crashes when I click save";
for await (const e of agent.invoke({ session: "triage" }, { text })) {
  if (e.type === "text") process.stdout.write(e.delta);
  else if (e.type === "tool_started") process.stdout.write(`\n[tool ${e.name} ${JSON.stringify(e.args)}]\n`);
  else if (e.type === "tool_ended") process.stdout.write(`[tool done]\n`);
  else if (e.type === "completed") process.stdout.write("\n");
  else if (e.type === "failed") process.stdout.write(`\n[failed: ${e.details}]\n`);
}
process.exit(0);
