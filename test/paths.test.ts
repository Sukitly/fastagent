/**
 * PLACEMENT and the neutral path helpers (src/paths.ts): engine-neutral by nature, so their spec lives
 * here rather than inside the config or scaffold suites that used to own the rule.
 */
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayPath, resolvePlacement, workspaceHint } from "../src/paths.ts";

describe("paths: resolvePlacement — one marker, and the directory you point at", () => {
  const config = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fastagent.config.mjs"), "export default {};\n");
  };

  it("the agent is the config holder one level inside; the workspace is what you pointed at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await config(join(dir, "fastagent"));
    expect(resolvePlacement(dir)).toEqual({ agentDir: join(dir, "fastagent"), workspace: dir });
  });

  it("the NAME is not a rule — an agent directory can be called anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-name-"));
    await config(join(dir, "reviewer"));
    expect(resolvePlacement(dir)).toEqual({ agentDir: join(dir, "reviewer"), workspace: dir });
    // …and a directory NAMED fastagent with no config is not an agent: one file decides it, everywhere.
    const plain = await mkdtemp(join(tmpdir(), "fa-ws-plain-"));
    await mkdir(join(plain, "fastagent", "tools"), { recursive: true });
    expect(() => resolvePlacement(plain)).toThrow(/not a fastagent agent/);
  });

  it("pointing AT the agent makes it work on ITSELF — the divergence is the honest answer", async () => {
    // The same tree answers two ways, and neither is wrong: a deployed box may hold nothing but the
    // agent, and a rule insisting its workspace is the parent would hand it the container root.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-aim-"));
    const agent = join(dir, "fastagent");
    await config(agent);
    expect(resolvePlacement(dir)).toEqual({ agentDir: agent, workspace: dir });
    expect(resolvePlacement(agent)).toEqual({ agentDir: agent, workspace: agent });
    // The cost of that (a `cd` drops the project from the agent's view) is carried by a HINT, which may
    // use the heuristic a rule may not — and stays silent when there is no project to point at.
    expect(workspaceHint(resolvePlacement(agent))).toBeUndefined();
    await writeFile(join(dir, "AGENTS.md"), "# project\n");
    expect(workspaceHint(resolvePlacement(agent))).toMatch(/looks like a project/);
    expect(workspaceHint(resolvePlacement(dir))).toBeUndefined(); // already working on it
  });

  it("SEVERAL agents on one workspace: FASTAGENT_AGENT picks, the default NAME breaks the tie", async () => {
    // The shape this supports: an engineer's, a PM's and a content owner's agent driving one repository,
    // all with that repository as their workspace. Selection is per-person, so it lives in the
    // environment (a shell, an .envrc) — never in a committed file, which is shared by construction.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-many-"));
    await config(join(dir, "content"));
    await config(join(dir, "pm"));
    const pick = (v?: string) => resolvePlacement(dir, v === undefined ? {} : { FASTAGENT_AGENT: v });

    expect(pick("pm")).toEqual({ agentDir: join(dir, "pm"), workspace: dir });
    expect(pick("content").agentDir).toBe(join(dir, "content"));
    // Nothing selects: refuse and name them — never serve an arbitrary one.
    expect(() => pick()).toThrow(/holds 2 agents \(content, pm\) and none of them is named "fastagent"/);
    // Naming a missing one is a different mistake: echo the value back rather than restate the rule.
    expect(() => pick("nope")).toThrow(/FASTAGENT_AGENT names "nope", which is not one of them/);

    // The default name is the tie-break, so adding an agent to a working `<ws>/fastagent/` setup does
    // not break the command everyone already types. It decides only WHICH — never what IS an agent.
    await config(join(dir, "fastagent"));
    expect(pick().agentDir).toBe(join(dir, "fastagent"));
    expect(pick("pm").agentDir).toBe(join(dir, "pm")); // …and the env still outranks it

    // Each is also its own workspace when pointed at — same rule, no special case for siblings.
    expect(resolvePlacement(join(dir, "pm"))).toEqual({ agentDir: join(dir, "pm"), workspace: join(dir, "pm") });
  });

  it("the env SELECTS among candidates — with only one there is nothing to select", async () => {
    // A FASTAGENT_AGENT exported in a shell profile travels into every directory. Refusing there would
    // break every single-agent repository it is carried into, and the value resolves no ambiguity.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-one-"));
    await config(join(dir, "only"));
    expect(resolvePlacement(dir, { FASTAGENT_AGENT: "something-else" }).agentDir).toBe(join(dir, "only"));
  });

  it("the scan is ONE level: a grandchild agent is its own workspace, not this one's agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-deep-"));
    await config(join(dir, "packages", "reviewer"));
    expect(() => resolvePlacement(dir)).toThrow(/not a fastagent agent/);
    expect(resolvePlacement(join(dir, "packages"))).toEqual({
      agentDir: join(dir, "packages", "reviewer"),
      workspace: join(dir, "packages"),
    });
  });

  it("no config → not an agent: refuse with the way out, never guess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-none-"));
    expect(() => resolvePlacement(dir)).toThrow(/not a fastagent agent.*fastagent init/s);
    // A path that does not exist refuses the same way (a missing dir is not an error to raise here).
    expect(() => resolvePlacement(join(dir, "missing"))).toThrow(/not a fastagent agent/);

    // Standing INSIDE an agent (its tools/, skills/…) is the likeliest way to reach this refusal, and
    // "run `fastagent init`" is not the answer there — so it names the agent to `cd` to.
    await config(join(dir, "agent"));
    await mkdir(join(dir, "agent", "tools"), { recursive: true });
    expect(() => resolvePlacement(join(dir, "agent", "tools"))).toThrow(/is inside the agent .*but is not its root/);

    // …but ONLY when that ancestor really is an agent: the same marker resolution uses. A directory
    // holding no config must never be reported as "the agent you are in" — the `cd` would land here.
    await mkdir(join(dir, "checkout", "examples"), { recursive: true });
    expect(() => resolvePlacement(join(dir, "checkout", "examples"))).toThrow(/is not a fastagent agent/);
  });
});

describe("paths: displayPath", () => {
  it("displayPath: relative inside cwd, absolute when the target climbs out, nothing for cwd itself", () => {
    expect(displayPath("/a/b", "/a/b/x")).toBe("x"); // inside cwd → relative
    expect(displayPath("/a/b", "/a/b/..agent")).toBe("..agent"); // a dir literally named "..agent" is INSIDE cwd
    expect(displayPath("/a/b", "/a/b")).toBeUndefined(); // already in cwd → no cd step
    expect(displayPath("/a/b", "/tmp/x")).toBe("/tmp/x"); // outside → absolute, not ../../tmp/x noise
  });
});
