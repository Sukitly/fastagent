/**
 * `fastagent deploy agentcore` — the AWS Bedrock AgentCore deploy PLAN, computed from the resolved
 * definition. Pure: facts in, artifact contents + an ordered runbook out; the CLI writes the files
 * and prints the runbook. AgentCore is the fourth target, and its shape differs from Fly/Railway in
 * kind, not degree:
 *
 *  1. **No public URL, no resident process.** The Runtime's only ingress is the SigV4
 *     `InvokeAgentRuntime` API, and compute is per-session microVMs that stop when idle. So the
 *     topology carries TWO extra pieces a Fly box never needs: a forwarder Lambda (public Function
 *     URL → envelope → InvokeAgentRuntime) fronting the webhooks, and EventBridge Scheduler rules
 *     delivering each cron slot (the container arms no resident timers — serve's externalClock mode).
 *  2. **One template is the whole topology.** CloudFormation (`AWS::BedrockAgentCore::Runtime` is a
 *     first-class resource type) declares Runtime + roles + forwarder + schedules in one stack —
 *     unlike Railway, identity DOES live in a committed file; the stack name pins it.
 *  3. **All ingress traffic shares ONE fixed runtime session** (`ingressSessionId`): fastagent's
 *     channel state is single-writer by design, and one session = at most one microVM at a time.
 *     AgentCore keeps a stopped session's id valid until the Runtime is deleted (a new compute is
 *     provisioned on the next invoke), so the fixed id needs no rotation. State lives on the
 *     platform's SessionStorage mount (`/mnt/state`) — persistent across compute stop/resume, no
 *     VPC/EFS required. Named trade-off: that state is tied to THIS Runtime resource — a stack
 *     replacement (renaming the runtime) starts blank. EFS (VPC mode) is the upgrade path when
 *     state must outlive the runtime; the runbook says so instead of silently shipping a VPC+NAT
 *     bill (~$35/mo) every deployment.
 *
 *  The image is the SAME portable container every host ships (containerArtifacts) — AgentCore's
 *  extras (PORT=8080, FASTAGENT_AGENTCORE=1, the state dir) ride the Runtime resource's environment,
 *  never a forked Dockerfile. The build must be linux/arm64 (the platform requirement) — the ONE
 *  host where the build runs on the operator's machine (docker buildx) instead of remotely.
 */
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { type Artifact, type ContainerInput, containerArtifacts } from "../container.ts";
import { deploymentSecrets, isEnvKey } from "../secrets.ts";

/** The one schedule fact the plan needs (from loadSchedules) — name + cron + tz. */
export interface ScheduleFact {
  name: string;
  cron: string;
  tz?: string;
}

export interface AgentcorePlanInput extends ContainerInput {
  /** Base name (dir basename) — shapes the runtime name, stack name, ECR repo, session id. */
  name: string;
  /** What satisfies model auth locally: an env-var name, an OAuth/stored label, or undefined. */
  modelAuth: string | undefined;
  /** Known first-party channels — each contributes its secret metadata + webhook step. */
  channels: ChannelKind[];
  /** ALL route-channel basenames (customs included) — any of them requires the forwarder. */
  routeChannels: string[];
  /** Extra secret env-var names (fastagent.config deploy.secrets). */
  extraSecrets?: string[];
  /** Static schedules — each becomes an EventBridge Scheduler rule targeting the forwarder. */
  schedules: ScheduleFact[];
  /** Wake tool enabled — DEGRADED here (fires only while a session happens to be awake); warned. */
  selfSchedule: boolean;
}

export interface AgentcorePlan {
  /** template + forwarder + Dockerfile/.dockerignore — written by the CLI (kept unless --force). */
  artifacts: Artifact[];
  /** The ordered, values-resolved deploy runbook — printed to stdout. */
  runbook: string[];
  /** Cron expressions EventBridge cannot express — surfaced as runbook warnings, not silent drops. */
  untranslatableSchedules: { name: string; reason: string }[];
}

