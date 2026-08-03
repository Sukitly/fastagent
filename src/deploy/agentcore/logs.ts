/**
 * AgentCore log discovery + tailing. AWS puts the container's stdout/stderr and its OTEL telemetry
 * in the same per-endpoint CloudWatch log group, while the forwarder Lambda has a separate group.
 * This operator surface resolves the stack's RuntimeArn, discovers the endpoint group by prefix, and
 * tails ONLY `[runtime-logs]` for the runtime source — the same application lines shown locally,
 * without mixing in spans/otel-rt-logs.
 */
import type { CliRunner } from "../runner.ts";
import { parseStackOutputs } from "./run.ts";

export type AgentcoreLogSource = "runtime" | "forwarder";

export interface AgentcoreLogsPlan {
  /** Deployment base name — stack `fastagent-<name>`, forwarder `fastagent-<name>-forwarder`. */
  name: string;
  source: AgentcoreLogSource;
  /** AWS CLI relative/ISO-8601 window (`10m`, `2h`, ...). Defaults to the CLI's own 10 minutes. */
  since?: string;
  follow: boolean;
}

export type AgentcoreLogsOutcome = { ok: true; logGroup: string } | { ok: false; gate: string };

/** Runtime id from `arn:...:runtime/<id>` — the id prefixes AgentCore's per-endpoint log group. */
function runtimeIdFromArn(arn: string): string | undefined {
  const marker = ":runtime/";
  const at = arn.lastIndexOf(marker);
  const id = at === -1 ? "" : arn.slice(at + marker.length);
  return id && !id.includes("/") ? id : undefined;
}

function parseLogGroupNames(stdout: string): string[] | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find and tail one AgentCore log source. Discovery is dynamic rather than spelling `-DEFAULT`:
 * endpoint naming belongs to AWS, and an edited stack may use a different endpoint. Runtime tailing
 * filters the log STREAM prefix so OTEL/spans in the same group never pollute the application log.
 */
export async function tailAgentcoreLogs(
  plan: AgentcoreLogsPlan,
  aws: CliRunner,
  announce: (message: string) => void = () => {},
): Promise<AgentcoreLogsOutcome> {
  const stack = `fastagent-${plan.name}`;
  const outputsResult = await aws(
    ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
    { capture: true },
  );
  if (outputsResult.code === 127) {
    return { ok: false, gate: "aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/" };
  }
  if (outputsResult.code !== 0) {
    return {
      ok: false,
      gate: `could not read AgentCore stack ${stack} — deploy it first, or fix the AWS account/region shown above`,
    };
  }
  const outputs = parseStackOutputs(outputsResult.stdout);

  let prefix: string;
  let exact: string | undefined;
  if (plan.source === "runtime") {
    const runtimeArn = outputs.RuntimeArn;
    const runtimeId = runtimeArn && runtimeIdFromArn(runtimeArn);
    if (!runtimeId) {
      return {
        ok: false,
        gate: `stack ${stack} has no valid RuntimeArn output — regenerate/deploy the AgentCore stack`,
      };
    }
    prefix = `/aws/bedrock-agentcore/runtimes/${runtimeId}-`;
  } else {
    if (!outputs.ForwarderUrl) {
      return {
        ok: false,
        gate: `stack ${stack} has no forwarder — this invoke-only deployment has Runtime logs only`,
      };
    }
    exact = `/aws/lambda/fastagent-${plan.name}-forwarder`;
    prefix = exact;
  }

  const groupsResult = await aws(
    [
      "logs",
      "describe-log-groups",
      "--log-group-name-prefix",
      prefix,
      "--query",
      "logGroups[].logGroupName",
      "--output",
      "json",
    ],
    { capture: true },
  );
  if (groupsResult.code !== 0) {
    return { ok: false, gate: "could not discover the CloudWatch log group — see the AWS error above" };
  }
  const groups = parseLogGroupNames(groupsResult.stdout);
  if (!groups) {
    return { ok: false, gate: "AWS returned an invalid CloudWatch log-group response" };
  }
  const matches = groups.filter((group) => (exact ? group === exact : group.startsWith(prefix))).sort();
  if (matches.length === 0) {
    const trigger = plan.source === "runtime" ? "invoke the Runtime once" : "deliver one webhook or schedule fire";
    return {
      ok: false,
      gate: `no ${plan.source} log group exists yet — ${trigger}, then retry (AWS creates it on first use)`,
    };
  }
  // A generated stack has one Runtime endpoint. If an operator's edited stack has several, choosing
  // one silently would show a valid but potentially WRONG agent log — list them and make the choice explicit.
  if (matches.length > 1) {
    return {
      ok: false,
      gate: `several Runtime log groups match this stack: ${matches.join(", ")} — tail the intended group with aws logs tail`,
    };
  }

  const logGroup = matches[0] as string;
  announce(`${plan.source} → ${logGroup}`);
  const tailArgs = ["logs", "tail", logGroup, "--format", "short"];
  if (plan.since) tailArgs.push("--since", plan.since);
  if (plan.source === "runtime") tailArgs.push("--log-stream-name-prefix", "[runtime-logs]");
  if (plan.follow) tailArgs.push("--follow");
  const tailed = await aws(tailArgs);
  if (tailed.code !== 0) {
    return { ok: false, gate: `aws logs tail failed for ${logGroup} — see the AWS error above` };
  }
  return { ok: true, logGroup };
}
