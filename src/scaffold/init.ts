/**
 * Init: scaffold a runnable fastagent agent, offline. Default = a COMPLETE agent (persona.md +
 * the writing-great-skills skill + a fetch-url code tool + fastagent.config.mjs + package.json +
 * .gitignore + .secrets/); `--minimal` drops the code tool and package.json. persona.md is the agent's
 * identity (prompt segment ①); an existing AGENTS.md is never written or touched — it is project
 * context (②), kept as-is. skills/ and tools/ are the agent's self-editable capabilities (re-read each
 * turn).
 *
 * Placement (no variants, no detection, no mode name): the WHOLE agent — definition, config,
 * `.secrets/`, machinery — lands in `<dir>/fastagent/`; the surrounding tree gets ZERO writes and
 * becomes the workspace the agent works on. Placement is structural (the directory NAME is the
 * marker — resolvePlacement), never configured. init either creates, or refuses with the reason (an
 * existing config, or a non-empty `fastagent/`).
 *
 * Scope: init is best-effort atomic for ORDINARY inputs — it never overwrites existing files,
 * preflights non-directory scaffold parents, and rolls back a partial write (files AND the
 * `fastagent/` tree it created for them, so a retry sees a clean slate). It does not defend against
 * every pathological target state (TOCTOU, FIFOs, disk-full): recover by delete-and-retry.
 *
 * Sibling scaffold modules: add-channel.ts (`add <channel>`), vendor-skill.ts (`add skill`). The files
 * this module writes are real templates under templates/, read through templates.ts.
 */