/** SessionStorage mount = FASTAGENT_STATE_DIR (AgentCore requires exactly `/mnt/<one-level>`). */
export const MOUNT = "/mnt/state";
/** AgentCore env values max 2048 chars — a real OAuth auth.json's base64 exceeds it, so the seed is
 *  CHUNKED across FASTAGENT_AUTH_SEED + _2… (collectAuthSeed reassembles at boot). 2000 keeps margin. */
export const AUTH_SEED_CHUNK_SIZE = 2000;
export const AUTH_SEED_MAX_CHUNKS = 4;
/** The generated template's filename (namespaced under the kit in the agentDir layout). */
export const TEMPLATE_FILE = "agentcore.template.yaml";

/** Runtime name (`[a-zA-Z][a-zA-Z0-9_]{0,47}`) from a dir basename. */
export function toRuntimeName(basename: string): string {
  const slug = basename.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (/^[a-zA-Z]/.test(slug) ? slug : `agent_${slug || "fastagent"}`).slice(0, 48);
}

/** The ONE fixed ingress session id (webhooks + schedule fires) — ≥ 33 chars (the API minimum),
 *  deterministic (the Lambda holds it in env), padded so any name clears the floor. */
export function ingressSessionId(name: string): string {
  return `fastagent-ingress-${name}`.padEnd(33, "0").slice(0, 128);
}

/** CFN parameter logical id for a secret env-var name: TELEGRAM_BOT_TOKEN → TelegramBotToken
 *  (parameter names must be alphanumeric). Deterministic — run.ts builds the same mapping. */
