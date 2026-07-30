/**
 * PLACEMENT: where an agent lives and what it works on — plus the machinery paths that follow from it.
 * Engine-neutral by nature (pure fs/path: a directory NAME and one shallow existence check), so it
 * lives here rather than under engines/pi. That is not a filing preference: the scaffold, the deploy
 * planners, the dev watcher and env.ts all need these facts, and routing them through the engine
 * would make neutral modules depend on it for something the engine has no say in.
 */
import { existsSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
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
  /** The AGENT directory — where the definition (persona.md/skills/tools/channels/schedules), the
   *  config, and the machinery dirs (`.secrets/`, `.state/`) live. Absolute. */
  agentDir: string;
  /** The WORKSPACE — what the agent works ON: its cwd, and the start of the ② context walk. The agent
   *  dir's PARENT when the agent is a nested `fastagent/`; the agent dir ITSELF when the directory is
   *  the agent (`--flat`). Absolute. `agentDir === workspace` is the only discriminant — there is no
   *  mode field, because placement is a fact about the tree, not a setting. The naming follows git:
   *  the repository sits at the root of its working tree, and the word for WORK belongs to the tree. */
  workspace: string;
}

/** What makes a `fastagent/` directory an AGENT rather than a same-named directory: any one authored
 *  surface. Shallow and cheap on purpose — it separates "an agent" from "an unrelated checkout / an
 *  empty leftover". Enough for the NAMED placement, where the name already carries the intent; the
 *  flat one needs a stronger marker (see {@link findPlacement}). */
const AGENT_SURFACE = ["persona.md", "skills", "tools", "channels", "schedules"] as const;

