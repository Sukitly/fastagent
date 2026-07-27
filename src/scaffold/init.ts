/**
 * Init: scaffold a runnable fastagent workspace, offline. Default = a COMPLETE agent (persona.md +
 * the writing-great-skills skill + a fetch-url code tool + fastagent.config.mjs + package.json +
 * .gitignore + .secrets/); `--minimal` drops the code tool and package.json. persona.md is the agent's
 * identity (prompt segment ①); an existing AGENTS.md is never written or touched — it is project
 * context (②), kept as-is. skills/ and tools/ are the agent's self-editable capabilities (re-read each
 * turn).
 *
 * Placement (no detection, no mode name): ONE workspace shape, and by default the WHOLE workspace —
 * definition, config, `.secrets/`, machinery — nests into `<dir>/fastagent/`; the host tree gets ZERO
 * writes and the placement is structural (resolveWorkspace detects the `fastagent/` root), never
 * configured. `--flat` is the variant: the same shape lands directly in `dir` ("the directory IS the
 * agent" — a standalone agent dir or a monorepo package). There is deliberately NO heuristic choosing
 * between them — init either creates, or refuses with the reason (a non-empty `fastagent/`, an
 * existing config, or `--flat` into the reserved `fastagent` name).
 *
 * Scope: init is best-effort atomic for ORDINARY inputs — it never overwrites existing files,
 * preflights non-directory scaffold parents, and rolls back a partial write (one exception: the
 * .gitignore APPEND is not rolled back — idempotent, harmless residue). It does not defend against
 * every pathological target state (TOCTOU, FIFOs, disk-full): recover by delete-and-retry.
 *
 * Sibling scaffold modules: add-channel.ts (`add <channel>`), vendor-skill.ts (`add skill`). The files
 * this module writes are real templates under templates/, read through templates.ts.
 */
