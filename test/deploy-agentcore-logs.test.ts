import { describe, expect, it } from "vitest";
import { tailAgentcoreLogs } from "../src/deploy/agentcore/logs.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

const RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc";
const outputs = (forwarder = false) =>
  JSON.stringify([
    { OutputKey: "RuntimeArn", OutputValue: RUNTIME_ARN },
    ...(forwarder ? [{ OutputKey: "ForwarderUrl", OutputValue: "https://example.lambda-url.on.aws/" }] : []),
  ]);

function fakeAws(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: string[][] = [];
  const cli: CliRunner = async (args) => {
    calls.push(args);
    const result = script(args);
    return { code: result.code ?? 0, stdout: result.stdout ?? "" };
  };
  return { cli, calls, commands: () => calls.map((args) => args.join(" ")) };
}

describe("agentcore logs", () => {
  it("discovers the Runtime group and tails only application stdout/stderr", async () => {
    const group = "/aws/bedrock-agentcore/runtimes/my_agent-abc-DEFAULT";
    const aws = fakeAws((args) => {
      if (args[0] === "cloudformation") return { stdout: outputs() };
      if (args[1] === "describe-log-groups") return { stdout: JSON.stringify([group]) };
      return {};
    });
    const announced: string[] = [];

    const result = await tailAgentcoreLogs(
      { name: "my-agent", source: "runtime", since: "2h", follow: true },
      aws.cli,
      (message) => announced.push(message),
    );

    expect(result).toEqual({ ok: true, logGroup: group });
    expect(announced).toEqual([`runtime → ${group}`]);
    expect(aws.commands()).toEqual([
      "cloudformation describe-stacks --stack-name fastagent-my-agent --query Stacks[0].Outputs --output json",
      "logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/my_agent-abc- " +
        "--query logGroups[].logGroupName --output json",
      `logs tail ${group} --format short --since 2h --log-stream-name-prefix [runtime-logs] --follow`,
    ]);
  });

  it("tails the forwarder Lambda as a separate source", async () => {
    const group = "/aws/lambda/fastagent-my-agent-forwarder";
    const aws = fakeAws((args) => {
      if (args[0] === "cloudformation") return { stdout: outputs(true) };
      if (args[1] === "describe-log-groups") return { stdout: JSON.stringify([group]) };
      return {};
    });

    const result = await tailAgentcoreLogs({ name: "my-agent", source: "forwarder", follow: false }, aws.cli);

    expect(result).toEqual({ ok: true, logGroup: group });
    expect(aws.commands().at(-1)).toBe(`logs tail ${group} --format short`);
  });

  it("explains an absent first-use log group instead of sending aws logs tail at nothing", async () => {
    const aws = fakeAws((args) => {
      if (args[0] === "cloudformation") return { stdout: outputs() };
      if (args[1] === "describe-log-groups") return { stdout: "[]" };
      return {};
    });

    const result = await tailAgentcoreLogs({ name: "my-agent", source: "runtime", follow: true }, aws.cli);

    expect(result).toMatchObject({ ok: false, gate: expect.stringMatching(/invoke the Runtime once/) });
    expect(aws.commands().some((command) => command.startsWith("logs tail"))).toBe(false);
  });

  it("refuses forwarder logs for an invoke-only deployment", async () => {
    const aws = fakeAws((args) => {
      if (args[0] === "cloudformation") return { stdout: outputs(false) };
      if (args[1] === "describe-log-groups") return { stdout: "[]" };
      return {};
    });

    const result = await tailAgentcoreLogs({ name: "my-agent", source: "forwarder", follow: false }, aws.cli);

    // Both facts agree (no ingress URL output AND no log group) — no tail attempt, no wrong trigger advice.
    expect(result).toMatchObject({ ok: false, gate: expect.stringMatching(/invoke-only deployment/) });
    expect(aws.commands().some((command) => command.startsWith("logs tail"))).toBe(false);
  });

  it("tails a forwarder that exists without an ingress URL output", async () => {
    // ForwarderUrl is the INGRESS URL, not the forwarder's existence: a topology keeping the Lambda
    // while dropping the public URL (schedules-only) still has forwarder logs, and must get them.
    const group = "/aws/lambda/fastagent-my-agent-forwarder";
    const aws = fakeAws((args) => {
      if (args[0] === "cloudformation") return { stdout: outputs(false) };
      if (args[1] === "describe-log-groups") return { stdout: JSON.stringify([group]) };
      return {};
    });

    const result = await tailAgentcoreLogs({ name: "my-agent", source: "forwarder", follow: true }, aws.cli);

    expect(result).toEqual({ ok: true, logGroup: group });
    expect(aws.commands().at(-1)).toBe(`logs tail ${group} --format short --follow`);
  });

  it("names the missing trigger when a real forwarder has not run yet", async () => {
    const aws = fakeAws((args) => {
      if (args[0] === "cloudformation") return { stdout: outputs(true) };
      if (args[1] === "describe-log-groups") return { stdout: "[]" };
      return {};
    });

    const result = await tailAgentcoreLogs({ name: "my-agent", source: "forwarder", follow: false }, aws.cli);

    expect(result).toMatchObject({ ok: false, gate: expect.stringMatching(/deliver one webhook or schedule fire/) });
  });

  it("never guesses when an edited stack has several matching Runtime endpoints", async () => {
    const groups = [
      "/aws/bedrock-agentcore/runtimes/my_agent-abc-blue",
      "/aws/bedrock-agentcore/runtimes/my_agent-abc-green",
    ];
    const aws = fakeAws((args) => {
      if (args[0] === "cloudformation") return { stdout: outputs() };
      if (args[1] === "describe-log-groups") return { stdout: JSON.stringify(groups) };
      return {};
    });

    const result = await tailAgentcoreLogs({ name: "my-agent", source: "runtime", follow: false }, aws.cli);

    expect(result).toMatchObject({ ok: false, gate: expect.stringContaining(groups[0] as string) });
    // The handoff must carry the POLICY too, not just discovery: a bare `aws logs tail` would mix in
    // otel-rt-logs/spans — the exact thing this command exists to exclude.
    expect(result).toMatchObject({ ok: false, gate: expect.stringContaining("--log-stream-name-prefix") });
    expect(aws.commands().some((command) => command.startsWith("logs tail"))).toBe(false);
  });
});
