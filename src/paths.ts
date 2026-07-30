/**
 * PLACEMENT: where an agent lives and what it works on — plus the machinery paths that follow from it.
 * Engine-neutral by nature (pure fs/path: a directory NAME and one shallow existence check), so it
 * lives here rather than under engines/pi. That is not a filing preference: the scaffold, the deploy
 * planners, the dev watcher and env.ts all need these facts, and routing them through the engine
 * would make neutral modules depend on it for something the engine has no say in.
 */
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The fixed name of an agent directory: `<workspace>/fastagent/`. Visible on purpose — the
 * agent directory holds the AUTHOR's content (persona, skills, tool code: code, not tool configuration), so it
 * follows the repo convention for code (a plain directory), while fastagent's own machinery inside it
 * (`.secrets/`, `.state/`) keeps the dot prefix.
 */
export const AGENT_DIR = "fastagent";

/** The user-global machinery home under `$HOME` — hidden, per the dotfile convention for per-user
 *  tool homes (`~/.cargo`, `~/.docker`); unrelated to {@link AGENT_DIR}, which names agent directories.
 *  It carries the same shape inside it as an agent dir does (`~/.fastagent/.secrets/auth.json`), so the
 *  resolvers below need no special case: `login` outside any agent simply hands them this directory. */
export const GLOBAL_HOME_DIR = ".fastagent";

/** The secrets segment inside an agent dir (or the global home): every PATH fastagent resolves —
 *  `.env`, `.env.example`, auth.json, the scaffold's write — derives from it, so they cannot drift
 *  apart. `FASTAGENT_SECRETS_DIR` relocates the RESOLVED dir ({@link resolveSecretsDir}), never this
 *  name. The scaffold's ignore templates are real files the author owns from `init` on, so they spell
 *  their rules out as literal text — renaming this constant means editing them too. */
export const SECRETS_DIRNAME = ".secrets";

/** The state segment inside an agent dir — same rule and same template caveat as {@link SECRETS_DIRNAME}. */
export const STATE_DIRNAME = ".state";

/** The config filenames, in load precedence. ONE source: the loader (below) and `scaffoldAgent`'s
 *  already-an-agent refusal both read this, so "is there a config?" can't diverge between them. */
export const AGENT_CONFIG_NAMES = ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"] as const;

export interface ResolvedPlacement {
  /** The AGENT directory — the `fastagent/` dir holding the definition (persona.md/skills/tools/
   *  channels/schedules), the config, and the machinery dirs (`.secrets/`, `.state/`). Absolute. */
  agentDir: string;
  /** The WORKSPACE — what the agent works ON: its parent directory, which is the agent's cwd and the
   *  start of the ② context walk. Absolute. The naming follows git: the repository sits at the root
   *  of its working tree, and the word for WORK belongs to the tree, not to the tool's own directory. */
  workspace: string;
}

/** What makes a `fastagent/` directory an AGENT rather than a same-named directory: any one authored
 *  surface. The check is deliberately shallow and cheap — it separates "an agent" from "an unrelated
 *  checkout / an empty leftover", never one placement from another. */
const AGENT_SURFACE = ["persona.md", "skills", "tools", "channels", "schedules"] as const;

/** The agent dir for `dir`, or undefined when there is none: `dir` itself if it IS a `fastagent/`
 *  directory, else `<dir>/fastagent/`. The candidate must exist AND hold something of an agent (a
 *  config or one of {@link AGENT_SURFACE}) — the name alone would make any directory called
 *  `fastagent` (an unrelated checkout, an empty leftover) resolve as a persona-less zero-config agent
 *  whose coding tools operate on its PARENT. The same evidence rule applies to both candidates, so
 *  where you invoke from still cannot change the answer. */
function isAgentDir(p: string): boolean {
  return (
    statSync(p, { throwIfNoEntry: false })?.isDirectory() === true &&
    [...AGENT_CONFIG_NAMES, ...AGENT_SURFACE].some((name) => existsSync(join(p, name)))
  );
}