import { access, lstat, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { AGENT_CONFIG_NAMES, AGENT_DIR, enclosingAgentDir } from "../engines/pi/config.ts";
import { SECRETS_DIRNAME } from "../paths.ts";
import { baseTemplate, packageJson, toPackageName } from "./templates.ts";
import { fastagentVersion } from "../version.ts";

interface ScaffoldFile {
  rel: string;
  content: string;
}

export interface ScaffoldOptions {
  /** Scaffold the markdown-only unit (no package.json, no tool, no install) instead of a complete agent. */
  minimal?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  /** Whether a complete (code-tool) agent was scaffolded (false for --minimal). */
  complete: boolean;
  /** Files written by this run (relative to `dir`, so all under `fastagent/`). */
  created: string[];
}

/** How to WRITE a path for someone standing in `cwd`: relative when it is inside `cwd`, absolute when
 *  it climbs out (a `../../..` is noise), and undefined when it IS `cwd` (nothing to say). ONE policy,
 *  shared by `init`'s `cd` step and `add`'s next-steps paths — both answer the same question. */
export function displayPath(cwd: string, dir: string): string | undefined {
  const rel = relative(cwd, dir);
  if (rel === "") return undefined;
  // "Climbs out" is a path-SEGMENT check — rel is ".." or starts with "../" (or "..\" on Windows). A
  // bare startsWith("..") would wrongly flag an in-cwd directory literally named "..agent".
  const escapes = rel === ".." || /^\.\.[/\\]/.test(rel);
  return escapes ? dir : rel;
}

/** Does a path exist? (async; shared with the sibling scaffold modules). */
export async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Scaffold a runnable agent into `<dir>/fastagent/` (both created if missing). Default is a complete
 * agent (persona.md + the writing-great-skills skill + a code tool + package.json); `--minimal` drops
 * the code tool and package.json. Refuses when `<dir>/fastagent/` already holds a config (already an
 * agent) or any other content (an unfinished agent or something unrelated — landing persona.md beside
 * it would be a silent mix). Everything OUTSIDE `fastagent/` is untouched, including an existing
 * AGENTS.md: that is the project's context, adopted as-is.
 */
export async function scaffoldAgent(dir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const minimal = options.minimal ?? false;
  const root = AGENT_DIR;
  const skill = (name: string) => ({
    rel: join(root, "skills", "writing-great-skills", name),
    content: baseTemplate(`skills/writing-great-skills/${name}`),
  });
  const files: ScaffoldFile[] = [
    // ① identity. AGENTS.md is deliberately NOT scaffolded: a fresh agent has no project context, and
    // an existing repo already owns its AGENTS.md (kept untouched, read as ② context from the workspace).
    { rel: join(root, "persona.md"), content: baseTemplate("persona.md") },
    // The example skill: how to author skills well — the core of self-iteration. Markdown, so it
    // ships in --minimal too. Vendored verbatim from mattpocock/skills (MIT); LICENSE sits beside it.
    skill("SKILL.md"),
    skill("GLOSSARY.md"),
    skill("LICENSE"),
    { rel: join(root, "fastagent.config.mjs"), content: baseTemplate("fastagent.config.mjs") },
    { rel: join(root, ".gitignore"), content: baseTemplate("gitignore") },
    // `.secrets/`: real values (.env, auth.json) live here, never committed; the template and the
    // protection itself are un-ignored so both travel with the agent (see templates).
    { rel: join(root, SECRETS_DIRNAME, ".env.example"), content: baseTemplate("env.example") },
    { rel: join(root, SECRETS_DIRNAME, ".gitignore"), content: baseTemplate("secrets.gitignore") },
  ];
  if (!minimal) {
    files.push(
      { rel: join(root, "tools", "fetch-url.ts"), content: baseTemplate("tools/fetch-url.ts") },
      // The agent's own manifest. The name says WHOSE agent it is (this directory's), not which
      // subdirectory it always lives in — an agent is named after its workspace dir.
      {
        rel: join(root, "package.json"),
        content: packageJson(`${toPackageName(dir)}-agent`, await fastagentVersion()),
      },
    );
  }

  // `fastagent` is the agent-directory NAME, and findAgentDir checks the basename FIRST: scaffolding
  // into a directory already called that would produce `fastagent/fastagent/`, which every command
  // then resolves PAST (they find the outer one) — a silent no-op scaffold. Refuse with the way out.
  if (basename(dir) === AGENT_DIR) {
    throw new Error(
      `"${dir}": "${AGENT_DIR}" is the reserved agent-directory name, so this path already READS as an ` +
        `agent — nothing can be scaffolded here or under it (every command would resolve this ` +
        `directory, not the new agent). Rename it, or init in a different directory.`,
    );
  }
  // Inside an agent's own surface (`fastagent/skills`, `fastagent/tools`): scaffolding here would hide
  // a whole agent inside another agent's definition, where the outer one loads it as content. Every
  // other command refuses this position (resolvePlacement); init must not be the way in.
  const enclosing = enclosingAgentDir(dir);
  if (enclosing) {
    throw new Error(
      `"${dir}" is inside the agent ${enclosing} — an agent scaffolded here would be part of that ` +
        `agent's definition, not an agent of its own. Init in ${dirname(enclosing)} or another directory.`,
    );
  }

  // Preflight scaffold parent dirs FIRST: a pre-existing non-directory there would make mkdir fail
  // mid-loop AFTER the first write, leaving a half-scaffold — and a file or symlink named `fastagent`
  // must be named as such here, before the occupancy check below tries to read it as a directory
  // (lstat, not stat: a symlinked parent must be rejected, not followed — it would write outside the
  // agent dir).
  const parents = new Set<string>();
  for (const file of files) {
    let p = dirname(file.rel);
    while (p !== "." && p !== "") {
      parents.add(p);
      p = dirname(p);
    }
  }
  for (const rel of parents) {
    const st = await lstat(join(dir, rel)).catch(() => undefined);
    if (st && !st.isDirectory()) {
      throw new Error(
        `cannot scaffold: "${rel}" exists and is not a directory (a regular file or symlink) — remove it, or init elsewhere`,
      );
    }
  }

  // Refuse an occupied `fastagent/`. A config inside means it IS an agent already (name the marker
  // so the message is actionable); any other content means an unfinished agent or something
  // unrelated, and landing persona.md beside it would be a silent mix. Only ENOENT reads as "empty" —
  // any other fault (EACCES…) must surface here rather than as a raw errno mid-write.
  // (AGENTS.md outside is NOT a marker — it is context, adopted untouched.)
  // `.DS_Store`/`.gitkeep`/`.keep` are not evidence of anyone's content: Finder noise, and the standard
  // way to commit an empty directory (someone reserving `fastagent/` in git ahead of init).
  const occupants = (
    await readdir(join(dir, root)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    })
  ).filter((f) => ![".DS_Store", ".gitkeep", ".keep"].includes(f));
  const config = occupants.filter((f) => (AGENT_CONFIG_NAMES as readonly string[]).includes(f));
  if (config.length > 0) {
    throw new Error(`"${join(dir, root)}" already has ${config.join(", ")} — already a fastagent agent`);
  }
  if (occupants.length > 0) {
    throw new Error(
      `"${join(basename(dir), AGENT_DIR)}" already holds ${occupants.join(", ")} — move it away first, ` +
        `or run \`fastagent init\` in a different directory`,
    );
  }

  // Was the agent dir OURS to create? "Empty" is not ownership: a user may have pre-created it (or
  // left one behind), and the rollback below must not delete a directory this run did not make.
  const agentDirExisted = await exists(join(dir, root));
  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  // ONE rollback scope: any failure removes what THIS run created — files AND the directories it made
  // for them. Leaving the empty dirs behind would be worse than untidy: the occupancy refusal above
  // would then report the next `init` as occupied, blaming the user for our own debris. Every file
  // lands inside the `fastagent/` dir that refusal proved empty, so `wx` (never clobber) can only fire
  // on a concurrent writer — an error, not a file to keep.
  try {
    for (const file of files) {
      const abs = join(dir, file.rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content, { flag: "wx" });
      created.push(file.rel);
    }
  } catch (error) {
    // Best-effort rollback of a partial scaffold: anything that won't delete is left behind (the
    // original error below is the one worth surfacing — a cleanup failure must not mask it). Files
    // first, then the directories they lived in, deepest first: `rmdir` removes only what BECAME
    // empty, so a pre-existing sibling is never touched. The `fastagent/` root goes last, and only
    // when THIS run created it — "empty" was never proof of ownership. (Reaching here at all takes a
    // real fs fault: the occupancy refusal above proved the target empty, so nothing else can fail
    // mid-loop. The covered case is a permission fault before the first write.)
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    for (const rel of [...parents].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
      if (rel !== root) await rmdir(join(dir, rel)).catch(() => {});
    }
    if (!agentDirExisted) await rmdir(join(dir, root)).catch(() => {});
    throw error;
  }
  return { dir, complete: !minimal, created };
}