function isDir(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** A `fastagent/`-NAMED agent dir: exists and holds one authored surface (or a config). */
function isNamedAgentDir(p: string): boolean {
  return isDir(p) && [...AGENT_CONFIG_NAMES, ...AGENT_SURFACE].some((name) => existsSync(join(p, name)));
}

/** A FLAT agent dir: the directory declares itself with a `fastagent.config.*`. That marker is stricter
 *  than the named placement's on purpose — a flat agent has no name to carry the intent, and
 *  {@link AGENT_SURFACE} alone would read half the world's repositories (`tools/`, `skills/`) as agents.
 *  The trade is explicit: there is no zero-config flat agent, and `init --flat` always writes one. */
function isFlatAgentDir(p: string): boolean {
  return isDir(p) && AGENT_CONFIG_NAMES.some((name) => existsSync(join(p, name)));
}

/**
 * Resolve `dir` into its placement, or undefined when it is not an agent. THREE candidates, checked in
 * a fixed ORDER — which is what makes two placements cost one rule instead of an ambiguity story:
 *
 *   1. `dir` IS a `fastagent/` dir holding a definition → nested, entered from the inside
 *   2. `<dir>/fastagent/` holds a definition            → nested (the `init` default)
 *   3. `dir` holds a `fastagent.config.*`               → FLAT: the directory IS the agent
 *
 * A directory that satisfies both 2 and 3 resolves NESTED — the explicitly-named agent wins over the
 * self-declared one. Ordering rather than refusing is deliberate: an earlier design treated that
 * overlap as an ambiguity to reject, which required the config to double as a structural marker, an
 * entry-point-invariance rule, and a "does this read as an agent?" probe. What the user needs is to SEE
 * which one answered — and `dev`/`start`/`info` print `agent:` and `workspace:` on every run.
 */
function findPlacement(dir: string): ResolvedPlacement | undefined {
  const base = resolve(dir);
  if (basename(base) === AGENT_DIR && isNamedAgentDir(base)) return { agentDir: base, workspace: dirname(base) };
  const nested = join(base, AGENT_DIR);
  if (isNamedAgentDir(nested)) return { agentDir: nested, workspace: base };
  if (isFlatAgentDir(base)) return { agentDir: base, workspace: base };
  return undefined;
}

/** Is `p` a NESTED agent dir (its basename is `fastagent`)? The one fact separating "fastagent's own
 *  directory" from "the user's project directory that happens to BE an agent" — a distinction only
 *  MESSAGES need: a flat agent's root is the author's tree, so fastagent must not lecture about the
 *  files in it. Never used for resolution, which already knows which candidate answered. */
export function isNestedAgentDir(p: string): boolean {
  return basename(resolve(p)) === AGENT_DIR;
}

/** The agent dir for `dir`, or undefined when there is none — {@link findPlacement} without the pair.
 *  For callers that only need "is this an agent, and which one" (`login`'s global fallback, the
 *  stray-`.env` warning). */
export function findAgentDir(dir: string): string | undefined {
  return findPlacement(dir)?.agentDir;
}

/** The agent `dir` sits INSIDE (the nearest proper ancestor that IS an agent dir), or undefined.
 *  Module-private: the two questions callers actually ask are "where do I `cd` to?"
 *  ({@link placementDeadEnd}) and "would a new agent here become part of an existing one's definition?"
 *  ({@link agentDefinitionOwner}) — and those answers differ for a flat agent, so exporting the raw
 *  containment fact would invite conflating them.
 *  Placement resolution deliberately never walks up — the answer must not depend on how deep you stand
 *  — but "you are inside an agent, just not at its root" is the likeliest reason resolution fails, and
 *  both the refusal below and `login`'s global-fallback decision need to tell that case apart. Uses the
 *  same rule as resolution (an ancestor that resolves to ITSELF), so it covers a flat agent's
 *  subdirectory as well as a nested one's — and never claims a position it cannot justify. */
function enclosingAgentDir(dir: string): string | undefined {
  let candidate = dirname(resolve(dir));
  for (let prev = ""; candidate !== prev; prev = candidate, candidate = dirname(candidate)) {
    if (findPlacement(candidate)?.agentDir === candidate) return candidate;
  }
  return undefined;
}

/**
 * The agent whose DEFINITION contains `dir` — scaffolding there would make the new agent part of the
 * outer one's loaded surface rather than an agent of its own. Narrower than {@link enclosingAgentDir} on
 * purpose: a NESTED agent dir is fastagent's own directory, so everything inside it belongs to it, but a
 * FLAT agent owns only its authored surfaces ({@link AGENT_SURFACE}) — the rest of that directory is the
 * author's tree, where a second agent (a monorepo package, say) is a perfectly legitimate thing to
 * create. `enclosingAgentDir` answers a different question ("where do I `cd` to?"), and for that a flat
 * agent's `src/` genuinely IS inside it.
 */
export function agentDefinitionOwner(dir: string): string | undefined {
  const base = resolve(dir);
  const agent = enclosingAgentDir(base);
  if (!agent) return undefined;
  if (isNestedAgentDir(agent)) return agent;
  const [head] = relative(agent, base).split(sep);
  return head && (AGENT_SURFACE as readonly string[]).includes(head) ? agent : undefined;
}

/**
 * Why `dir` is not an agent, when it has its OWN way out — or undefined when it is simply not near one.
 * Two positions qualify: standing INSIDE an agent (a nested agent's `tools/`, a flat agent's `src/`),
 * and a directory NAMED `fastagent` that holds no definition. Both matter because the generic advice
 * ("run `fastagent init`") is advice the scaffolder then refuses — it would build
 * `fastagent/fastagent/`, which nothing resolves.
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
 * Resolve a directory into its placement — the ONE owner of the rule. Two placements, ONE ordered test
 * ({@link findPlacement}): the agent is a `fastagent/` directory holding a definition (its parent is the
 * workspace), or a directory that declares itself with a `fastagent.config.*` (it IS the workspace).
 * Placement is STRUCTURAL — never configured, never detected from the surroundings, and never dependent
 * on where you invoked from: `<dir>` and `<dir>/fastagent` resolve identically.
 *
 * Anything else throws (fail visibly). Resolution itself never walks UP — the answer must not depend on
 * how deep you stand — but the MESSAGE reads the path, so each dead end gets the exit that fits it
 * ({@link placementDeadEnd}).
 */
export function resolvePlacement(dir: string): ResolvedPlacement {
  const placement = findPlacement(dir);
  if (!placement) {
    const base = resolve(dir);
    throw new Error(
      placementDeadEnd(base) ??
        `${base} is not a fastagent agent — no ./${AGENT_DIR}/ directory holding a definition, and no ` +
          `fastagent.config.* here; run \`fastagent init\` to scaffold one`,
    );
  }
  return placement;
}

/** How to WRITE a path for someone standing in `cwd`: relative when it is inside `cwd`, absolute when
 *  it climbs out (a `../../..` is noise), and undefined when it IS `cwd` (nothing to say). ONE policy,
 *  shared by `init`'s `cd` step, `add`'s next-steps paths and `fire`'s "looked in" hint — they all answer
 *  the same question, which is a placement-PRESENTATION question, not a scaffolding one. */
export function displayPath(cwd: string, dir: string): string | undefined {
  const rel = relative(cwd, dir);
  if (rel === "") return undefined;
  // "Climbs out" is a path-SEGMENT check — rel is ".." or starts with "../" (or "..\" on Windows). A
  // bare startsWith("..") would wrongly flag an in-cwd directory literally named "..agent".
  const escapes = rel === ".." || /^\.\.[/\\]/.test(rel);
  return escapes ? dir : rel;
}

/** Does a path exist? Plain fs, no placement in it — it lives here because `paths.ts` is where the
 *  neutral path helpers are, and the scaffolder is not a utility home for the CLI and deploy. */
export async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
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
