/**
 * pi 引擎的默认工具集 = pi 真正的内建核心 coding tools(read/bash/edit/write,同 pi 默认)。
 *
 * 口径(经场景推导翻转过一次,定稿):
 *   - **默认完整工具集 = 忠实性**:定义作者在 pi 本地是带全套工具 vibe 的,serving 砍工具
 *     = 行为漂移(同 base prompt 的逻辑)。直接用 pi-coding-agent 的工厂,工具名/描述/行为
 *     与 pi 本地逐字一致。
 *   - **工具层不是安全边界**:隔离是 K 侧 ExecutionEnv/sandbox 的职责(本地=用户自己的机器;
 *     AgentCore=microVM)。对公网收紧 = 显式传 `tools` 配置(如 createReadOnlyTools),是部署
 *     姿态,不是默认。
 *   - pi 工具的 operations 可注入(BashOperations 等),未来 sandbox adapter 换 operations
 *     即可,不锁本地 fs。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";

/** pi 核心默认工具集(read/bash/edit/write,与 pi 默认一致),rooted at cwd。 */
export function piDefaultTools(cwd: string): AgentTool[] {
  return createCodingTools(cwd) as AgentTool[];
}

/** 只读子集(read/grep/find/ls),公网暴露等收紧姿态用。 */
export function piReadOnlyTools(cwd: string): AgentTool[] {
  return createReadOnlyTools(cwd) as AgentTool[];
}
