import { describe, expect, it } from "vitest";
import {
  type AgentcorePlanInput,
  MOUNT,
  type ScheduleFact,
  TEMPLATE_FILE,
  cfnParamName,
  forwarderSource,
  ingressSessionId,
  planAgentcoreDeploy,
  toEventBridgeCron,
  toRuntimeName,
} from "../src/deploy/agentcore/plan.ts";

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
  });

  it("a route channel brings the forwarder (Lambda + URL + permission) and the webhook step", () => {
    const plan = planAgentcoreDeploy(baseInput({ channels: ["telegram"], routeChannels: ["telegram"] }));
    expect(plan.artifacts.map((a) => a.path)).toContain("lambda/forwarder.js");
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
    // The forwarder artifact and the template's inline ZipFile come from the ONE source.
    const forwarder = plan.artifacts.find((a) => a.path === "lambda/forwarder.js")!;
    expect(forwarder.content).toBe(forwarderSource());
    expect(template).toContain("InvokeAgentRuntimeCommand");
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

  it("kit layout namespaces the template + forwarder under the kit", () => {
    const plan = planAgentcoreDeploy(
      baseInput({ kitDir: "agent", routeChannels: ["telegram"], channels: ["telegram"] }),
    );
    const paths = plan.artifacts.map((a) => a.path);
    expect(paths).toContain(`agent/${TEMPLATE_FILE}`);
    expect(paths).toContain("agent/lambda/forwarder.js");
    expect(plan.runbook.join("\n")).toContain("-f agent/Dockerfile");
  });

  it("selfSchedule surfaces the wake degradation note", () => {
    const runbook = planAgentcoreDeploy(baseInput({ selfSchedule: true })).runbook.join("\n");
    expect(runbook).toContain("wake tool");
    expect(runbook).toContain("DEGRADED");
  });

  it("the forwarder source stays under CloudFormation's 4096-byte inline cap", () => {
    expect(Buffer.byteLength(forwarderSource())).toBeLessThan(4096);
  });

  it("OAuth model auth (non-env) gets the FastagentAuthSeed guidance instead of a fake secret", () => {
    const plan = planAgentcoreDeploy(baseInput({ modelAuth: "OAuth" }));
    const template = plan.artifacts[0]!.content;
    expect(template).not.toContain("Oauth:"); // no fabricated parameter from the label
    expect(plan.runbook.join("\n")).toContain("FastagentAuthSeed");
  });
});