import { access, appendFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { WORKSPACE_CONFIG_NAMES, WORKSPACE_DIR } from "../engines/pi/config.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";
import { loadRootIgnore } from "../workspace.ts";
import { baseTemplate, packageJson, personaTemplate, toPackageName } from "./templates.ts";
import { fastagentVersion } from "../version.ts";

interface ScaffoldFile {
  rel: string;
  content: string;
}

export interface ScaffoldOptions {
  /** Scaffold the markdown-only unit (no package.json, no tool, no install) instead of a complete agent. */
  minimal?: boolean;
  /**
   * Land the workspace directly in `dir` instead of the default `<dir>/fastagent/` nesting. For the
   * case where the directory IS the agent (a standalone agent dir, a monorepo package).
   */
  flat?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  /** Whether a complete (code-tool) agent was scaffolded (false for --minimal). */
  complete: boolean;
  /** The workspace root relative to `dir`: "fastagent" (default) or "." (--flat). */
  root: string;
  /** Files written by this run (relative paths). */
  created: string[];
  /** Files that already existed and were kept untouched (e.g. a pre-existing .gitignore). */
  skipped: string[];
  /** Kept ignore files appended with missing fastagent excludes (flat only: node_modules/). */
  patched: string[];
  /** True if the target already had content before this run (init into an existing/non-empty dir). */
  intoNonEmpty: boolean;
  /** Non-fatal advisories the caller MUST surface. */
  warnings: string[];
}

/** The `cd` target to show in `init`'s next-steps: the relative path when the target is inside `cwd`,
 *  the absolute path when it climbs out (a `../../..` is noise), or undefined when already in `cwd`. */
export function nextStepCd(cwd: string, dir: string): string | undefined {
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
 * Scaffold a runnable workspace into {@link dir} (created if missing). Default is a complete agent
 * (persona.md + the writing-great-skills skill + a code tool + package.json); `--minimal` drops the
 * code tool and package.json. ONE workspace shape either way: the default nests it into
 * `<dir>/fastagent/` (zero host-tree writes), `--flat` lands the identical shape in `dir` (refused when
 * `dir` is itself named `fastagent` — the reserved nested name). Refuses an
 * existing fastagent.config.* at either root (the ownership marker — already a workspace); every
 * other pre-existing file (AGENTS.md, .gitignore, package.json) is kept, never overwritten — an
 * existing AGENTS.md is the project's context, adopted as-is.
 */
export async function scaffoldWorkspace(dir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const minimal = options.minimal ?? false;
  const nested = !(options.flat ?? false);
  const root = nested ? WORKSPACE_DIR : ".";
  const skill = (name: string) => ({
    rel: join(root, "skills", "writing-great-skills", name),
    content: baseTemplate(`skills/writing-great-skills/${name}`),
  });
  const files: ScaffoldFile[] = [
    // ① identity. AGENTS.md is deliberately NOT scaffolded: a fresh agent has no project context, and
    // an existing repo already owns its AGENTS.md (kept untouched, read as ② context from the workbench).
    { rel: join(root, "persona.md"), content: personaTemplate(nested) },
    // The example skill: how to author skills well — the core of self-iteration. Markdown, so it
    // ships in --minimal too. Vendored verbatim from mattpocock/skills (MIT); LICENSE sits beside it.
    skill("SKILL.md"),
    skill("GLOSSARY.md"),
    skill("LICENSE"),
    { rel: join(root, "fastagent.config.mjs"), content: baseTemplate("fastagent.config.mjs") },
    { rel: join(root, ".gitignore"), content: baseTemplate("gitignore") },
    // `.secrets/`: real values (.env, auth.json) live here, never committed; the template and the
    // protection itself are un-ignored so both travel with the workspace (see templates).
    { rel: join(root, ".secrets", ".env.example"), content: baseTemplate("env.example") },
    { rel: join(root, ".secrets", ".gitignore"), content: baseTemplate("secrets.gitignore") },
  ];
  if (!minimal) {
    files.push(
      { rel: join(root, "tools", "fetch-url.ts"), content: baseTemplate("tools/fetch-url.ts") },
      // The workspace's own manifest. The name says WHOSE agent it is (this directory's), not which
      // subdirectory it happens to live in — a nested workspace is named after its host dir.
      {
        rel: join(root, "package.json"),
        content: packageJson(nested ? `${toPackageName(dir)}-agent` : toPackageName(dir), await fastagentVersion()),
      },
    );
  }

  // `fastagent` is the RESERVED nested-workspace name: resolveWorkspace reads any directory with that
  // basename as a nested root, so a --flat workspace landing there would resolve with workbench = the
  // PARENT — the agent's cwd, its ② context, and (worse) deploy's build context would all silently
  // climb one level out. Refuse with the reason instead of scaffolding the trap.
  if (!nested && basename(dir) === WORKSPACE_DIR) {
    throw new Error(
      `"${dir}": "${WORKSPACE_DIR}" is the reserved name of a nested workspace — --flat here would resolve ` +
        `with the PARENT directory as the workbench (the agent's cwd and deploy's build context). Rename the ` +
        `directory, or drop --flat to nest a workspace inside it.`,
    );
  }

  // Guard on the ownership marker: a config at EITHER root means "already a fastagent workspace" —
  // fail visibly rather than double-initialize or create the ambiguous both-roots shape.
  // (AGENTS.md is NOT a marker — it is context, adopted untouched.)
  const conflicts: string[] = [];
  for (const name of WORKSPACE_CONFIG_NAMES) {
    if (await exists(join(dir, name))) conflicts.push(name);
    if (await exists(join(dir, WORKSPACE_DIR, name))) conflicts.push(join(WORKSPACE_DIR, name));
  }
  if (conflicts.length > 0) {
    throw new Error(`"${dir}" already has ${conflicts.join(", ")} — already a fastagent workspace`);
  }

  // Never merge into an existing NON-EMPTY `fastagent/` — with no config inside it is either an
  // unfinished workspace or something unrelated; landing persona.md beside it would be a silent mix.
  // Refuse with the way out. A SYMLINKED `fastagent` slips past this readdir (it follows links) —
  // deliberate: the parent preflight below lstat-rejects it before any write.
  if (nested) {
    const occupants = (await readdir(join(dir, root)).catch(() => [] as string[])).filter((f) => f !== ".DS_Store");
    if (occupants.length > 0) {
      throw new Error(
        `"${join(basename(dir), WORKSPACE_DIR)}" already exists and is not empty — move it away first, ` +
          `or use --flat to scaffold the workspace directly into a directory of your choice`,
      );
    }
  }

  // Was the target non-empty BEFORE we wrote anything? (missing dir = empty).
  const intoNonEmpty = (await readdir(dir).catch(() => [] as string[])).length > 0;

  // Preflight scaffold parent dirs: a pre-existing non-directory there would make mkdir fail mid-loop
  // AFTER the first write, leaving a half-scaffold. Detect it before any write (lstat, not stat: a
  // symlinked parent must be rejected, not followed — it would write outside the workspace).
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

  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  const patched: string[] = [];
  const warnings: string[] = [];
  // ONE rollback scope: any failure removes files written THIS run (guard + wx guarantee they are
  // ours), so scaffoldWorkspace is atomic — except the .gitignore APPEND below, which is not rolled
  // back (the residue is idempotent, harmless ignore lines; removing someone else's file's tail is riskier).
  try {
    for (const file of files) {
      const abs = join(dir, file.rel);
      await mkdir(dirname(abs), { recursive: true });
      try {
        await writeFile(abs, file.content, { flag: "wx" }); // wx: never clobber
        created.push(file.rel);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") skipped.push(file.rel);
        else throw error;
      }
    }

    // A KEPT workspace-root .gitignore (flat init into an adapted dir) may lack the dependency
    // exclude — patch only what a complete agent actually needs (node_modules/). Machinery dirs need
    // no root entries: `.secrets/` and `.state/` carry their own self-ignoring .gitignore (the ONE
    // mechanism — see definition.ts), which git's nested-ignore precedence makes authoritative.
    const rootAbs = join(dir, root);
    const rootGitignoreRel = join(root, ".gitignore");
    if (!minimal && skipped.includes(rootGitignoreRel)) {
      const ig = await loadRootIgnore(rootAbs);
      if (!(ig?.ignores("node_modules") || ig?.ignores("node_modules/"))) {
        await appendFile(join(dir, rootGitignoreRel), `\n# fastagent\nnode_modules/\n`);
        patched.push(rootGitignoreRel);
      }
    }
    // A kept package.json won't carry the tool's deps — the example tool would not resolve. The install
    // command matches the workspace's runtime (bun.lock → bun add).
    const keptPkg = join(root, "package.json");
    if (!minimal && skipped.includes(keptPkg)) {
      const add = detectRuntime(rootAbs, await readPackageJson(rootAbs)).runtime === "bun" ? "bun add" : "npm install";
      warnings.push(
        `kept the existing ${keptPkg} — run \`${add} @fastagent-sh/fastagent\` there so the example tool resolves`,
      );
    }
  } catch (error) {
    // Best-effort rollback of a partial scaffold: a file that won't delete is left behind (the original
    // error below is the one worth surfacing — a cleanup failure must not mask it).
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    throw error;
  }
  return { dir, complete: !minimal, root, created, skipped, patched, intoNonEmpty, warnings };
}
