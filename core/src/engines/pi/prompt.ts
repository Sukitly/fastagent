/**
 * Four-segment system prompt assembly (core-design §2): AGENTS.md ≠ system prompt.
 *
 *   systemPrompt = ① base (engine asset) + ② instructions (<project_instructions>-wrapped)
 *                + ③ skills listing + ④ env context (date/cwd)
 *
 * Pure functions: no IO, no clock — segment ④ inputs (date/cwd) are provided by the
 * caller, so the same inputs always produce the same prompt (testable, reproducible).
 */
import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";

/**
 * The pi engine's base prompt (segment ①, inherited from the engine — not invented
 * by fastagent).
 *
 * Mirrors pi-coding-agent's buildSystemPrompt default path (identity + tool list +
 * guidelines), with two deliberate deviations: the pi-TUI docs section is dropped
 * (those local paths do not exist in deployments), and the tool list is generated
 * from the **actually mounted tools** (base and toolset must agree — pi's own
 * parameterization). Future claude/codex engine bindings will not need this: their
 * SDKs assemble their own prompts internally.
 */
export function piBasePrompt(options: { tools?: AgentTool[] } = {}): string {
  const tools = options.tools ?? [];
  const toolsList =
    tools.length > 0
      ? tools.map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0]}`).join("\n")
      : "(none)";
  return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files`;
}

export interface AssembleSystemPromptOptions {
  /** Base prompt (①). Defaults to piBasePrompt() (engine-inherited; callers passing tools should use piBasePrompt({tools})). */
  base?: string;
  /** ② AGENTS.md content (verbatim), injected wrapped — never pasted bare. */
  instructions?: string;
  /** Path rendered into the <project_instructions path=…> attribute (lets the model re-read the file). */
  instructionsPath?: string;
  /** ③ Skills for the <available_skills> listing. */
  skills?: Skill[];
  /** ④ Env context, caller-provided (keeps this function pure). Omitted = segment omitted. */
  date?: string;
  cwd?: string;
}

/** Assemble the final system prompt (four segments, with the pi-isomorphic <project_instructions> wrapper). */
export function assembleSystemPrompt(options: AssembleSystemPromptOptions): string {
  let prompt = options.base ?? piBasePrompt();
  if (options.instructions) {
    const pathAttr = options.instructionsPath ? ` path="${options.instructionsPath}"` : "";
    prompt +=
      `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n` +
      `<project_instructions${pathAttr}>\n${options.instructions}\n</project_instructions>\n\n</project_context>\n`;
  }
  if (options.skills && options.skills.length > 0) {
    prompt += `\n${formatSkillsForSystemPrompt(options.skills)}\n`;
  }
  if (options.date) prompt += `\nCurrent date: ${options.date}`;
  if (options.cwd) prompt += `\nCurrent working directory: ${options.cwd}`;
  return prompt;
}