export function cfnParamName(envName: string): string {
  return envName
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Translate a 5-field cron into EventBridge Scheduler's `cron(m h dom mon dow *)`, or say why it
 * can't be. The two dialects disagree exactly where silent translation would misfire:
 *  - EventBridge numbers day-of-week 1–7 (1 = Sunday); standard cron uses 0–6 (0/7 = Sunday) —
 *    every numeric dow token is remapped (names pass through).
 *  - EventBridge requires `?` in dom or dow: a `*` on either side becomes `?`; BOTH restricted is
 *    standard cron's OR semantics, which EventBridge cannot express — refused, never approximated.
 *  - A 6-field (seconds) expression and L/# day-of-week forms are refused for the same reason.
 */
export function toEventBridgeCron(cron: string): { expression: string } | { error: string } {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { error: `EventBridge supports 5-field cron only (got ${fields.length} fields)` };
  }
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (/[L#]/i.test(dow) || /[L#]/i.test(dom)) {
    return { error: "L/# day forms don't translate to EventBridge numbering — set this schedule up manually" };
  }
  if (dom !== "*" && dow !== "*") {
    return {
      error: "restricting BOTH day-of-month and day-of-week (cron OR semantics) is not expressible in EventBridge",
    };
  }
  // Remap numeric day-of-week tokens (0–7, 0/7 = Sunday) to EventBridge's 1–7 (1 = Sunday). Names
  // (SUN..SAT) and `*` pass through; digits inside ranges/lists/steps are each remapped.
  const ebDow = dow === "*" ? "?" : dow.replace(/\d+/g, (d) => String((Number(d) % 7) + 1));
  const ebDom = dow === "*" ? dom : "?";
  return { expression: `cron(${min} ${hour} ${ebDom} ${mon} ${ebDow} *)` };
}

/** CFN logical id fragment from a schedule name (alphanumeric only, capitalized). */
function logicalId(name: string): string {
  const slug = name.replace(/[^a-zA-Z0-9]+/g, "");
  return slug.charAt(0).toUpperCase() + slug.slice(1) || "Schedule";
}

/**
 * The forwarder Lambda source — the ONLY string both the template's inline ZipFile and the readable
 * `lambda/forwarder.js` artifact are generated from (one source, no drift). Zero-dependency: the
 * Lambda Node runtime bundles AWS SDK v3. CommonJS ON PURPOSE: CloudFormation inline code always
 * lands as `index.js`, where ESM `import` is a syntax error (found by the first real deploy). Two
 * event shapes: a Function URL webhook (reconstructed verbatim into a `webhook` envelope; the
 * channel's REAL response rides back inside the transport reply and is re-emitted byte-exact —
 * Feishu's URL-verification challenge depends on it), and an EventBridge Scheduler fire
 * (`{ scheduleFire }`, slot = the scheduled instant — the container's idempotency key). MUST stay
 * under CloudFormation's 4096-byte inline-code cap.
 */
export function forwarderSource(): string {
  return `// Generated by \`fastagent deploy agentcore\` — the deployment's only ingress.
// Webhooks (Function URL) and EventBridge Scheduler fires are forwarded as envelopes to the
// AgentCore Runtime over SigV4 InvokeAgentRuntime, all on ONE fixed ingress session (fastagent
// channel state is single-writer; one session = at most one microVM).
// CommonJS on purpose: CloudFormation inline code lands as index.js, where ESM import is invalid.
"use strict";
const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require("@aws-sdk/client-bedrock-agentcore");
const client = new BedrockAgentCoreClient({});

async function invoke(envelope) {
  const res = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: process.env.RUNTIME_ARN,
    runtimeSessionId: process.env.INGRESS_SESSION_ID,
    contentType: "application/json",
    accept: "application/json",
    payload: new TextEncoder().encode(JSON.stringify(envelope)),
  }));
  const body = Buffer.from(await res.response.transformToByteArray());
  return { status: res.statusCode ?? 200, body };
}

exports.handler = async (event) => {
  // EventBridge Scheduler fire — throw on failure so the miss lands in CloudWatch, never silently.
  if (event && event.scheduleFire) {
    const { name, slot } = event.scheduleFire;
    const r = await invoke({ kind: "schedule-fire", name, slot });
    const out = r.body.toString();
    console.log(\`schedule-fire \${name} (\${slot}): \${r.status} \${out}\`);
    if (r.status >= 400) throw new Error(\`schedule-fire \${name} failed: \${r.status} \${out}\`);
    return { status: r.status };
  }
  // Function URL webhook — forward the original request verbatim (signature material included).
  const http = event && event.requestContext && event.requestContext.http;
  if (!http) throw new Error("unrecognized event shape (not a Function URL request or a scheduleFire)");
  const r = await invoke({
    kind: "webhook",
    method: http.method,
    path: event.rawPath || "/",
    headers: event.headers || {},
    bodyB64: event.body === undefined ? undefined
      : event.isBase64Encoded ? event.body : Buffer.from(event.body).toString("base64"),
  });
  if (r.status !== 200) {
    console.log(\`transport error \${r.status}: \${r.body}\`);
    return { statusCode: 502, body: "upstream error\\n" };
  }
  const reply = JSON.parse(r.body.toString()); // { status, headers, bodyB64 } from the adapter
  for (const k of Object.keys(reply.headers)) {
    if (/^(content-length|transfer-encoding|connection)$/i.test(k)) delete reply.headers[k];
  }
  return { statusCode: reply.status, headers: reply.headers, body: reply.bodyB64, isBase64Encoded: true };
};
`;
}

/** Indent every line of `text` by `spaces` (YAML block embedding). */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : pad + line))
    .join("\n");
}

