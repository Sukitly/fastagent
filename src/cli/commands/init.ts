/**
 * `fastagent init [dir]`: scaffold a runnable agent and install its dependencies. Placement is a default
 * plus one flag, never a detection and never a prompt — non-interactive executors (coding agents) get
 * deterministic behavior they can read. By default the agent goes into `./fastagent/` and the directory
 * around it, untouched, is the workspace; `--flat` makes the directory itself the agent (a standalone
 * agent repo, a monorepo package), in which case agent and workspace are the same directory.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { displayPath, scaffoldAgent } from "../../scaffold/init.ts";
import { failStartup } from "../fail.ts";

export interface InitOptions {
  minimal: boolean;
  /** false ⇔ `--no-install`. */
  install: boolean;
  /** The directory IS the agent (no `fastagent/` level). */
  flat: boolean;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  const {
    complete,
    agentDir: rel,
    created,
    kept,
  } = await scaffoldAgent(dir, {
    minimal: opts.minimal,
    flat: opts.flat,
  }).catch(failStartup);
  const flat = rel === ".";
  console.error(
    `[fastagent] initialized ${dir}${complete ? "" : " (minimal)"} — ${flat ? "the directory IS the agent" : `agent in ./${rel}/`}`,
  );
  console.error(`  created: ${created.join(", ")}`);
  if (kept.length > 0) {
    // Adopting a directory: its own files win, always. Say which ones, and — for the .gitignore
    // specifically — what fastagent would have put there, since that one carries the secret hygiene.
    console.error(`  kept your existing: ${kept.join(", ")}`);
    if (kept.includes(".gitignore")) {
      console.error(
        `[fastagent] note: your .gitignore is untouched — make sure it ignores node_modules, .state ` +
          `and .cache (.secrets/ carries its own .gitignore, so credentials are covered either way)`,
      );
    }
  }

  // The manifest lives in the AGENT dir, so the install runs there — never against a surrounding
  // workspace's package.json (its deps are its own concern). Flat: they are the same directory.
  const agentDir = resolve(dir, rel);
  const willInstall = complete && opts.install && !kept.includes(join(rel, "package.json"));
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install${flat ? "" : ` in ${rel}`})…`);
    installFailed = (await npmInstall(agentDir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${agentDir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = displayPath(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (complete && (!willInstall || installFailed)) {
    console.error(`    ${flat ? "npm install" : `(cd ${rel} && npm install)`}`);
  }
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
