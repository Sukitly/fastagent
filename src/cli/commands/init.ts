/**
 * `fastagent init [dir]`: scaffold a runnable agent and install its dependencies. Layout: flags force;
 * otherwise the jurisdiction rule decides (see detectHostSignals) and the reason is printed.
 * Deliberately no prompt — non-interactive executors (coding agents) get a deterministic default they
 * can read and override.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { detectHostSignals, nextStepCd, scaffoldWorkspace } from "../../scaffold/init.ts";
import { failStartup, failUsage } from "../fail.ts";

export interface InitOptions {
  minimal: boolean;
  /** false ⇔ `--no-install`. */
  install: boolean;
  flat: boolean;
  standalone: boolean;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  if (opts.flat && opts.standalone) failUsage("--flat and --standalone are mutually exclusive");
  let standalone = opts.standalone;
  let signals: string[] = [];
  if (!opts.flat && !opts.standalone) {
    signals = await detectHostSignals(dir).catch(failStartup);
    standalone = signals.length > 0;
  }

  const { complete, root, created, skipped, patched, intoNonEmpty, warnings } = await scaffoldWorkspace(dir, {
    minimal: opts.minimal,
    standalone,
  }).catch(failStartup);
  // The layout reason prints only once the scaffold actually happened — an "already a workspace" refusal
  // must not be preceded by an announced decision that then never takes place.
  if (signals.length > 0) {
    console.error(
      `[fastagent] found ${signals.join(", ")} — an existing toolchain/deploy claims this directory, so the ` +
        `whole workspace goes into ./.fastagent/ (standalone; zero files at the host root). Override: --flat`,
    );
  }
  console.error(
    `[fastagent] initialized ${dir}${complete ? "" : " (minimal)"}${standalone ? " — workspace in ./.fastagent/ (standalone)" : ""}`,
  );
  if (created.length > 0) console.error(`  created: ${created.join(", ")}`);
  if (skipped.length > 0) console.error(`  kept existing: ${skipped.join(", ")}`);
  if (patched.length > 0) console.error(`  updated: ${patched.join(", ")} (missing fastagent excludes appended)`);
  if (intoNonEmpty && !standalone) {
    console.error(
      `  note: scaffolded flat into a non-empty directory (nothing claims it — the directory is the agent); use --standalone to nest the workspace in ./.fastagent/ instead`,
    );
  }
  for (const w of warnings) console.error(`[fastagent] warn: ${w}`);

  // Install deps only for a complete agent whose package.json we just wrote (a kept one is not ours).
  // The manifest lives at the workspace root (./.fastagent when standalone), so the install runs there
  // — never against a host repo's own package.json.
  const rootDir = resolve(dir, root);
  const willInstall = complete && opts.install && created.includes(join(root, "package.json"));
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install${standalone ? ` in ${root}` : ""})…`);
    installFailed = (await npmInstall(rootDir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${rootDir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = nextStepCd(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (complete && (!opts.install || installFailed))
    console.error(`    ${standalone ? `(cd ${root} && npm install)` : "npm install"}`);
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
