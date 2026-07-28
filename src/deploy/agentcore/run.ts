/**
 * `fastagent deploy agentcore --run` — drive the AWS CLI + Docker to completion. The middle of the
 * deploy the plain runbook hands to the operator; `--run` executes it so a coding agent runs ONE
 * command. Idempotent (ECR check-then-act; `cloudformation deploy` converges the stack) and
 * resumable: it STOPS at a human gate with one actionable line and a non-zero exit.
 *
 * TWO runners, one seam ({@link CliRunner}): `aws` (identity, ECR, CloudFormation) and `docker`
 * (buildx). AgentCore is the ONE host whose image builds on the operator's machine — the platform
 * requires linux/arm64 in the account's ECR and has no remote builder — so a missing Docker/buildx
 * is a first-class gate, not an incidental failure.
 *
 * Secrets ride CloudFormation NoEcho parameters. `--parameter-overrides` on argv would put the
 * values in the process listing (the same reason Fly imports secrets over stdin), so they go through
 * a caller-provided temp parameters file (`file://…`, mode 0600, deleted by the caller) — the write
 * is injected to keep this module pure and the security-sensitive wiring testable.
 */
import type { RegistrationOutcome } from "../../channels/registration.ts";
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { registrationGate } from "../registration-gate.ts";
import type { CliRunner } from "../runner.ts";
import { cfnParamName } from "./plan.ts";

export interface AgentcoreRunPlan {
  /** The base name — stack `fastagent-<name>`, ECR repo `fastagent/<name>`. */
  name: string;
  /** Template path relative to the run cwd (kit layout: `agent/agentcore.template.yaml`). */
  templatePath: string;
  /** Dockerfile path for `-f` (kit layout only; the default context Dockerfile otherwise). */
  dockerfilePath?: string;
  /** Image tag for this deploy — the CALLER mints it unique (a timestamp): CloudFormation only rolls
   *  the runtime when the ImageUri value changes, so a reused tag would deploy nothing. */
  tag: string;
  /** AWS region from the caller's environment (AWS_REGION/AWS_DEFAULT_REGION), else resolved via
   *  `aws configure get region` — an unset region is a gate (the ECR registry hostname needs it). */
  region?: string;
  /** Secret env-var name → value (model key or FASTAGENT_AUTH_SEED + channel secrets). Mapped to the
   *  template's parameter names via {@link cfnParamName}; delivered via the params file, never argv. */
  secrets: Record<string, string>;
  /** Required secret names with NO local value — gated before any side effect. */
  missingSecrets: string[];
  channels: ChannelKind[];
}

export type AgentcoreRunOutcome = { ok: true; runtimeArn: string; url?: string } | { ok: false; gate: string };

/** Stack outputs (`describe-stacks --query "Stacks[0].Outputs"`) → { OutputKey: OutputValue }. */
export function parseStackOutputs(stdout: string): Record<string, string> {
  try {
    const arr = JSON.parse(stdout) as { OutputKey?: unknown; OutputValue?: unknown }[];
    if (!Array.isArray(arr)) return {};
    const out: Record<string, string> = {};
    for (const o of arr) {
      if (typeof o?.OutputKey === "string" && typeof o?.OutputValue === "string") out[o.OutputKey] = o.OutputValue;
    }
    return out;
  } catch {
    return {};
  }
}

/** The `--parameter-overrides file://` payload: a JSON array of "Key=Value" strings. */
export function paramsFileContent(imageUri: string, secrets: Record<string, string>): string {
  const params = [`ImageUri=${imageUri}`, ...Object.entries(secrets).map(([k, v]) => `${cfnParamName(k)}=${v}`)];
  return `${JSON.stringify(params)}\n`;
}

/**
 * Run the deploy through `aws` + `docker`. `log` reports progress; the injected registrars perform
 * post-deploy webhook steps from the builder machine against the forwarder's Function URL. Every
 * gate is fail-visible; `writeParamsFile` is the caller's 0600-temp-file seam (see the header).
 */
