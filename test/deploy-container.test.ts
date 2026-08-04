import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts } from "../src/deploy/container.ts";

const input = {
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "0.0.0",
  agentPrefix: "fastagent/",
} as const;

describe("deploy/container: shared Docker context", () => {
  it("keeps tracked secrets scaffolds without shipping credentials or state", () => {
    const artifacts = containerArtifacts(input);
    const rootIgnore = artifacts.find((artifact) => artifact.path === ".dockerignore")!.content;
    const dockerfileIgnore = artifacts.find(
      (artifact) => artifact.path === "fastagent/Dockerfile.dockerignore",
    )!.content;

    expect(dockerfileIgnore).toBe(rootIgnore);
    expect(rootIgnore).toMatch(/^\*\*\/\.secrets\/\*\*$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.env\.example$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.secrets\/\.gitignore$/m);
    expect(rootIgnore).not.toMatch(/^\*\*\/\.secrets$/m);

    // Excluding descendants rather than the directory keeps these negations meaningful in both
    // Docker's matcher and the stricter gitignore-style matcher used by deploy preflight.
    const ignored = ignore({ ignorecase: false }).add(rootIgnore);
    const ships = (path: string): boolean => !ignored.ignores(path);
    const tracked = [
      "README.md",
      "fastagent/.secrets/.env.example",
      "fastagent/.secrets/.gitignore",
      ".secrets/.env.example",
      ".secrets/.gitignore",
    ];
    const sensitive = [
      "fastagent/.secrets/.env",
      "fastagent/.secrets/auth.json",
      "fastagent/.secrets/nested/token",
      "fastagent/.state/sessions/session.jsonl",
      ".secrets/.env",
      ".state/channels/telegram.json",
    ];

    // With .git shipped, this difference is the set `git ls-files --deleted` would report after COPY.
    expect(tracked.filter((path) => !ships(path))).toEqual([]);
    expect(sensitive.filter(ships)).toEqual([]);
    expect(ships(".git/HEAD")).toBe(true);
  });
});