/** The CloudFormation template — the whole topology in one stack. */
function template(input: AgentcorePlanInput, translated: { fact: ScheduleFact; expression: string }[]): string {
  const runtimeName = toRuntimeName(input.name);
  const needsForwarder = input.routeChannels.length > 0 || translated.length > 0;
  const secrets = deploymentSecrets(input.modelAuth, input.channels, input.extraSecrets);

  // Secret env vars ride CFN NoEcho parameters. FASTAGENT_AUTH_SEED is always declared (Default "")
  // so a `--run` OAuth carry has a slot; required secrets have NO default — `cloudformation deploy`
  // fails loudly without a value instead of booting a half-configured box.
  const params: string[] = [
    `  ImageUri:`,
    `    Type: String`,
    `    Description: ECR image URI (linux/arm64) — <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`,
  ];
  const envLines: string[] = [
    `        PORT: "8080"`, // the Runtime service contract's fixed port (config.http.port does not apply here)
    `        FASTAGENT_AGENTCORE: "1"`, // serve mounts /invocations + /ping, arms no resident cron
    `        FASTAGENT_STATE_DIR: ${MOUNT}`,
  ];
  // The auth seed is chunked (env values max 2048 chars — see AUTH_SEED_CHUNK_SIZE): N parameters,
  // each riding its own env var; `start` reassembles them (collectAuthSeed). Empty defaults = unused.
  for (let i = 1; i <= AUTH_SEED_MAX_CHUNKS; i++) {
    const param = i === 1 ? "FastagentAuthSeed" : `FastagentAuthSeed${i}`;
    const envName = i === 1 ? "FASTAGENT_AUTH_SEED" : `FASTAGENT_AUTH_SEED_${i}`;
    params.push(
      `  ${param}:`,
      `    Type: String`,
      `    Default: ""`,
      `    NoEcho: true`,
      `    Description: base64 auth.json carried by --run, chunk ${i}/${AUTH_SEED_MAX_CHUNKS} (env values cap at 2048 chars); empty = unused`,
    );
    envLines.push(`        ${envName}: !Ref ${param}`);
  }
  for (const s of secrets) {
    const p = cfnParamName(s.name);
    params.push(`  ${p}:`, `    Type: String`);
    if (!s.required) params.push(`    Default: ""`);
    params.push(`    NoEcho: true`, `    Description: ${s.hint}`);
    envLines.push(`        ${s.name}: !Ref ${p}`);
  }

  const lines: string[] = [
    `# Generated by \`fastagent deploy agentcore\`. Edit freely — it is not regenerated unless you pass --force.`,
    `AWSTemplateFormatVersion: "2010-09-09"`,
    `Description: fastagent agent "${input.name}" on AWS Bedrock AgentCore Runtime`,
    ``,
    `Parameters:`,
    ...params,
    ``,
    `Resources:`,
    `  ExecutionRole:`,
    `    Type: AWS::IAM::Role`,
    `    Properties:`,
    `      AssumeRolePolicyDocument:`,
    `        Version: "2012-10-17"`,
    `        Statement:`,
    `          - Effect: Allow`,
    `            Principal: { Service: bedrock-agentcore.amazonaws.com }`,
    `            Action: sts:AssumeRole`,
    `            Condition:`,
    `              StringEquals: { aws:SourceAccount: !Ref AWS::AccountId }`,
    `      Policies:`,
    `        - PolicyName: runtime`,
    `          PolicyDocument:`,
    `            Version: "2012-10-17"`,
    `            Statement:`,
    `              - Effect: Allow # pull the agent image`,
    `                Action: [ecr:GetAuthorizationToken]`,
    `                Resource: "*"`,
    `              - Effect: Allow`,
    `                Action: [ecr:BatchGetImage, ecr:GetDownloadUrlForLayer]`,
    `                Resource: !Sub arn:aws:ecr:\${AWS::Region}:\${AWS::AccountId}:repository/*`,
    `              - Effect: Allow # runtime logs + traces + metrics`,
    `                Action: [logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents, logs:DescribeLogGroups, logs:DescribeLogStreams]`,
    `                Resource: "*"`,
    `              - Effect: Allow`,
    `                Action: [xray:PutTraceSegments, xray:PutTelemetryRecords, cloudwatch:PutMetricData]`,
    `                Resource: "*"`,
    `              - Effect: Allow # AgentCore workload identity (the platform mints one per runtime)`,
    `                Action: [bedrock-agentcore:GetWorkloadAccessToken]`,
    `                Resource: "*"`,
    ``,
    `  Runtime:`,
    `    Type: AWS::BedrockAgentCore::Runtime`,
    `    Properties:`,
    `      AgentRuntimeName: ${runtimeName}`,
    `      Description: fastagent agent "${input.name}" (deploy agentcore)`,
    `      AgentRuntimeArtifact:`,
    `        ContainerConfiguration: { ContainerUri: !Ref ImageUri }`,
    `      RoleArn: !GetAtt ExecutionRole.Arn`,
    `      ProtocolConfiguration: HTTP`,
    `      NetworkConfiguration: { NetworkMode: PUBLIC }`,
    `      # SessionStorage: platform-persistent state across compute stop/resume — no VPC/EFS needed.`,
    `      # It is tied to THIS runtime resource: renaming the runtime (a CFN replacement) starts blank.`,
    `      # If state must outlive the runtime, switch to an EfsAccessPoint mount (requires VPC mode).`,
    `      FilesystemConfigurations:`,
    `        - SessionStorage: { MountPath: ${MOUNT} }`,
    `      # Idle 15 min (the ping's HealthyBusy keeps busy sessions alive), max compute lifetime 8 h`,
    `      # (the platform ceiling; the session id stays valid — the next invoke gets a fresh compute).`,
    `      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 900, MaxLifetime: 28800 }`,
    `      EnvironmentVariables:`,
    ...envLines,
  ];

  if (needsForwarder) {
    lines.push(
      ``,
      `  ForwarderRole:`,
      `    Type: AWS::IAM::Role`,
      `    Properties:`,
      `      AssumeRolePolicyDocument:`,
      `        Version: "2012-10-17"`,
      `        Statement:`,
      `          - Effect: Allow`,
      `            Principal: { Service: lambda.amazonaws.com }`,
      `            Action: sts:AssumeRole`,
      `      ManagedPolicyArns: [arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]`,
      `      Policies:`,
      `        - PolicyName: invoke-runtime`,
      `          PolicyDocument:`,
      `            Version: "2012-10-17"`,
      `            Statement:`,
      `              - Effect: Allow`,
      `                Action: bedrock-agentcore:InvokeAgentRuntime`,
      `                Resource:`,
      `                  - !GetAtt Runtime.AgentRuntimeArn`,
      `                  - !Sub "\${Runtime.AgentRuntimeArn}/*"`,
      ``,
      `  Forwarder:`,
      `    Type: AWS::Lambda::Function`,
      `    Properties:`,
      `      FunctionName: fastagent-${input.name}-forwarder`,
      `      Runtime: nodejs22.x`,
      `      Handler: index.handler`,
      `      Timeout: 90 # ACKs are fast; the margin covers a cold microVM start`,
      `      MemorySize: 256`,
      `      Role: !GetAtt ForwarderRole.Arn`,
      `      Environment:`,
      `        Variables:`,
      `          RUNTIME_ARN: !GetAtt Runtime.AgentRuntimeArn`,
      `          INGRESS_SESSION_ID: ${ingressSessionId(input.name)}`,
      `      Code:`,
      `        ZipFile: | # same source as lambda/forwarder.js (generated together — cannot drift)`,
      indent(forwarderSource(), 10),
      ``,
      `  ForwarderUrl:`,
      `    Type: AWS::Lambda::Url`,
      `    Properties:`,
      `      TargetFunctionArn: !GetAtt Forwarder.Arn`,
      `      # NONE is deliberate: webhook callers (Telegram/Feishu) cannot SigV4-sign. Authenticity is`,
      `      # verified downstream by each channel (secret token / signature), exactly as on every host.`,
      `      AuthType: NONE`,
      ``,
      `  ForwarderUrlPermission:`,
      `    Type: AWS::Lambda::Permission`,
      `    Properties:`,
      `      FunctionName: !Ref Forwarder`,
      `      Action: lambda:InvokeFunctionUrl`,
      `      Principal: "*"`,
      `      FunctionUrlAuthType: NONE`,
      ``,
      `  # Function URLs created after Oct 2025 require lambda:InvokeFunction IN ADDITION to`,
      `  # lambda:InvokeFunctionUrl for public (NONE) access — with only the first, every request 403s`,
      `  # (found by the first real deploy). This action cannot carry the FunctionUrlAuthType condition;`,
      `  # the bare * principal is security-equivalent to the public URL itself — unauthenticated senders`,
      `  # were already the model, and authenticity is verified downstream by each channel's signature check.`,
      `  ForwarderInvokePermission:`,
      `    Type: AWS::Lambda::Permission`,
      `    Properties:`,
      `      FunctionName: !Ref Forwarder`,
      `      Action: lambda:InvokeFunction`,
      `      Principal: "*"`,
    );
  }

  if (translated.length > 0) {
    lines.push(
      ``,
      `  SchedulerRole:`,
      `    Type: AWS::IAM::Role`,
      `    Properties:`,
      `      AssumeRolePolicyDocument:`,
      `        Version: "2012-10-17"`,
      `        Statement:`,
      `          - Effect: Allow`,
      `            Principal: { Service: scheduler.amazonaws.com }`,
      `            Action: sts:AssumeRole`,
      `            Condition:`,
      `              StringEquals: { aws:SourceAccount: !Ref AWS::AccountId }`,
      `      Policies:`,
      `        - PolicyName: fire-forwarder`,
      `          PolicyDocument:`,
      `            Version: "2012-10-17"`,
      `            Statement:`,
      `              - Effect: Allow`,
      `                Action: lambda:InvokeFunction`,
      `                Resource: !GetAtt Forwarder.Arn`,
    );
    for (const { fact, expression } of translated) {
      lines.push(
        ``,
        `  Schedule${logicalId(fact.name)}:`,
        `    Type: AWS::Scheduler::Schedule`,
        `    Properties:`,
        `      Name: fastagent-${input.name}-${fact.name}`,
        `      ScheduleExpression: ${expression}`,
        `      ScheduleExpressionTimezone: ${fact.tz ?? "Etc/UTC"}`,
        `      FlexibleTimeWindow: { Mode: "OFF" }`,
        `      Target:`,
        `        Arn: !GetAtt Forwarder.Arn`,
        `        RoleArn: !GetAtt SchedulerRole.Arn`,
        `        # <aws.scheduler.scheduled-time> = the slot instant — the container's idempotency key`,
        `        # (EventBridge delivery is at-least-once; a duplicate slot must not double-fire).`,
        `        Input: '{"scheduleFire":{"name":"${fact.name}","slot":"<aws.scheduler.scheduled-time>"}}'`,
      );
    }
  }

  lines.push(``, `Outputs:`, `  RuntimeArn:`, `    Value: !GetAtt Runtime.AgentRuntimeArn`);
  if (needsForwarder) {
    lines.push(`  ForwarderUrl:`, `    Value: !GetAtt ForwarderUrl.FunctionUrl`);
  }
  return `${lines.join("\n")}\n`;
}