export async function deployAgentcoreRun(
  plan: AgentcoreRunPlan,
  aws: CliRunner,
  docker: CliRunner,
  log: (msg: string) => void,
  writeParamsFile: (content: string) => Promise<string>,
  registerTelegram: (baseUrl: string) => Promise<RegistrationOutcome>,
  registerFeishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>,
  registerSlack?: (baseUrl: string) => Promise<RegistrationOutcome>,
): Promise<AgentcoreRunOutcome> {
  const gate = (g: string): AgentcoreRunOutcome => ({ ok: false, gate: g });
  const stack = `fastagent-${plan.name}`;
  const repo = `fastagent/${plan.name}`;

  // 1. Identity + region — the two facts everything downstream (registry hostname, stack region)
  //    hangs on. `sts get-caller-identity` succeeds with any working credential source.
  const identity = await aws(["sts", "get-caller-identity", "--output", "json"], { capture: true });
  if (identity.code === 127) {
    return gate("aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/, then re-run");
  }
  if (identity.code !== 0) {
    return gate("no working AWS credentials — run `aws configure` (or set AWS_ACCESS_KEY_ID/…), then re-run");
  }
  let account: string;
  try {
    const parsed = JSON.parse(identity.stdout) as { Account?: unknown };
    if (typeof parsed.Account !== "string") throw new Error("no Account");
    account = parsed.Account;
  } catch {
    return gate("could not read the account id from `aws sts get-caller-identity` — see the output above");
  }
  let region = plan.region;
  if (!region) {
    const fromConfig = await aws(["configure", "get", "region"], { capture: true });
    region = fromConfig.stdout.trim() || undefined;
  }
  if (!region) {
    return gate("no AWS region configured — set AWS_REGION (or `aws configure set region <region>`), then re-run");
  }

  // 2. Docker + buildx — this host builds LOCALLY (linux/arm64 into the account's ECR; AgentCore has
  //    no remote builder), so their absence is a first-class gate with the install pointer.
  if ((await docker(["version"], { capture: true })).code === 127) {
    return gate("docker not found — install Docker (https://docs.docker.com/get-docker/), then re-run");
  }
  if ((await docker(["buildx", "version"], { capture: true })).code !== 0) {
    return gate(
      "docker buildx not available — the image must be linux/arm64 (cross-built); install buildx, then re-run",
    );
  }

  // 3. Gate missing required secret VALUES before any side effect (no half-created infra).
  if (plan.missingSecrets.length > 0) {
    return gate(
      `no local value for: ${plan.missingSecrets.join(", ")} — set them in .env (or the environment) and re-run`,
    );
  }

  // 4. ECR repository — check-then-act. A FAILED describe that isn't "not found" would misreport the
  //    create, but ECR's not-found also exits non-zero — so try describe, and on failure attempt the
  //    create; a create failing for a REAL reason (permissions) still gates with its own message.
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const image = `${registry}/${repo}:${plan.tag}`;
  const described = await aws(["ecr", "describe-repositories", "--repository-names", repo], { capture: true });
  if (described.code === 0) {
    log(`ECR repository ${repo} exists — skipping create`);
  } else {
    log(`creating ECR repository ${repo}…`);
    if ((await aws(["ecr", "create-repository", "--repository-name", repo])).code !== 0) {
      return gate("`aws ecr create-repository` failed — see the output above; fix and re-run");
    }
  }

  // 5. Registry login — the password flows stdout→stdin between the two runners, never argv.
  const password = await aws(["ecr", "get-login-password"], { capture: true });
  if (password.code !== 0) return gate("`aws ecr get-login-password` failed — see the output above");
  if (
    (await docker(["login", "--username", "AWS", "--password-stdin", registry], { input: password.stdout })).code !== 0
  ) {
    return gate("`docker login` to ECR failed — see the output above");
  }

  // 6. Build (linux/arm64) + push in one step.
  log(`building + pushing ${image} (linux/arm64)…`);
  const buildArgs = ["buildx", "build", "--platform", "linux/arm64", "-t", image, "--push"];
  if (plan.dockerfilePath) buildArgs.push("-f", plan.dockerfilePath);
  buildArgs.push(".");
  if ((await docker(buildArgs)).code !== 0) {
    return gate("`docker buildx build` failed — see the output above; fix and re-run");
  }

  // 7. Deploy the stack. Secret values ride the temp params file (file://), never argv.
  //    --no-fail-on-empty-changeset: a re-run whose only change already applied must not gate.
  log(`deploying stack ${stack}…`);
  const paramsPath = await writeParamsFile(paramsFileContent(image, plan.secrets));
  const deployed = await aws([
    "cloudformation",
    "deploy",
    "--stack-name",
    stack,
    "--template-file",
    plan.templatePath,
    "--capabilities",
    "CAPABILITY_IAM",
    "--no-fail-on-empty-changeset",
    "--parameter-overrides",
    `file://${paramsPath}`,
  ]);
  if (deployed.code !== 0) {
    return gate(
      "`aws cloudformation deploy` failed — inspect the stack events " +
        `(aws cloudformation describe-stack-events --stack-name ${stack}), fix, and re-run`,
    );
  }

  // 8. Outputs — the runtime ARN (the data plane) and the forwarder URL (the webhook surface).
  const outputsQuery = await aws(
    ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
    { capture: true },
  );
  if (outputsQuery.code !== 0) return gate("`aws cloudformation describe-stacks` failed — see the output above");
  const outputs = parseStackOutputs(outputsQuery.stdout);
  const runtimeArn = outputs.RuntimeArn;
  if (!runtimeArn) return gate("stack has no RuntimeArn output — was the template edited? Regenerate with --force");
  const url = outputs.ForwarderUrl?.replace(/\/$/, ""); // registrars append /<path>; no double slash

  // 9. Post-deploy webhook registration — same registrar seam as every host, pointed at the
  //    forwarder's Function URL. Gate policy is the shared registration-gate kernel.
  if (plan.channels.length > 0 && !url) {
    return gate(
      "channels are declared but the stack has no ForwarderUrl output — regenerate the template with --force",
    );
  }
  const reg = registrationGate(log, "re-run to retry registration (steps already done are skipped)");
  if (url) {
    if (plan.channels.includes("telegram")) {
      log("registering telegram webhook…");
      reg.track("telegram", await registerTelegram(url));
    }
    if (plan.channels.includes("github")) {
      log(`github: set the webhook in the repo (Settings → Webhooks) → ${url}/webhook`);
      reg.track("github", "manual"); // always a human step — re-surfaced after the registrar output
    }
    if (plan.channels.includes("slack")) {
      if (registerSlack) {
        log("registering slack event URL…");
        reg.track("slack", await registerSlack(url));
      } else {
        log(`slack: set Event Subscriptions → Request URL → ${url}/slack`);
        reg.track("slack", "manual");
      }
    }
    for (const kind of ["feishu", "lark"] as const) {
      if (!plan.channels.includes(kind)) continue;
      if (registerFeishu) {
        log(`registering ${kind} event URL…`);
        reg.track(kind, await registerFeishu(url, kind));
      } else {
        log(`${kind}: set the event Request URL (developer console → Events & Callbacks) → ${url}/${kind}`);
        reg.track(kind, "manual");
      }
    }
  }
  const registrationGateMsg = reg.gate();
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true, runtimeArn, url };
}
