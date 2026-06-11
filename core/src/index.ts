// Protocol contract (neutral, engine-free)
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";

// Channels (N-side; consume only the Agent contract)
export { createInvokeHandler } from "./channels/http.ts";

// pi reference implementation — assembly ladder (L1/L2; L0 below)
export {
  createPiAgent,
  createPiAgentFromDefinition,
  type CreatePiAgentOptions,
  type CreatePiAgentFromDefinitionOptions,
} from "./engines/pi/create.ts";

// pi reference implementation — definition domain (load / bundle)
export {
  loadAgentDefinition,
  bundleAgentDefinition,
  defaultGlobalSkillPaths,
  type LoadedDefinition,
  type LoadAgentDefinitionOptions,
  type SkillCollision,
} from "./engines/pi/definition.ts";

// pi reference implementation — prompt assembly (pure)
export {
  piBasePrompt,
  assembleSystemPrompt,
  type AssembleSystemPromptOptions,
} from "./engines/pi/prompt.ts";

// pi reference implementation — tools & config
export { piDefaultTools, piReadOnlyTools } from "./engines/pi/tools.ts";
export {
  defineConfig,
  loadConfig,
  resolveModel,
  type FastagentConfig,
  type LoadedConfig,
} from "./engines/pi/config.ts";

// pi reference implementation — low-level building blocks (escape hatch; L0)
export { createAgent, type CreateAgentOptions } from "./engines/pi/invoke.ts";
export { type Lease, type Release, inProcessLease } from "./engines/pi/lease.ts";
export {
  piHarnessFactory,
  type BuildHarness,
  type PiHarnessConfig,
  type SessionRepoLike,
} from "./engines/pi/harness.ts";
export { type Auth, type AuthResolver, envAuth, piOAuthAuth, resolvePiAuth } from "./engines/pi/auth.ts";
