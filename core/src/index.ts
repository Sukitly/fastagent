// 协议契约(中立)
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";

// pi 参考实现
export { createPiAgent, type CreatePiAgentOptions } from "./engines/pi/create.ts";
export {
  loadAgentDefinition,
  assembleSystemPrompt,
  createPiAgentFromDefinition,
  piBasePrompt,
  bundleAgentDefinition,
  defaultGlobalSkillPaths,
  type AgentDefinition,
  type AssembleSystemPromptOptions,
  type CreatePiAgentFromDefinitionOptions,
  type LoadAgentDefinitionOptions,
  type SkillCollision,
} from "./engines/pi/driver.ts";
export { piDefaultTools, piReadOnlyTools } from "./engines/pi/tools.ts";
export {
  defineConfig,
  loadConfig,
  pickModelSpec,
  resolveModel,
  type FastagentConfig,
  type LoadedConfig,
} from "./engines/pi/config.ts";

// channels(N 侧,只吃 Agent 契约)
export { createInvokeHandler } from "./channels/http.ts";
export { createAgent, type CreateAgentOptions } from "./engines/pi/index.ts";
export { type Lease, type Release, inProcessLease } from "./engines/pi/lease.ts";
export {
  piHarnessFactory,
  type BuildHarness,
  type PiHarnessConfig,
  type SessionRepoLike,
} from "./engines/pi/harness.ts";
export {
  type Auth,
  type AuthResolver,
  envAuth,
  piOAuthAuth,
  resolvePiAuth,
  PI_AUTH_PATH,
} from "./engines/pi/auth.ts";
