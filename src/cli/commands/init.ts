/**
 * `fastagent init [dir]`: scaffold a runnable agent and install its dependencies. Placement is not a
 * decision: the workspace goes into `./fastagent/` (the host tree gets zero writes); `--flat` lands it
 * directly in the directory instead (for a directory that IS the agent — a standalone agent dir, a
 * monorepo package). Deliberately no detection and no prompt — non-interactive executors (coding
 * agents) get ONE deterministic behavior they can read and override.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { nextStepCd, scaffoldWorkspace } from "../../scaffold/init.ts";
import { failStartup } from "../fail.ts";

export interface InitOptions {
  minimal: boolean;
  /** false ⇔ `--no-install`. */
  install: boolean;
  flat: boolean;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  const { complete, root, created, skipped, patched, warnings } = await scaffoldWorkspace(dir, {
    minimal: opts.minimal,
    flat: opts.flat,
  }).catch(failStartup);
  const nested = root !== ".";
  console.error(
    `[fastagent] initialized ${dir}${complete ? "" : " (minimal)"}${nested ? ` — workspace in ./${root}/` : ""}`,
  );
  if (created.length > 0) console.error(`  created: ${created.join(", ")}`);
  if (skipped.length > 0) console.error(`  kept existing: ${skipped.join(", ")}`);
  if (patched.length > 0) console.error(`  updated: ${patched.join(", ")} (missing fastagent excludes appended)`);
  for (const w of warnings) console.error(`[fastagent] warn: ${w}`);

  // Install deps only for a complete agent whose package.json we just wrote (a kept one is not ours).
  // The manifest lives at the workspace root (./fastagent by default), so the install runs there —
  // never against a host repo's own package.json.
  const rootDir = resolve(dir, root);
  const willInstall = complete && opts.install && created.includes(join(root, "package.json"));
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install${nested ? ` in ${root}` : ""})…`);
    installFailed = (await npmInstall(rootDir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${rootDir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = nextStepCd(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (complete && (!opts.install || installFailed))
    console.error(`    ${nested ? `(cd ${root} && npm install)` : "npm install"}`);
  console.error(`    fastagent dev   # serve locally and iterate`);
  console.error(`    fastagent add skill <owner/repo/path>   # vendor more skills from GitHub`);
}

/** Run `npm install` in `cwd` (inherit stdio). Returns the exit code. */
function npmInstall(cwd: string): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn("npm", ["install"], { cwd, stdio: "inherit" });
    child.on("close", (code) => resolveCode(code ?? 1));
    child.on("error", () => resolveCode(1));
  });
}
