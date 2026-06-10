/**
 * fastagent.config.ts —— 部署/装配选择(进 git;机密走 .env)。
 * agent 的身份与行为不在这里(在 AGENTS.md + skills/)。
 *
 * 跑:node ../../src/cli.ts dev .   (真实用户:fastagent dev)
 */
import { defineConfig } from "../../src/index.ts"; // 真实用户:from "@fastagent/core"
import lookupOrderTool from "../lookup-order-tool.ts";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  tools: [lookupOrderTool], // 追加在 pi 默认工具(read/bash/edit/write)之后
  http: { port: 8787 },
});