export function findAgentDir(dir: string): string | undefined {
  const base = resolve(dir);
  if (basename(base) === AGENT_DIR) return isAgentDir(base) ? base : undefined;
  const nested = join(base, AGENT_DIR);
  return isAgentDir(nested) ? nested : undefined;
}

/** The agent `dir` sits INSIDE (the nearest proper ancestor that IS an agent dir), or undefined.
 *  Placement resolution deliberately never walks up — the answer must not depend on how deep you
 *  stand — but "you are inside an agent, just not at its root" is the likeliest reason resolution
 *  fails, and both the refusal below and `login`'s global-fallback decision need to tell that case
 *  apart. Same evidence rule as {@link findAgentDir}: a same-named directory holding no definition is
 *  not an agent, so we never claim someone is standing in one. */
export function enclosingAgentDir(dir: string): string | undefined {
  const segments = resolve(dir).split(sep);
  for (let depth = segments.length - 2; depth > 0; depth--) {
    if (segments[depth] !== AGENT_DIR) continue;
    const candidate = segments.slice(0, depth + 1).join(sep);
    if (isAgentDir(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Why `dir` is not an agent, when it has its OWN way out — or undefined when it is simply not near
 * one. Two positions qualify: standing INSIDE an agent (`fastagent/tools/`), and a directory NAMED
 * `fastagent` that holds no definition. Both matter because the generic advice ("run `fastagent init`")
 * is advice the scaffolder then refuses — it would build `fastagent/fastagent/`, which nothing resolves.
 *
 * Exported because `login` is the one command allowed to run outside an agent, and it must tell "truly
 * outside" (→ the global credential) from "a dead end" (→ refuse, like every other command). Without
 * this it re-derived the second case with its own `basename(dir) === AGENT_DIR` check, duplicating the
 * rule stated below.
 */
export function placementDeadEnd(dir: string): string | undefined {
  const base = resolve(dir);
  const enclosing = enclosingAgentDir(base);
  if (enclosing) {
    return `${base} is inside the agent ${enclosing} but is not its root — \`cd\` there (or to its workspace) and re-run`;
  }
  if (basename(base) === AGENT_DIR) {
    return (
      `${base} is named "${AGENT_DIR}" but holds no definition — that name is reserved for agent ` +
      `directories, so an agent cannot be scaffolded here. \`cd ..\` and run \`fastagent init\`, or rename it`
    );
  }
  return undefined;
}

/**
 * Resolve a directory into its placement — the ONE owner of the rule, and it has exactly one shape:
 * the agent lives in a directory named `fastagent/` that holds a definition, and the directory around
 * it is the workspace. Placement is STRUCTURAL — never configured, never detected from the
 * surroundings, and never dependent on where you invoked from: `<dir>` and `<dir>/fastagent` resolve
 * identically, because the SAME name + evidence test ({@link findAgentDir}) decides both.
 *
 * Anything else throws (fail visibly). Resolution itself never walks UP — the answer must not depend
 * on how deep you stand — but the MESSAGE reads the path, so each dead end gets the exit that fits it
 * ({@link placementDeadEnd}).
 */
export function resolvePlacement(dir: string): ResolvedPlacement {
  const base = resolve(dir);
  const agentDir = findAgentDir(base);
  if (!agentDir) {
    throw new Error(
      placementDeadEnd(base) ??
        `${base} is not a fastagent agent — no ./${AGENT_DIR}/ directory holding a definition here; ` +
          `run \`fastagent init\` to scaffold one`,
    );
  }
  return { agentDir, workspace: dirname(agentDir) };
}

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
  return resolveOverridePath(env.FASTAGENT_STATE_DIR) ?? join(resolve(dir), STATE_DIRNAME);
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
  return resolveOverridePath(env.FASTAGENT_SECRETS_DIR) ?? join(resolve(dir), SECRETS_DIRNAME);
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
