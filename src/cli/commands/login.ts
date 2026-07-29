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
 * Creates and self-ignores `<root>/.secrets/` (the credential's gitignored home) BEFORE the auth flow,
 * so the secret can never land untracked — a flow that then fails (bad provider, abort) leaves that
 * empty secrets dir behind, by design (no secret without its `.gitignore`). Skipped for the HOME-global dir.
 */
import { homedir } from "node:os";
import { dirname } from "node:path";
import { loadDotEnv } from "../../env.ts";
import {
  AGENT_DIR,
  enclosingAgentDir,
  findAgentDir,
  resolveAuthPath,
  resolvePlacement,
} from "../../engines/pi/config.ts";
import { ensureSecretsDirSelfIgnored } from "../../engines/pi/definition.ts";
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
  // Standing INSIDE an agent (`fastagent/tools/`) is NOT "outside an agent": the global fallback would
  // write a credential the agent right here will never read, under a message saying there is no agent.
  // resolvePlacement owns that refusal — every other command gives the same one.
  if (!agentDir && enclosingAgentDir(process.cwd())) failStartupOn(() => resolvePlacement(process.cwd()));
  const loginDir = agentDir ?? homedir();
  loadDotEnv(loginDir); // FASTAGENT_AUTH_PATH / a proxy (HTTPS_PROXY) may be configured in the project .env
  installProxyFetch(); // the OAuth token exchange must go through HTTPS_PROXY (region-locked providers)
  const authPath = resolveAuthPath(loginDir, opts.authPath); // flag > FASTAGENT_AUTH_PATH > default — the one owner
  // Announce when the FALLBACK is what decided the target: outside an agent with no explicit path,
  // the credential lands somewhere no agent will read. An explicit `--auth-path`/FASTAGENT_AUTH_PATH
  // is the user naming the file, so there is no surprise to announce (and announcing a path this run
  // does not write would be worse than saying nothing). The resolved path goes in the message.
  if (!agentDir && !opts.authPath && !process.env.FASTAGENT_AUTH_PATH) {
    console.error(
      `[fastagent] no ./${AGENT_DIR}/ here — logging in GLOBALLY (${authPath}). An agent reads its own ` +
        `.secrets/auth.json: \`cd\` into one first, or point this run at it with --auth-path.`,
    );
  }
  // login is the command that CREATES the credential file, so the leak guard binds HERE too (not only
  // in the opener): a `login` before the first dev/start would otherwise leave the secret
  // untracked-but-committable. login writes ONLY auth.json, so the dir to protect is that file's OWN
  // parent — not the default secrets dir: an in-agent `--auth-path`/`FASTAGENT_AUTH_PATH` (e.g.
  // `fastagent/creds/auth.json`) lands somewhere else in the tree and needs the same protection. A
  // genuinely out-of-agent path is nothing of ours (no empty dir created); it is announced instead,
  // because the credential still gets written. The guard itself skips the HOME-global dir.
  const authHome = dirname(authPath);
  if ((await ensureSecretsDirSelfIgnored(loginDir, authHome)) === "outside") {
    console.error(
      `[fastagent] warn: ${authPath} is outside the agent — fastagent does not write a .gitignore there, ` +
        `so make sure the credential cannot be committed`,
    );
  }
  // login is inherently interactive — loginFlow renders provider/method menus and opens a browser (or
  // prompts for a key). In a non-TTY (a pipe, CI, a coding-agent shell) the menu can't receive keystrokes
  // and would hang; --no-input asks for the same posture explicitly. Fail fast with the reason instead
  // of stalling on an unanswerable prompt. (After the secret-hygiene self-ignore above, which is cheap
  // prep, so a later terminal login is safe.)
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
