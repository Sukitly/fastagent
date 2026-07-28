import { describe, expect, it, vi } from "vitest";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import {
  type AgentcoreRunPlan,
  deployAgentcoreRun,
  paramsFileContent,
  parseStackOutputs,
} from "../src/deploy/agentcore/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

/** A fake CLI: records every call, returns per-command scripted results (default code 0, empty out). */
function fakeCli(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const cli: CliRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = script(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "" };
  };
  return { cli, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

const IDENTITY = JSON.stringify({ Account: "123456789012" });
const OUTPUTS = JSON.stringify([
  { OutputKey: "RuntimeArn", OutputValue: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc" },
  { OutputKey: "ForwarderUrl", OutputValue: "https://xyz.lambda-url.us-west-2.on.aws/" },
]);

/** Default happy-path aws script: identity + login password + stack outputs succeed. */
const happyAws = (args: string[]): { code?: number; stdout?: string } => {
  if (args[0] === "sts") return { stdout: IDENTITY };
  if (args[0] === "ecr" && args[1] === "get-login-password") return { stdout: "hunter2" };
  if (args[0] === "cloudformation" && args[1] === "describe-stacks") return { stdout: OUTPUTS };
  return {};
};

const plan = (over: Partial<AgentcoreRunPlan> = {}): AgentcoreRunPlan => ({
  name: "my-agent",
  templatePath: "agentcore.template.yaml",
  tag: "20260728",
  region: "us-west-2",
  secrets: {},
  missingSecrets: [],
  channels: [],
  ...over,
});

const writeParams = vi.fn(async (_content: string) => "/tmp/params.json");

const run = (
  p: AgentcoreRunPlan,
  aws: CliRunner,
  docker: CliRunner,
  tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered"),
) => deployAgentcoreRun(p, aws, docker, () => {}, writeParams, tg);

describe("deploy/agentcore/run: the coding-agent deploy journey", () => {
  it("happy path: identity → docker checks → ecr → login → buildx push → cfn deploy → outputs → webhook", async () => {
    const { cli: aws, cmds: awsCmds } = fakeCli(happyAws);
    const { cli: docker, cmds: dockerCmds, calls: dockerCalls } = fakeCli();
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const out = await run(
      plan({ channels: ["telegram"], secrets: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_SECRET_TOKEN: "s" } }),
      aws,
      docker,
      tg,
    );

    expect(out).toEqual({
      ok: true,
      runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc",
      url: "https://xyz.lambda-url.us-west-2.on.aws", // trailing slash stripped for the registrars
    });
    expect(awsCmds()).toEqual([
      "sts get-caller-identity --output json",
      "ecr describe-repositories --repository-names fastagent/my-agent",
      "ecr get-login-password",
      "cloudformation describe-stacks --stack-name fastagent-my-agent --query Stacks[0].StackStatus --output text",
      "cloudformation deploy --stack-name fastagent-my-agent --template-file agentcore.template.yaml " +
        "--capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides file:///tmp/params.json",
      "cloudformation describe-stacks --stack-name fastagent-my-agent --query Stacks[0].Outputs --output json",
    ]);
    expect(dockerCmds()).toEqual([
      "version",
      "buildx version",
      "login --username AWS --password-stdin 123456789012.dkr.ecr.us-west-2.amazonaws.com",
      "buildx build --platform linux/arm64 -t 123456789012.dkr.ecr.us-west-2.amazonaws.com/fastagent/my-agent:20260728 --push .",
    ]);
    // The ECR password flows stdout→stdin between the runners, never argv.
    expect(dockerCalls.find((c) => c.args[0] === "login")?.input).toBe("hunter2");
    expect(tg).toHaveBeenCalledWith("https://xyz.lambda-url.us-west-2.on.aws");
    // Secrets ride the params FILE (0600 temp), never argv.
    expect(writeParams).toHaveBeenCalledWith(
      `${JSON.stringify([
        "ImageUri=123456789012.dkr.ecr.us-west-2.amazonaws.com/fastagent/my-agent:20260728",
        "TelegramBotToken=t",
        "TelegramSecretToken=s",
      ])}\n`,
    );
  });

  it("gates on: no aws CLI / no credentials / no region / no docker / no buildx", async () => {
    const { cli: docker } = fakeCli();
    const noCli = await run(plan(), fakeCli(() => ({ code: 127 })).cli, docker);
    expect(noCli).toMatchObject({ ok: false, gate: expect.stringContaining("aws CLI not found") });

    const noCreds = await run(plan(), fakeCli(() => ({ code: 1 })).cli, docker);
    expect(noCreds).toMatchObject({ ok: false, gate: expect.stringContaining("no working AWS credentials") });

    const noRegion = await run(
      plan({ region: undefined }),
      fakeCli((a) => (a[0] === "sts" ? { stdout: IDENTITY } : a[0] === "configure" ? { stdout: "" } : {})).cli,
      docker,
    );
    expect(noRegion).toMatchObject({ ok: false, gate: expect.stringContaining("no AWS region") });

    const noDocker = await run(plan(), fakeCli(happyAws).cli, fakeCli(() => ({ code: 127 })).cli);
    expect(noDocker).toMatchObject({ ok: false, gate: expect.stringContaining("docker not found") });

    const noBuildx = await run(
      plan(),
      fakeCli(happyAws).cli,
      fakeCli((a) => (a[0] === "buildx" ? { code: 1 } : {})).cli,
    );
    expect(noBuildx).toMatchObject({ ok: false, gate: expect.stringContaining("buildx") });
  });

  it("resolves the region via `aws configure get region` when the env gave none", async () => {
    const { cli: aws, cmds } = fakeCli((a) => (a[0] === "configure" ? { stdout: "eu-west-1\n" } : happyAws(a)));
    const out = await run(plan({ region: undefined }), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: true });
    expect(cmds()).toContain("configure get region");
  });

  it("gates missing secret values BEFORE any side effect", async () => {
    const { cli: aws, cmds } = fakeCli(happyAws);
    const out = await run(plan({ missingSecrets: ["TELEGRAM_BOT_TOKEN"] }), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    expect(cmds().some((c) => c.startsWith("ecr create") || c.startsWith("cloudformation"))).toBe(false);
  });

  it("skips ECR create when the repository exists; creates it when describe fails", async () => {
    const exists = fakeCli(happyAws);
    await run(plan(), exists.cli, fakeCli().cli);
    expect(exists.cmds().some((c) => c.startsWith("ecr create-repository"))).toBe(false);

    const absent = fakeCli((a) => (a[0] === "ecr" && a[1] === "describe-repositories" ? { code: 254 } : happyAws(a)));
    await run(plan(), absent.cli, fakeCli().cli);
    expect(absent.cmds()).toContain("ecr create-repository --repository-name fastagent/my-agent");
  });

  it("a ROLLBACK_COMPLETE stack (failed first create) is deleted + awaited before re-creating", async () => {
    const { cli: aws, cmds } = fakeCli((a) => {
      if (a[0] === "cloudformation" && a[1] === "describe-stacks" && a.includes("Stacks[0].StackStatus")) {
        return { stdout: "ROLLBACK_COMPLETE\n" };
      }
      return happyAws(a);
    });
    const out = await run(plan(), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: true });
    expect(cmds()).toContain("cloudformation delete-stack --stack-name fastagent-my-agent");
    expect(cmds()).toContain("cloudformation wait stack-delete-complete --stack-name fastagent-my-agent");
  });

  it("gates an auth seed beyond the chunk ceiling and any other >2048-char secret", async () => {
    const tooBigSeed = await run(
      plan({ secrets: { FASTAGENT_AUTH_SEED: "x".repeat(8001) } }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
    );
    expect(tooBigSeed).toMatchObject({ ok: false, gate: expect.stringContaining("auth.json is too large") });

    const tooBigSecret = await run(
      plan({ secrets: { SOME_BLOB: "x".repeat(2049) } }),
      fakeCli(happyAws).cli,
      fakeCli().cli,
    );
    expect(tooBigSecret).toMatchObject({ ok: false, gate: expect.stringContaining("SOME_BLOB") });
  });

  it("a failed cfn deploy gates with the stack-events pointer", async () => {
    const { cli: aws } = fakeCli((a) => (a[0] === "cloudformation" && a[1] === "deploy" ? { code: 1 } : happyAws(a)));
    const out = await run(plan(), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("describe-stack-events") });
  });

  it("declared channels without a ForwarderUrl output gate (an edited template must not half-deploy)", async () => {
    const { cli: aws } = fakeCli((a) =>
      a[0] === "cloudformation" && a[1] === "describe-stacks"
        ? { stdout: JSON.stringify([{ OutputKey: "RuntimeArn", OutputValue: "arn:x" }]) }
        : happyAws(a),
    );
    const out = await run(plan({ channels: ["telegram"] }), aws, fakeCli().cli);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("ForwarderUrl") });
  });

  it("a failed telegram registration gates AFTER the deploy (the app itself deployed)", async () => {
    const { cli: aws } = fakeCli(happyAws);
    const tg = vi.fn(async (): Promise<RegistrationOutcome> => "failed");
    const out = await run(plan({ channels: ["telegram"] }), aws, fakeCli().cli, tg);
    expect(out).toMatchObject({ ok: false, gate: expect.stringContaining("telegram") });
  });
});

