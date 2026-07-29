/**
 * Placement + machinery path resolution — engine-neutral (pure fs/path). The agent directory NAME and
 * the machinery paths (`.state`/`.secrets` + their env overrides) live here, not under engines/pi,
 * because the scaffold, env.ts (the neutral `.env` reader) and engines/pi/config.ts (which re-exports
 * the public names) all derive from them: ONE owner, without pulling engine code into neutral modules.
 */
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The fixed name of an agent directory: `<workspace>/fastagent/`. Visible on purpose — the
 * agent directory holds the AUTHOR's content (persona, skills, tool code: code, not tool configuration), so it
 * follows the repo convention for code (a plain directory), while fastagent's own machinery inside it
 * (`.secrets/`, `.state/`) keeps the dot prefix.
 */
export const AGENT_DIR = "fastagent";

/** The user-global machinery home under `$HOME` — hidden, per the dotfile convention for per-user
 *  tool homes (`~/.cargo`, `~/.docker`); unrelated to {@link AGENT_DIR}, which names agent directories. */
export const GLOBAL_HOME_DIR = ".fastagent";

/** The secrets segment inside an agent dir (or the global home): every PATH fastagent resolves —
 *  `.env`, `.env.example`, auth.json, the scaffold's write — derives from it, so they cannot drift
 *  apart. `FASTAGENT_SECRETS_DIR` relocates the RESOLVED dir ({@link resolveSecretsDir}), never this
 *  name. The scaffold's ignore templates are real files the author owns from `init` on, so they spell
 *  their rules out as literal text — renaming this constant means editing them too. */
export const SECRETS_DIRNAME = ".secrets";

/** The state segment inside an agent dir — same rule, same template caveat; `FASTAGENT_STATE_DIR`
 *  relocates the resolved dir ({@link resolveStateRoot}), never this name. */
export const STATE_DIRNAME = ".state";

/**
 * Resolve a user-supplied path override (a CLI flag or an env var) to an absolute path, expanding a
 * leading `~`/`~/` to the home dir FIRST. Path-valued config from `.env` (or any non-shell source)
 * never gets the shell's `~` expansion, so a bare `resolve("~/x")` would silently create a literal `~`
 * directory — a fail-silently footgun for a secret/state path. Expanding here makes `~` mean home
 * everywhere these knobs are read.
 */
export function resolveOverridePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

/**
 * The machinery home for an agent dir: the dir itself — EXCEPT when it IS the user's home directory,
 * where machinery lives under the user-global `~/.fastagent/` instead (so `~/.secrets` / `~/.state`
 * are never created). Placement resolution never yields `$HOME` as an agent dir, so the one caller
 * that reaches this branch is `login`'s outside-any-agent fallback, which passes `homedir()`
 * explicitly. The global home carries the same shape inside it (`~/.fastagent/.secrets/auth.json` —
 * GLOBAL_AUTH_PATH in auth.ts). Canonical comparison: `dir` arrives realpath-resolved
 * (process.cwd()), homedir() may be a symlink.
 */
function machineryHome(dir: string): string {
  const canonical = (p: string): string => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  return canonical(dir) === canonical(homedir()) ? join(resolve(dir), GLOBAL_HOME_DIR) : resolve(dir);
}

/**
 * The resolved state root — the durable machine-state home (sessions/, channels/<kind>/, schedule/,
 * control.json): `FASTAGENT_STATE_DIR` env > `<agentDir>/.state`. Absolute, so channels and the
 * startup report agree regardless of cwd. Definition: mutable runtime state — single lifecycle
 * (precious, survives redeploy), single process; a container points this at its mounted volume.
 * Secrets are NOT here — they live under {@link resolveSecretsDir} (a different deploy lifecycle:
 * secret store vs volume). The finer knob (`FASTAGENT_SESSIONS_DIR`) still overrides its path on top.
 *
 * `FASTAGENT_STATE_DIR` is an OPERATOR override, so a relative value resolves against `process.cwd()`
 * — the CLI convention its sibling knobs share (`resolveOverridePath`), NOT against `dir`. Only the
 * DEFAULT (`<root>/.state`) is dir-anchored.
 */
export function resolveStateRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_STATE_DIR) ?? join(machineryHome(dir), STATE_DIRNAME);
}

/**
 * The resolved secrets dir — everything fastagent manages that must NEVER leave the machine (the
 * agent's `.env` + auth.json): `FASTAGENT_SECRETS_DIR` env > `<agentDir>/.secrets`. Split from
 * the state root on deploy lifecycle: secrets travel through the host's secret store (env vars / the
 * auth seed), state through a volume. A deployed box sets both env knobs at its volume (e.g.
 * `/data/.secrets`, `/data/.state`) so a seeded-then-ROTATED OAuth credential persists across
 * restarts. The `.env`'s OWN location resolves from the REAL environment — commands locate and load
 * `.env` before anything else, so a `FASTAGENT_SECRETS_DIR` set INSIDE `.env` still relocates
 * auth.json but cannot move the file it is read from (env.ts dotEnvPath).
 */
export function resolveSecretsDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_SECRETS_DIR) ?? join(machineryHome(dir), SECRETS_DIRNAME);
}

/**
 * Guard that `<agentDir>/<name>` resolves INSIDE the agent dir — a symlink that escapes (or an
 * absolute target) is rejected, so discovery/scaffolding never reaches out of the definition directory.
 * A missing target is fine (nothing to guard yet).
 */
export async function assertInsideAgentDir(agentDir: string, name: string): Promise<void> {
  const target = join(agentDir, name);
  const real = await realpath(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "not_found") return undefined;
    throw e;
  });
  if (real === undefined) return;
  const root = await realpath(agentDir).catch(() => resolve(agentDir));
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `${target} resolves outside the agent dir (${real}) — it must live inside the definition directory; ` +
        `use a real directory or a symlink that stays within it`,
    );
  }
}