/** Compute the AgentCore deploy plan from the resolved definition. */
export function planAgentcoreDeploy(input: AgentcorePlanInput): AgentcorePlan {
  const { name, channels, kitDir } = input;
  const stack = `fastagent-${name}`;
  const repo = `fastagent/${name}`;
  const prefix = kitDir ? `${kitDir}/` : "";

  // Translate every schedule; the ones EventBridge cannot express become explicit runbook warnings —
  // a schedule silently missing from the template would be the worst failure mode (nothing ever fires).
  const translated: { fact: ScheduleFact; expression: string }[] = [];
  const untranslatable: { name: string; reason: string }[] = [];
  for (const fact of input.schedules) {
    const result = toEventBridgeCron(fact.cron);
    if ("expression" in result) translated.push({ fact, expression: result.expression });
    else untranslatable.push({ name: fact.name, reason: result.error });
  }

  const needsForwarder = input.routeChannels.length > 0 || translated.length > 0;
  const artifacts: Artifact[] = [
    { path: `${prefix}${TEMPLATE_FILE}`, content: template(input, translated) },
    ...(needsForwarder ? [{ path: `${prefix}lambda/forwarder.js`, content: forwarderSource() }] : []),
    ...containerArtifacts(input),
  ];

  const secrets = deploymentSecrets(input.modelAuth, channels, input.extraSecrets);
  const requiredSecrets = secrets.filter((s) => s.required);
  const optionalSecrets = secrets.filter((s) => !s.required);
  const paramHint = (list: typeof secrets): string => list.map((s) => `${cfnParamName(s.name)}=<value>`).join(" ");

  const image = `<account-id>.dkr.ecr.<region>.amazonaws.com/${repo}:<tag>`;
  const runbook: string[] = [
    `# Deploy "${name}" to AWS Bedrock AgentCore. ${prefix}${TEMPLATE_FILE} / Dockerfile(.dockerignore) are generated above.`,
    `# Prereqs: AWS CLI v2 with credentials + a region where AgentCore is available, and Docker with buildx`,
    `# (the image MUST be linux/arm64 — the one host whose build runs on YOUR machine, not remotely).`,
    ``,
    `# 1. ECR repository (one-time; skip if it exists):`,
    `aws ecr create-repository --repository-name ${repo}`,
    ``,
    `# 2. Build (linux/arm64) + push. Use a UNIQUE tag per deploy (a git sha / date): CloudFormation only`,
    `#    rolls the runtime when the ImageUri VALUE changes — re-pushing the same tag deploys nothing.`,
    `aws ecr get-login-password | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com`,
    kitDir
      ? `docker buildx build --platform linux/arm64 -f ${kitDir}/Dockerfile -t ${image} --push .`
      : `docker buildx build --platform linux/arm64 -t ${image} --push .`,
    ``,
    `# 3. Deploy the stack (runtime + ingress + schedules in one template). Secrets ride NoEcho parameters:`,
  ];
  if (requiredSecrets.length > 0) {
    runbook.push(
      `#    Required parameters:`,
      ...requiredSecrets.map((s) => `#      ${cfnParamName(s.name)}: ${s.hint}`),
    );
  }
  if (optionalSecrets.length > 0) {
    runbook.push(
      `#    Optional parameters (set only when the matching feature is configured):`,
      ...optionalSecrets.map((s) => `#      ${cfnParamName(s.name)}: ${s.hint}`),
    );
  }
  runbook.push(
    `aws cloudformation deploy --stack-name ${stack} --template-file ${prefix}${TEMPLATE_FILE} \\`,
    `  --capabilities CAPABILITY_IAM \\`,
    `  --parameter-overrides ImageUri=${image}${requiredSecrets.length > 0 ? ` ${paramHint(requiredSecrets)}` : ""}`,
    ``,
    `# 4. Read the outputs (the runtime ARN + the public webhook URL):`,
    `aws cloudformation describe-stacks --stack-name ${stack} --query "Stacks[0].Outputs"`,
  );

  // Model-auth guidance mirrors the other hosts: an env key became a parameter above; OAuth/stored
  // can't be read at plan time — `--run` carries it as FastagentAuthSeed.
  if (!isEnvKey(input.modelAuth)) {
    runbook.push(
      ``,
      input.modelAuth === undefined
        ? `# Model auth: none found at the local auth path — pass --auth-path <file>, or \`--run\` carries it`
        : `# Model auth: your local auth is "${input.modelAuth}" — the plan can't read its value; \`--run\` carries it`,
      `#   as the FastagentAuthSeed parameter (base64 of auth.json), materialized on first boot.`,
    );
  }

  // Post-deploy webhook registration — same per-channel steps as every host, pointed at the
  // forwarder's Function URL (read from the stack outputs).
  const post: string[] = [];
  if (channels.includes("telegram")) {
    post.push(
      `# Register the Telegram webhook (default route POST /telegram; secret_token MUST equal TELEGRAM_SECRET_TOKEN):`,
      `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\`,
      `  -d url=<ForwarderUrl>/telegram -d secret_token=<TELEGRAM_SECRET_TOKEN>`,
    );
  }
  if (channels.includes("github")) {
    post.push(
      `# Set the GitHub webhook (repo Settings → Webhooks): Payload URL = <ForwarderUrl>/webhook,`,
      `#   content type application/json, secret = GITHUB_WEBHOOK_SECRET.`,
      `# NOTE: github turns are fire-and-forget with no replay — a compute reclaimed mid-review drops it`,
      `#   (the ping's HealthyBusy holds the session while turns run, but the 8 h compute ceiling is hard).`,
    );
  }
  if (channels.includes("slack")) {
    post.push(`# Set Slack Event Subscriptions → Request URL = <ForwarderUrl>/slack (scopes per channels/slack.ts).`);
  }
  for (const kind of ["feishu", "lark"] as const) {
    if (!channels.includes(kind)) continue;
    post.push(
      `# Set the ${kind === "feishu" ? "Feishu" : "Lark"} event Request URL (developer console → Events & Callbacks):`,
      `#   Request URL = <ForwarderUrl>/${kind} (the stack must be deployed when you save — the console`,
      `#   sends a challenge, which rides through the forwarder to the channel and back verbatim).`,
    );
  }
  if (post.length > 0) runbook.push(``, ...post);

  for (const u of untranslatable) {
    runbook.push(
      ``,
      `# WARNING: schedule "${u.name}" has NO EventBridge rule — ${u.reason}.`,
      `#   It will NOT fire on this deployment until you create an equivalent trigger yourself.`,
    );
  }
  if (input.selfSchedule) {
    runbook.push(
      ``,
      `# NOTE: selfSchedule (the wake tool) is DEGRADED on AgentCore: wake-ups fire only while a session's`,
      `#   compute happens to be awake — there is no resident poller. Time-critical wake-ups need a host`,
      `#   with a resident process (fly/railway), or wait for the EventBridge wake backend.`,
    );
  }

  runbook.push(
    ``,
    `# Invoke the agent programmatically (any session id ≥ 33 chars; the response streams as SSE):`,
    `aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn <RuntimeArn> \\`,
    `  --runtime-session-id "my-conversation-000000000000000000" \\`,
    `  --payload '{"kind":"invoke","session":"cli","text":"hello"}' --cli-binary-format raw-in-base64-out /dev/stdout`,
  );
  if (needsForwarder) {
    runbook.push(
      ``,
      `# After a REDEPLOY, stop the ingress session so the new image serves immediately — a live session`,
      `# keeps its old compute (and the OLD image) until 15 min idle / the 8 h compute ceiling`,
      `# (\`--run\` does this automatically):`,
      `aws bedrock-agentcore stop-runtime-session --agent-runtime-arn <RuntimeArn> \\`,
      `  --runtime-session-id "${ingressSessionId(name)}"`,
    );
  }
  runbook.push(
    ``,
    `# Redeploy = step 2 with a NEW tag + step 3 with the new ImageUri. State (${MOUNT}: auth, sessions,`,
    `# channel state) persists across redeploys and compute recycling — but it is tied to this Runtime`,
    `# resource: renaming the runtime (or deleting the stack) starts blank. Need state that outlives the`,
    `# runtime? Switch the template to an EfsAccessPoint mount (VPC mode) — see the template comment.`,
  );

  return { artifacts, runbook, untranslatableSchedules: untranslatable };
}