describe("deploy/agentcore/run: helpers", () => {
  it("parseStackOutputs tolerates garbage and partial shapes", () => {
    expect(parseStackOutputs("not json")).toEqual({});
    expect(parseStackOutputs(JSON.stringify([{ OutputKey: "A", OutputValue: "1" }, { OutputKey: 2 }]))).toEqual({
      A: "1",
    });
  });

  it("paramsFileContent maps env names to template parameter names", () => {
    expect(paramsFileContent("img:1", { OPENAI_API_KEY: "sk", FASTAGENT_AUTH_SEED: "b64" })).toBe(
      `${JSON.stringify(["ImageUri=img:1", "OpenaiApiKey=sk", "FastagentAuthSeed=b64"])}\n`,
    );
  });

  it("paramsFileContent chunks a long auth seed across FastagentAuthSeed(2…), reassemblable in order", () => {
    const seed = "a".repeat(2000) + "b".repeat(2000) + "c".repeat(756); // a real OAuth-size seed (2756+)
    const params = JSON.parse(paramsFileContent("img:1", { FASTAGENT_AUTH_SEED: seed })) as string[];
    expect(params).toEqual([
      "ImageUri=img:1",
      `FastagentAuthSeed=${"a".repeat(2000)}`,
      `FastagentAuthSeed2=${"b".repeat(2000)}`,
      `FastagentAuthSeed3=${"c".repeat(756)}`,
    ]);
    for (const p of params) expect(p.length).toBeLessThanOrEqual(2048 + "FastagentAuthSeed0=".length);
  });
});
