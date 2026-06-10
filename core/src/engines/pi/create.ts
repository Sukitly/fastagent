/**
 * createPiAgent —— 一次调用起一个 pi agent,batteries-included。
 *
 * 它把「createAgent + piHarnessFactory + 默认 repo/env/auth/lease」收成一个调用,
 * 让 app 代码不必直接拼 pi 的 InMemorySessionRepo / NodeExecutionEnv。
 * 所有默认都可 override:production 注入 jsonl/pg/ddb repo、sandbox/e2b env 等。
 */
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import type { AuthResolver } from "./auth.ts";
import { type SessionRepoLike, piHarnessFactory } from "./harness.ts";
import { createAgent } from "./index.ts";
import type { Lease } from "./lease.ts";

export interface CreatePiAgentOptions {
  model: Model<any>;
  systemPrompt?: string;
  tools?: AgentTool[];
  /** 模型可见/可显式调用的 skills(driver 产出;作为 harness resources 注入)。 */
  skills?: Skill[];
  /** session 持久化。缺省进程内 InMemorySessionRepo(dev);production 注入 jsonl/pg/ddb。 */
  repo?: SessionRepoLike;
  /** 工具执行环境。缺省本地 NodeExecutionEnv(cwd);production 注入 sandbox/e2b。 */
  env?: ExecutionEnv;
  /** 认证解析。缺省 resolvePiAuth()(先 pi OAuth,再环境变量)。 */
  getApiKeyAndHeaders?: AuthResolver;
  /** 单写者租约。缺省进程内 fail-fast inProcessLease()。 */
  lease?: Lease;
}

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
