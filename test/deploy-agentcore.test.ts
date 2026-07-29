import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type AgentcorePlanInput,
  MOUNT,
  type ScheduleFact,
  TEMPLATE_FILE,
  GENERATED_TEMPLATE_MARKER,
  FORWARDER_FILE,
  STATE_KEY,
  cfnParamName,
  forwarderSource,
  isGeneratedAgentcoreTemplate,
  ingressSessionId,
  planAgentcoreDeploy,
  stateBucketName,
  toEventBridgeCron,
  toRuntimeName,
} from "../src/deploy/agentcore/plan.ts";
import { zipSingleFile } from "../src/deploy/agentcore/zip.ts";

const baseInput = (over: Partial<AgentcorePlanInput> = {}): AgentcorePlanInput => ({
  name: "my-agent",
  modelAuth: "OPENAI_API_KEY",
  channels: [],
  routeChannels: [],
  schedules: [],
  selfSchedule: false,
  hasPackageJson: false,
  runtime: "node",
  hasLockfile: false,
  version: "0.15.0",
  ...over,
});

describe("deploy agentcore: name/id helpers", () => {
  it("toRuntimeName produces [a-zA-Z][a-zA-Z0-9_]{0,47}", () => {
    expect(toRuntimeName("my-agent")).toBe("my_agent");
    expect(toRuntimeName("123 weird!!name")).toBe("agent_123_weird_name");
    expect(toRuntimeName("x".repeat(60))).toHaveLength(48);
    for (const name of ["my-agent", "123", "---"]) {
      expect(toRuntimeName(name)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    }
  });

  it("ingressSessionId clears the API's 33-char floor for any name", () => {
    expect(ingressSessionId("a").length).toBeGreaterThanOrEqual(33);
    expect(ingressSessionId("my-agent")).toContain("fastagent-ingress-my-agent");
    expect(ingressSessionId("x".repeat(200)).length).toBeLessThanOrEqual(128);
  });

  it("cfnParamName maps env names to alphanumeric parameter ids", () => {
    expect(cfnParamName("TELEGRAM_BOT_TOKEN")).toBe("TelegramBotToken");
    expect(cfnParamName("OPENAI_API_KEY")).toBe("OpenaiApiKey");
    expect(cfnParamName("FASTAGENT_AUTH_SEED")).toBe("FastagentAuthSeed");
  });
});

describe("deploy agentcore: cron translation", () => {
  const expression = (cron: string): string => {
    const r = toEventBridgeCron(cron);
    if ("error" in r) throw new Error(r.error);
    return r.expression;
  };
  const error = (cron: string): string => {
    const r = toEventBridgeCron(cron);
    if ("expression" in r) throw new Error(`unexpectedly translated: ${r.expression}`);
    return r.error;
  };

  it("hourly: both wildcards → dow becomes ?", () => {
    expect(expression("0 * * * *")).toBe("cron(0 * * * ? *)");
  });

  it("day-of-week numbering is remapped (standard 0/7=Sun → EventBridge 1=Sun)", () => {
    expect(expression("0 9 * * 1")).toBe("cron(0 9 ? * 2 *)"); // Monday
    expect(expression("0 9 * * 0")).toBe("cron(0 9 ? * 1 *)"); // Sunday as 0
    expect(expression("0 9 * * 7")).toBe("cron(0 9 ? * 1 *)"); // Sunday as 7
    expect(expression("0 9 * * 1-5")).toBe("cron(0 9 ? * 2-6 *)"); // weekday range
  });

  it("day-of-month restriction keeps dom, dow becomes ?", () => {
    expect(expression("30 6 1 * *")).toBe("cron(30 6 1 * ? *)");
  });

  it("names pass through unmapped", () => {
    expect(expression("0 9 * * MON")).toBe("cron(0 9 ? * MON *)");
  });

  it("steps are COUNTS, not weekdays — preserved verbatim while values/endpoints remap", () => {
    expect(expression("0 9 * * */2")).toBe("cron(0 9 ? * */2 *)");
    expect(expression("0 9 * * 1-5/2")).toBe("cron(0 9 ? * 2-6/2 *)");
  });

  it("lists remap per element; a range that wraps under renumbering is refused", () => {
    expect(expression("0 9 * * 1,3,5")).toBe("cron(0 9 ? * 2,4,6 *)");
    expect(expression("0 9 * * MON,3")).toBe("cron(0 9 ? * MON,4 *)");
    expect(error("0 9 * * 5-7")).toMatch(/wraps across the week/); // Fri–Sun → 6-1: not a valid range
    expect(error("0 9 * * 1-")).toMatch(/malformed/);
    expect(error("0 9 * * 1/")).toMatch(/malformed/);
  });

  it("refuses what EventBridge cannot express, with the reason", () => {
    expect(error("0 9 1 * 1")).toMatch(/BOTH day-of-month and day-of-week/);
    expect(error("0 0 9 * * 1")).toMatch(/5-field/);
    expect(error("0 9 * * 5L")).toMatch(/L\/#/);
  });
});

describe("deploy agentcore: the plan", () => {
  it("pure-invoke shape: template only (no forwarder, no schedules), lean runbook", () => {
    const plan = planAgentcoreDeploy(baseInput());
    expect(plan.artifacts.map((a) => a.path)).toEqual([TEMPLATE_FILE, "Dockerfile", ".dockerignore"]);
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("Type: AWS::BedrockAgentCore::Runtime");
    expect(template).toContain("AgentRuntimeName: my_agent");
    expect(template).toContain(`SessionStorage: { MountPath: ${MOUNT} }`);
    expect(template).toContain('FASTAGENT_AGENTCORE: "1"');
    expect(template).toContain('PORT: "8080"');
    expect(template).not.toContain("AWS::Lambda::Function");
    expect(template).not.toContain("AWS::Scheduler::Schedule");
    expect(plan.untranslatableSchedules).toEqual([]);
    expect(plan.runbook.join("\n")).not.toContain("stop-runtime-session"); // no forwarder → no ingress session
  });

  it("a route channel brings the forwarder (Lambda + URL + permission) and the webhook step", () => {
    const plan = planAgentcoreDeploy(baseInput({ channels: ["telegram"], routeChannels: ["telegram"] }));
    expect(plan.artifacts.map((a) => a.path)).toContain(FORWARDER_FILE);
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("Type: AWS::Lambda::Function");
    expect(template).toContain("Type: AWS::Lambda::Url");
    expect(template).toContain("AuthType: NONE");
    // BOTH url permissions — post-Oct-2025 Function URLs 403 with only InvokeFunctionUrl.
    expect(template).toContain("Action: lambda:InvokeFunctionUrl");
    expect(template).toContain("Action: lambda:InvokeFunction\n");
    // CommonJS on purpose — CFN inline code lands as index.js where ESM import is a syntax error.
    expect(forwarderSource()).toContain('require("@aws-sdk/client-bedrock-agentcore")');
    expect(forwarderSource()).toContain("exports.handler");
    expect(forwarderSource()).not.toMatch(/^import /m);
    expect(template).toContain(`INGRESS_SESSION_ID: ${ingressSessionId("my-agent")}`);
    // Secrets ride NoEcho parameters, mapped into the runtime environment.
    expect(template).toContain("TelegramBotToken:");
    expect(template).toContain("TELEGRAM_BOT_TOKEN: !Ref TelegramBotToken");
    expect(plan.runbook.join("\n")).toContain("setWebhook");
    // The redeploy-immediacy step is in the manual runbook too (— --run automates it).
    expect(plan.runbook.join("\n")).toContain("stop-runtime-session");
    // The shipped artifact IS the forwarder source (it becomes the Lambda package verbatim).
    const forwarder = plan.artifacts.find((a) => a.path === FORWARDER_FILE)!;
    expect(forwarder.content).toBe(forwarderSource());
    expect(forwarder.content).toContain("InvokeAgentRuntimeCommand");
  });

  it("schedules become EventBridge rules with tz + slot-carrying input; untranslatable ones warn", () => {
    const schedules: ScheduleFact[] = [
      { name: "digest", cron: "0 9 * * 1-5", tz: "Asia/Shanghai" },
      { name: "impossible", cron: "0 9 1 * 1" },
    ];
    const plan = planAgentcoreDeploy(baseInput({ schedules }));
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("ScheduleDigest:");
    expect(template).toContain("ScheduleExpression: cron(0 9 ? * 2-6 *)");
    expect(template).toContain("ScheduleExpressionTimezone: Asia/Shanghai");
    expect(template).toContain('\'{"scheduleFire":{"name":"digest","slot":"<aws.scheduler.scheduled-time>"}}\'');
    expect(template).not.toContain("impossible");
    expect(plan.untranslatableSchedules).toEqual([
      { name: "impossible", reason: expect.stringMatching(/BOTH day-of-month/) },
    ]);
    expect(plan.runbook.join("\n")).toContain('schedule "impossible" has NO EventBridge rule');
    // Schedules alone (no route channels) still need the forwarder — it is the fire path.
    expect(template).toContain("Type: AWS::Lambda::Function");
  });

  it("identifier collisions fail the plan visibly (a silently wrong stack is worse)", () => {
    expect(() =>
      planAgentcoreDeploy(
        baseInput({
          schedules: [
            { name: "foo-bar", cron: "0 * * * *" },
            { name: "foobar", cron: "30 * * * *" },
          ],
        }),
      ),
    ).toThrow(/same CloudFormation logical id/);
    expect(() => planAgentcoreDeploy(baseInput({ extraSecrets: ["FOO_BAR", "FOO__BAR"] }))).toThrow(
      /same CloudFormation parameter/,
    );
  });

  it("a schedule name with a quote cannot break the EventBridge Input YAML/JSON", () => {
    const plan = planAgentcoreDeploy(baseInput({ schedules: [{ name: "it's-daily", cron: "0 9 * * *" }] }));
    const template = plan.artifacts[0]!.content;
    expect(template).toContain(`'{"scheduleFire":{"name":"it''s-daily","slot":"<aws.scheduler.scheduled-time>"}}'`);
  });

  it("the forwarder Lambda timeout covers a whole schedule turn (EventBridge invokes async)", () => {
    const template = planAgentcoreDeploy(baseInput({ routeChannels: ["telegram"], channels: ["telegram"] }))
      .artifacts[0]!.content;
    expect(template).toContain("Timeout: 900");
  });

  it("kit layout namespaces the template + forwarder under the kit", () => {
    const plan = planAgentcoreDeploy(
      baseInput({ kitDir: "agent", routeChannels: ["telegram"], channels: ["telegram"] }),
    );
    const paths = plan.artifacts.map((a) => a.path);
    expect(paths).toContain(`agent/${TEMPLATE_FILE}`);
    expect(paths).toContain(`agent/${FORWARDER_FILE}`);
    expect(plan.runbook.join("\n")).toContain("-f agent/Dockerfile");
  });

  it("selfSchedule brings the full wake-alarm topology: forwarder, secret param, roles, env", () => {
    const plan = planAgentcoreDeploy(baseInput({ selfSchedule: true }));
    const template = plan.artifacts[0]!.content;
    // selfSchedule alone needs the forwarder — it is the alarm registrar and the poke target.
    expect(template).toContain("Type: AWS::Lambda::Function");
    expect(template).toContain("WakeSchedulerRole:");
    expect(template).toContain("FastagentWakeSecret:");
    expect(template).toContain("FASTAGENT_WAKE_SECRET: !Ref FastagentWakeSecret");
    expect(template).toContain("WAKE_SECRET: !Ref FastagentWakeSecret");
    expect(template).toContain("WAKE_PREFIX: fa-my-agent-wk-");
    expect(template).toContain("scheduler:CreateSchedule");
    expect(template).toContain("lambda:GetFunctionUrlConfig");
    const runbook = plan.runbook.join("\n");
    expect(runbook).toContain("EventBridge-backed");
    expect(runbook).toContain("FastagentWakeSecret=<any random string>");
    expect(runbook).not.toContain("DEGRADED");
    // The forwarder carries the alarm + poke machinery.
    expect(forwarderSource()).toContain("wake-alarm");
    expect(forwarderSource()).toContain("wakePoke");
  });

  it("the template opens with the generated marker (the drift gate's predicate)", () => {
    const template = planAgentcoreDeploy(baseInput()).artifacts[0]!.content;
    expect(template.startsWith(GENERATED_TEMPLATE_MARKER)).toBe(true);
    expect(isGeneratedAgentcoreTemplate(template)).toBe(true);
    expect(isGeneratedAgentcoreTemplate("# my hand-written template\n")).toBe(false);
  });

  it("ships the forwarder as a REAL Lambda entry (index.js) loaded from S3 by content-hashed key", () => {
    const plan = planAgentcoreDeploy(baseInput({ routeChannels: ["telegram"], channels: ["telegram"] }));
    // The artifact IS the deployment package's entry: zipping it as-is matches `Handler: index.handler`.
    expect(FORWARDER_FILE).toBe("lambda/index.js");
    expect(plan.artifacts.map((a) => a.path)).toContain("lambda/index.js");
    const template = plan.artifacts[0]!.content;
    expect(template).not.toContain("ZipFile"); // presigning pushed it past CFN's 4096-byte inline cap
    expect(template).toContain("S3Bucket: !Ref StateBucket");
    expect(template).toContain("S3Key: !Ref ForwarderS3Key");
    expect(template).toContain("  StateBucket:");
    expect(template).toContain("  ForwarderS3Key:");
  });

  it("grants the forwarder ONLY the one snapshot object, and hands the container its bucket/key", () => {
    const template = planAgentcoreDeploy(baseInput({ routeChannels: ["telegram"], channels: ["telegram"] }))
      .artifacts[0]!.content;
    expect(template).toContain("Action: [s3:GetObject, s3:PutObject]");
    expect(template).toContain(`Resource: !Sub arn:aws:s3:::\${StateBucket}/${STATE_KEY}`);
    expect(template).toContain("STATE_BUCKET: !Ref StateBucket");
    expect(template).toContain(`STATE_KEY: ${STATE_KEY}`);
  });

  it("an invoke-only deployment (no forwarder) carries no bucket wiring at all", () => {
    const template = planAgentcoreDeploy(baseInput()).artifacts[0]!.content;
    expect(template).not.toContain("StateBucket");
    expect(template).not.toContain("s3:GetObject");
  });

  it("tells the truth about state: the mount is wiped per deploy, the S3 snapshot is what survives", () => {
    const plan = planAgentcoreDeploy(baseInput({ routeChannels: ["telegram"], channels: ["telegram"] }));
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("wipes it on every VERSION UPDATE");
    expect(template).not.toMatch(/SessionStorage: platform-persistent/);
    const runbook = plan.runbook.join("\n");
    expect(runbook).toContain(stateBucketName("my-agent", "<account-id>"));
    expect(runbook).toContain(STATE_KEY);
    expect(runbook).toContain("every runtime version update");
  });

  describe("the forwarder deployment package", () => {
    /** Parse the single stored entry back out — proves the archive is real, not just plausible. */
    const readSingleEntry = (zip: Buffer) => {
      expect(zip.readUInt32LE(0)).toBe(0x04034b50); // local file header
      expect(zip.readUInt16LE(8)).toBe(0); // method 0 = stored
      const nameLength = zip.readUInt16LE(26);
      const size = zip.readUInt32LE(22);
      const name = zip.subarray(30, 30 + nameLength).toString();
      const content = zip.subarray(30 + nameLength, 30 + nameLength + size);
      expect(zip.readUInt32LE(14)).toBe(crc32(content)); // the CRC an unzipper will verify
      expect(zip.readUInt32LE(zip.byteLength - 22)).toBe(0x06054b50); // end of central directory
      expect(zip.readUInt16LE(zip.byteLength - 12)).toBe(1); // exactly one entry
      return { name, content: content.toString() };
    };

    it("packages the forwarder as a valid, self-consistent archive", () => {
      const entry = readSingleEntry(zipSingleFile("index.js", Buffer.from(forwarderSource())));
      expect(entry.name).toBe("index.js");
      expect(entry.content).toBe(forwarderSource());
    });

    it("is byte-deterministic — the S3 key is content-hashed, so identical source must not look new", () => {
      const once = zipSingleFile("index.js", Buffer.from("exports.handler = 1;"));
      const twice = zipSingleFile("index.js", Buffer.from("exports.handler = 1;"));
      expect(once.equals(twice)).toBe(true);
      expect(once.equals(zipSingleFile("index.js", Buffer.from("exports.handler = 2;")))).toBe(false);
    });
  });

  it("OAuth model auth (non-env) gets the FastagentAuthSeed guidance instead of a fake secret", () => {
    const plan = planAgentcoreDeploy(baseInput({ modelAuth: "OAuth" }));
    const template = plan.artifacts[0]!.content;
    expect(template).not.toContain("Oauth:"); // no fabricated parameter from the label
    expect(plan.runbook.join("\n")).toContain("FastagentAuthSeed");
  });
});
