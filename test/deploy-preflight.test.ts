import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { preflightDeploy } from "../src/deploy/preflight.ts";
import { AGENT_DIR, type FastagentConfig } from "../src/engines/pi/config.ts";

/** A workspace with an agent in it, as `init` produces (`<host>/fastagent/`); returns the AGENT DIR.
 *  `files` land in the agent dir; the workspace around it is always `dirname(agentDir)`. */
async function workspace(files: Record<string, string> = {}): Promise<string> {
  const host = await mkdtemp(join(tmpdir(), "fa-preflight-"));
  await writeFile(join(host, "AGENTS.md"), "You are terse.\n"); // ② context, lives in the workspace
  const dir = join(host, AGENT_DIR);
  await mkdir(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const call = (target: string, config: FastagentConfig, over: Partial<Parameters<typeof preflightDeploy>[0]> = {}) =>
  preflightDeploy({
    agentDir: target,
    workspace: dirname(target),
    config,
    modelSpec: config.model,
    run: false,
    force: false,
    authPathFlag: undefined,
    ...over,
  });

describe("deploy/preflight: the host-neutral pre-flight", () => {
  it("gates --run when the model isn't in config (would ship a crash-loop)", async () => {
    const dir = await workspace();
    // model resolved via --model/FASTAGENT_MODEL, absent from config → won't travel.
    const pre = await call(dir, {}, { modelSpec: "openai/gpt-4o-mini", run: true });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.gate).toMatch(/fastagent\.config/);
  });

  it("container facts come from the AGENT DIR; git auto-baked when the workspace ships .git", async () => {
    const agentDir = await workspace({
      "fastagent.config.mjs": `export default { model: "openai/gpt-4o-mini" };\n`,
      "package.json": `{"type":"module","dependencies":{"@fastagent-sh/fastagent":"^1"}}`,
    });
    await mkdir(join(dirname(agentDir), ".git")); // the workspace is a git repo — the image gets the git binary

    const ok = await call(agentDir, { model: "openai/gpt-4o-mini", deploy: { apt: ["ripgrep"] } }, { run: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.container.hasPackageJson).toBe(true); // the AGENT's manifest, not the workspace's
      expect(ok.container.apt).toEqual(["git", "ripgrep"]); // git baked (workspace ships .git), deploy.apt kept, deduped
      expect(JSON.stringify(ok.messages)).toMatch(/baked as the agent's workspace/); // the WYSIWYG note is stated
    }
  });

  it("git is baked iff the baked workspace ships a .git — a non-git dir gets no silent git layer", async () => {
    // No .git: only the author's declared packages reach the image (history without a binary is a
    // dead loop; a binary without history is dead weight — deploy.apt is the explicit escape hatch).
    const noGit = await workspace();
    const pre = await call(noGit, { model: "openai/gpt-4o-mini", deploy: { apt: ["ripgrep"] } });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.container.shipsGit).toBe(false);
      expect(pre.container.apt).toEqual(["ripgrep"]);
    }

    // .git present: git rides in.
    const gitDir = await workspace();
    await mkdir(join(dirname(gitDir), ".git"));
    const pre2 = await call(gitDir, { model: "openai/gpt-4o-mini" });
    expect(pre2.ok).toBe(true);
    if (pre2.ok) {
      expect(pre2.container.shipsGit).toBe(true);
      expect(pre2.container.apt).toEqual(["git"]);
    }
  });

  it("a kept workspace .dockerignore: warns for missing secret/machinery excludes and **/node_modules; notes a .git exclude", async () => {
    const agentDir = await workspace({ "package.json": `{"type":"module"}` });
    await writeFile(join(dirname(agentDir), ".dockerignore"), ".git\nnode_modules\n"); // the workspace's own — kept, not ours

    const pre = await call(agentDir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      const text = JSON.stringify(pre.messages);
      expect(text).toMatch(/BAKE SECRETS INTO THE IMAGE/); // missing .secrets/.env excludes — the critical one
      expect(text).toMatch(/does not exclude .{0,12}\.state/); // machine state would ship
      expect(text).toMatch(/lacks .{0,4}\*\*\/node_modules/); // the native-binary clobber hazard — named
      expect(text).toMatch(/excludes \.git/); // pull\/push loop dead — named as a note
    }
  });

  it("--run gates on a kept .dockerignore that would bake secrets or drop the agent", async () => {
    // Missing **/.secrets and **/.env excludes: warn generate-only (asserted above), GATE under --run —
    // a full deploy must not push a secret-laden image (same discipline as the model-travel gate).
    const agentDir = await workspace();
    const host = dirname(agentDir);
    await writeFile(join(host, ".dockerignore"), "node_modules\n");
    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/BAKE SECRETS/);

    // Dockerignore patterns are ROOT-ANCHORED, unlike .gitignore's: a bare `.secrets` covers only the
    // workspace root, NOT the agent's own `fastagent/.secrets` where the credentials actually live.
    await writeFile(join(host, ".dockerignore"), ".secrets\n.env\n");
    const rootOnly = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(rootOnly.ok).toBe(false);
    if (!rootOnly.ok) expect(rootOnly.gate).toMatch(/fastagent\/\.secrets\/auth\.json/);

    // A rule matching the agent dir: the context ships WITHOUT the agent — the whole deploy is
    // meaningless (crash-loop with no persona/config), so gate regardless of where the rule came from.
    await writeFile(join(host, ".dockerignore"), "**/fastagent\n**/.secrets\n**/.env\n");
    const noAgent = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(noAgent.ok).toBe(false);
    if (!noAgent.ok) expect(noAgent.gate).toMatch(/WITHOUT the agent/);

    // Negation is the ignore matcher's job, with git's last-match-wins: a later `!` re-includes the
    // path, so the secrets are back in the context → still gates.
    await writeFile(join(host, ".dockerignore"), "**/.secrets\n!**/.secrets\n**/.env\n");
    const negated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(negated.ok).toBe(false);
    if (!negated.ok) expect(negated.gate).toMatch(/\.secrets/);

    // The generated excludes satisfy every check — no gate, no secret/state/node_modules warning.
    await writeFile(join(host, ".dockerignore"), "**/node_modules\n**/.secrets\n**/.state\n**/.env\n");
    const clean = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(JSON.stringify(clean.messages)).not.toMatch(/BAKE SECRETS|node_modules|\.state/);
  });

  it("warns (not gates) about the same model issue without --run", async () => {
    const dir = await workspace();
    const pre = await call(dir, {}, { modelSpec: "openai/gpt-4o-mini", run: false });
    expect(pre.ok).toBe(true);
    if (pre.ok)
      expect(pre.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/fastagent\.config/) });
  });

  it("computes container facts and no model message when the model is in config (markdown agent)", async () => {
    const dir = await workspace();
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.container.hasPackageJson).toBe(false); // markdown/skills agent → global-install path
    expect(pre.container.runtime).toBe("node");
    expect(pre.port).toBe(8787);
    expect(pre.messages.some((m) => /fastagent\.config/.test(m.text))).toBe(false);
  });

  it("recognizes Slack as a first-party route channel for secrets/deploy guidance", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "slack.mjs"), "export default () => ({ '/slack': () => new Response() });\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual(["slack"]);
      expect(pre.routeChannels).toEqual(["slack"]);
      expect(pre.messages.some((message) => message.text.includes('channel "slack" is custom'))).toBe(false);
    }
  });

  it("notes a custom channel (its secrets/webhook are the author's to wire)", async () => {
    const dir = await workspace();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "discord.ts"), "export default () => ({});\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.routeChannels).toEqual(["discord"]);
      expect(pre.longConnectionChannels).toEqual([]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringContaining('route channel "discord" is custom'),
      });
    }
  });

  it("recognizes a long-connection module structurally and reports its always-on requirement", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(
      join(dir, "channels", "feishu.mjs"),
      `export default { name: "feishu websocket", connect() {} };\n`,
    );
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual(["feishu"]);
      expect(pre.routeChannels).toEqual([]);
      expect(pre.longConnectionChannels).toEqual(["feishu"]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/long-connection channel.*keeps one machine running/),
      });
    }
  });

  it("keeps a custom long-connection channel always-on without pretending it has a webhook", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "socket.mjs"), `export default { name: "custom socket", connect() {} };\n`);
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([]);
      expect(pre.routeChannels).toEqual([]);
      expect(pre.longConnectionChannels).toEqual(["socket"]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/long-connection channel "socket".*keep the process running.*skip webhook/),
      });
    }
  });

  it("fails visibly when an enabled channel throws during deployment inspection", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "broken.mjs"), `throw new Error("import exploded");\n`);
    await expect(call(dir, { model: "openai/gpt-4o-mini" })).rejects.toThrow(/cannot inspect.*import exploded/);
  });

  it("warns a KEPT hand-written Dockerfile that deploy.apt won't reach; --force suppresses it", async () => {
    const dir = await workspace({ Dockerfile: "FROM python:3.12\n" }); // no generated marker → hand-written
    const config: FastagentConfig = { model: "openai/gpt-4o-mini", deploy: { apt: ["git"] } };

    const kept = await call(dir, config, { force: false });
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/deploy\.apt.*NOT applied/) });
    }

    // --force regenerates the Dockerfile, so the kept-hand-written warning does not apply.
    const forced = await call(dir, config, { force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.messages.some((m) => /NOT applied/.test(m.text))).toBe(false);
  });

  it("detects time triggers: schedules/ files OR config.selfSchedule → hasTimeTriggers + a keep-1 note", async () => {
    // Neither → false, no note.
    const none = await call(await workspace(), { model: "openai/gpt-4o-mini" });
    expect(none.ok && !none.hasTimeTriggers).toBe(true);

    // A schedules/ file → true + note (cron has no external wake-up).
    const dir = await workspace();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(dir, "schedules"), { recursive: true });
    await wf(join(dir, "schedules", "daily.ts"), "export default {};\n"); // discovery counts files, not validity
    const withCron = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(withCron.ok && withCron.hasTimeTriggers).toBe(true);
    if (withCron.ok) {
      expect(withCron.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/keeps one machine running/),
      });
    }

    // selfSchedule alone (the wake tool) → true: a wake-up needs the box awake just like a cron.
    const wake = await call(await workspace(), { model: "openai/gpt-4o-mini", selfSchedule: true });
    expect(wake.ok && wake.hasTimeTriggers).toBe(true);
  });

  it("warns a code agent with no lockfile and no @fastagent-sh/fastagent dep", async () => {
    const dir = await workspace({ "package.json": JSON.stringify({ name: "a", type: "module" }) });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages.some((m) => /no package-lock\.json/.test(m.text) || /not reproducible/.test(m.text))).toBe(
      true,
    );
    expect(pre.messages.some((m) => /does not list @fastagent-sh\/fastagent/.test(m.text))).toBe(true);
  });
});
