/**
 * fastagent.config.ts —— 三层中的第 2 层(production source):部署/装配选择,进 git,机密走 .env。
 *
 * v1 刻意只有 3 个键(每个都过"一句话讲得清 + 有近期故事"的门槛):
 *   - model:用哪个 LLM("provider/modelId" 字符串,可序列化、可被 CLI flag 覆盖);
 *   - tools:额外的自定义工具,追加在 pi 默认工具之后;
 *   - http:内置 HTTP channel 的 serving 选项。
 *
 * 刻意不在 v1 的(留在库 API 作逃生舱):
 *   - sessions/env 选型 —— K 轴,等 hosting 刀由真实后端定形状;
 *   - base/auth/skillPaths 覆盖 —— 默认几乎总是对的,放 config 邀请误用。
 *
 * 红线:config 描述"这次部署的选择",绝不描述 agent 的身份/行为(那在 AGENTS.md + skills)。
 * 删掉 config 应当仍可 zero-config 跑(model 从 --model / FASTAGENT_MODEL 来)。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";

export interface FastagentConfig {
  /** "provider/modelId",如 "openai-codex/gpt-5.5"。优先级:CLI --model > config > FASTAGENT_MODEL。 */
  model?: string;
  /** 额外的自定义工具(追加在 pi 默认工具 read/bash/edit/write 之后,不替换)。 */
  tools?: AgentTool[];
  /** 内置 HTTP channel 选项。 */
  http?: { port?: number };
}

/** identity 函数,只为类型与 IDE 补全(vite/next 同款模式)。 */
export function defineConfig(config: FastagentConfig): FastagentConfig {
  return config;
}

export interface LoadedConfig {
  config: FastagentConfig;
  /** 配置文件路径;无配置文件(zero-config)时 undefined。 */
  path?: string;
}

/** 装载 `<dir>/fastagent.config.ts|.js|.mjs`。无文件 = zero-config({});有文件但形状不对 = 抛(fail visibly)。 */
export async function loadConfig(dir: string): Promise<LoadedConfig> {
  for (const name of ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    const config = mod.default;
    if (!config || typeof config !== "object") {
      throw new Error(`${path}: must default-export defineConfig({...})`);
    }
    const c = config as FastagentConfig;
    if (c.model !== undefined && typeof c.model !== "string") {
      throw new Error(`${path}: "model" must be a "provider/modelId" string`);
    }
    if (c.tools !== undefined && !Array.isArray(c.tools)) {
      throw new Error(`${path}: "tools" must be an array of AgentTool`);
    }
    return { config: c, path };
  }
  return { config: {} };
}

/** 解析 "provider/modelId" → pi Model。未知即抛清晰错误(getModel 返回 undefined)。 */
export function resolveModel(spec: string): Model<any> {
  const slash = spec.indexOf("/");
  if (slash < 1 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/modelId" (e.g. "openai-codex/gpt-5.5"), got "${spec}"`);
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const model = getModel(provider as never, modelId as never) as Model<any> | undefined;
  if (!model) {
    throw new Error(`unknown model "${spec}" (provider "${provider}" / id "${modelId}" not in registry)`);
  }
  return model;
}

/** model 选择优先级:CLI flag > config > 环境变量 FASTAGENT_MODEL。都没有 = undefined(调用方报错)。 */
export function pickModelSpec(
  flag: string | undefined,
  config: FastagentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return flag ?? config.model ?? env.FASTAGENT_MODEL;
}
