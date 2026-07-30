/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<agentDir>/.secrets/auth.json`) by default, or `--auth-path`/`FASTAGENT_AUTH_PATH`. The
 * positional is the PROVIDER (not a dir), so the agent resolves from cwd — `cd` into your agent
 * before logging in. OUTSIDE an agent there is no project credential to write, so the target is the
 * user-global `~/.fastagent/.secrets/auth.json` (which is what running it from $HOME has always
 * meant) — announced on stderr BEFORE the flow, because that is a different credential than the one
 * `dev`/`start` in a real agent would read, and a silent scope switch is exactly the surprise this
 * command must not ship.
 *
 * fastagent writes no `.gitignore` here or anywhere else at runtime: `init` scaffolds the agent's one
 * ignore file (covering `.secrets/`) and the author owns it from then on. The credential store creates
 * its own directory, mode 0700.
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { resolveAuthPath } from "../../engines/pi/config.ts";
import { AGENT_DIR, GLOBAL_HOME_DIR, enclosingAgentDir, findAgentDir, resolvePlacement } from "../../paths.ts";
import { LoginCancelled } from "../../engines/pi/login.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup, failStartupOn } from "../fail.ts";
import { isInteractive, loginWithKeyCheck } from "../shared.ts";

export interface LoginOptions {
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  const agentDir = findAgentDir(process.cwd());
  // "Outside an agent" must mean exactly that. Standing inside one (`fastagent/tools/`), or in a
  // directory NAMED `fastagent` that holds no definition, are both positions resolvePlacement refuses
  // with a specific way out — and taking the global fallback there would write a credential to a
  // different scope under a message saying there is no agent here. Route all of them through the one
  // owner, so login's story matches every other command's.
  const cwd = process.cwd();
  if (!agentDir && (enclosingAgentDir(cwd) || basename(cwd) === AGENT_DIR)) {
    failStartupOn(() => resolvePlacement(cwd));
  }
  // Outside any agent the target is the user-global machinery home — handed over explicitly, so the
  // path resolvers need no "is this $HOME?" special case to infer it.
  const loginDir = agentDir ?? join(homedir(), GLOBAL_HOME_DIR);
  loadDotEnv(loginDir); // FASTAGENT_AUTH_PATH / a proxy (HTTPS_PROXY) may be configured in the project .env
  installProxyFetch(); // the OAuth token exchange must go through HTTPS_PROXY (region-locked providers)
  const authPath = resolveAuthPath(loginDir, opts.authPath); // flag > FASTAGENT_AUTH_PATH > default — the one owner
  // Announce when the FALLBACK is what decided the target: outside an agent with no explicit path,
  // the credential lands somewhere no agent will read. An explicit `--auth-path`/FASTAGENT_AUTH_PATH
  // is the user naming the file, so there is no surprise to announce (and announcing a path this run
  // does not write would be worse than saying nothing). The resolved path goes in the message.
  if (!agentDir && !opts.authPath && !process.env.FASTAGENT_AUTH_PATH) {
    console.error(
      `[fastagent] no agent definition in ./${AGENT_DIR}/ here — logging in GLOBALLY (${authPath}). ` +
        `An agent reads its own ` +
        `.secrets/auth.json: \`cd\` into one first, or point this run at it with --auth-path.`,
    );
  }
  // login is inherently interactive — loginFlow renders provider/method menus and opens a browser (or
  // prompts for a key). In a non-TTY (a pipe, CI, a coding-agent shell) the menu can't receive keystrokes
  // and would hang; --no-input asks for the same posture explicitly. Fail fast with the reason instead
  // of stalling on an unanswerable prompt.
  if (opts.input === false || !isInteractive()) {
    failStartup(
      new Error(`login is interactive (it shows a menu and opens a browser) — run it in a terminal, not a pipe/CI`),
    );
  }
  // loginWithKeyCheck: an entered API key is verified with one minimal request; a rejected key (401)
  // re-prompts in place, so a returned result is always a stored-and-not-definitively-bad credential.
  const result = await loginWithKeyCheck(provider, authPath).catch((error: unknown) => {
    if (error instanceof LoginCancelled) {
      // A decision, not a failure — neutral wording; non-zero exit because no credential was stored.
      console.error(`[fastagent] login cancelled`);
      process.exit(1);
    }
    failStartup(error);
  });
  console.error(`[fastagent] logged in to ${result.provider} (${result.method}) — saved to ${authPath}`);
  process.exit(0); // the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
}
