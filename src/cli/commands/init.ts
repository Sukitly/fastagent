/**
 * `fastagent init [dir]`: scaffold a runnable agent and install its dependencies. Placement is not a
 * decision and has no variants: the agent goes into `./fastagent/`, and the directory around it — which
 * gets zero writes — is the workspace it works on. Deliberately no detection and no prompt —
 * non-interactive executors (coding agents) get ONE deterministic behavior they can read.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AGENT_DIR } from "../../engines/pi/config.ts";
import { nextStepCd, scaffoldAgent } from "../../scaffold/init.ts";
import { failStartup } from "../fail.ts";

export interface InitOptions {
  minimal: boolean;
  /** false ⇔ `--no-install`. */
  install: boolean;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  const { complete, created } = await scaffoldAgent(dir, { minimal: opts.minimal }).catch(failStartup);
  console.error(`[fastagent] initialized ${dir}${complete ? "" : " (minimal)"} — agent in ./${AGENT_DIR}/`);
  console.error(`  created: ${created.join(", ")}`);

  // The manifest lives in the agent dir, so the install runs there — never against the workspace's
  // own package.json (the workspace's deps are its own concern).
  const agentDir = resolve(dir, AGENT_DIR);
  const willInstall = complete && opts.install;
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install in ${AGENT_DIR})…`);
    installFailed = (await npmInstall(agentDir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${agentDir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = nextStepCd(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (complete && (!opts.install || installFailed)) console.error(`    (cd ${AGENT_DIR} && npm install)`);
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
