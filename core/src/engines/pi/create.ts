/**
 * The assembly ladder — the single place where a pi agent gets put together.
 * Three rungs, each with its own consumer:
 *
 *   L0  createAgent({ buildHarness, lease })            (invoke.ts)
 *       Engine already wired; adds only the concurrency shell. For tests and
 *       fully custom wiring.
 *   L1  createPiAgent(options)                          (this file)
 *       Batteries-included: every M/K/auth input explicit, every default
 *       overridable. For embedding with hand-picked parts.
 *   L2  createPiAgentFromDefinition(dir, options)       (this file)
 *       "Point at a folder": definition.ts loads, prompt.ts assembles, then L1.
 *       For the CLI and folder-based embedding.
 *
 * Each rung only calls the one below; options narrow as you go up (L2 owns
 * systemPrompt/skills itself — they come from the definition, so its options
 * deliberately do not accept them).
 */
import { join } from "node:path";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import type { AuthResolver } from "./auth.ts";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";
import { type SessionRepoLike, piHarnessFactory } from "./harness.ts";
import { createAgent } from "./invoke.ts";
import type { Lease } from "./lease.ts";
import { assembleSystemPrompt, piBasePrompt } from "./prompt.ts";
import { piDefaultTools } from "./tools.ts";

/** L1 options, grouped by the two-axis model (core-design §6.1). */
export interface CreatePiAgentOptions {
  // ── M: what the agent is ───────────────────────────────────────────────
  model: Model<any>;
  /** The FINAL assembled prompt (see prompt.ts for assembly from parts). */
  systemPrompt?: string;
  tools?: AgentTool[];
  /** Skills visible to the model / explicitly invokable (injected as harness resources). */
  skills?: Skill[];
  // ── K: where/how it runs ───────────────────────────────────────────────
  /** Session persistence. Defaults to in-process InMemorySessionRepo (dev); production injects jsonl/pg/ddb. */
  repo?: SessionRepoLike;
  /** Tool execution environment. Defaults to local NodeExecutionEnv (cwd); production injects sandbox/e2b. */
  env?: ExecutionEnv;
  /** Single-writer lease. Defaults to in-process fail-fast inProcessLease(). */
  lease?: Lease;
  // ── auth: how it reaches the provider ──────────────────────────────────
  /** Auth resolution. Defaults to resolvePiAuth() (pi OAuth first, then env vars). */
  getApiKeyAndHeaders?: AuthResolver;
}

/** L1: batteries-included assembly. */
export function createPiAgent(options: CreatePiAgentOptions): Agent {
  return createAgent({
    lease: options.lease,
    buildHarness: piHarnessFactory({
      repo: options.repo ?? new InMemorySessionRepo(),
      env: options.env ?? new NodeExecutionEnv({ cwd: process.cwd() }),
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      skills: options.skills,
      getApiKeyAndHeaders: options.getApiKeyAndHeaders,
    }),
  });
}

/**
 * L2 options — written out explicitly (no Omit<> surgery) so the type can only
 * promise what the implementation honors. Notably absent by design:
 * `systemPrompt` (assembled from the definition) and `skills` (they come from
 * the definition folder — that is the whole point of L2).
 */
export interface CreatePiAgentFromDefinitionOptions {
  // ── M ──────────────────────────────────────────────────────────────────
  model: Model<any>;
  /** Override the base prompt (segment ①). Defaults to piBasePrompt({tools}) (engine-inherited). */
  base?: string;
  /** Override tools. Defaults to piDefaultTools (full pi toolset, fidelity; lock down with piReadOnlyTools or a custom list). */
  tools?: AgentTool[];
  /** Extra skills mount directories (see LoadAgentDefinitionOptions.skillPaths). */
  skillPaths?: string[];
  // ── K ──────────────────────────────────────────────────────────────────
  repo?: SessionRepoLike;
  env?: ExecutionEnv;
  lease?: Lease;
  // ── auth ───────────────────────────────────────────────────────────────
  getApiKeyAndHeaders?: AuthResolver;
}

/**
 * L2: "point at a folder → agent": load + assemble + L1 in one call.
 * Returns the definition so callers can surface diagnostics/collisions.
 */
export async function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }> {
  const env = options.env ?? new NodeExecutionEnv({ cwd: dir });
  const definition = await loadAgentDefinition(dir, { env, skillPaths: options.skillPaths });
  const tools = options.tools ?? piDefaultTools(env.cwd);
  const agent = createPiAgent({
    // M — assembled here from the definition (no spread: every field deliberate)
    model: options.model,
    systemPrompt: assembleSystemPrompt({
      base: options.base ?? piBasePrompt({ tools }),
      instructions: definition.instructions,
      instructionsPath: definition.instructions !== undefined ? join(definition.dir, "AGENTS.md") : undefined,
      skills: definition.skills,
      date: new Date().toISOString().slice(0, 10),
      cwd: env.cwd,
    }),
    tools,
    skills: definition.skills,
    // K + auth — pass-through
    repo: options.repo,
    env,
    lease: options.lease,
    getApiKeyAndHeaders: options.getApiKeyAndHeaders,
  });
  return { agent, definition };
}
