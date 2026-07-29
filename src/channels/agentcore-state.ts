/**
 * Cross-deploy durability for the state root on AgentCore.
 *
 * WHY THIS EXISTS: AgentCore's managed SessionStorage — the `/mnt/state` mount — is reset on every
 * runtime VERSION UPDATE, i.e. on EVERY deploy ("On runtime version update: Data wiped — fresh file
 * system on next invoke", AWS file-system configuration docs), and again after 14 idle days. The
 * mount is therefore a fast LOCAL disk, not the source of truth. Without this module a deploy
 * silently resurrects the agent with no sessions, no channel dedup, no pending wake-ups — and the
 * wake ALARM, which lives in the operator's EventBridge and survives independently, still fires into
 * that empty store: a miss with no error anywhere (exactly the silent-failure class the repo's
 * fail-visibly rule exists to prevent).
 *
 * The durable copy is ONE S3 object reached through PRESIGNED URLS minted per-envelope by the
 * forwarder Lambda. The container holds no AWS credentials (the platform injects none — verified on
 * a live deployment) and stays AWS-SDK-free: a snapshot is one `fetch` GET and one `fetch` PUT.
 *
 * Format: gzip(JSON `{ v, files: { relPath: base64 } }`). Deliberately NOT tar — the state root is a
 * handful of small JSON/JSONL files, and a single self-describing object makes restore ATOMIC: a
 * half-applied state root is far worse than a slightly stale one.
 */
import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { log } from "../log.ts";

/** Snapshot envelope version — an unknown version fails the restore loudly (never a silent skip). */
export const SNAPSHOT_VERSION = 1;

/** Refuse to pack beyond this (before gzip): a runaway state root would OOM the microVM silently. */
export const MAX_SNAPSHOT_BYTES = 64 << 20;

/** Warn past this — the operator should know the snapshot is getting expensive to round-trip. */
const WARN_SNAPSHOT_BYTES = 16 << 20;

/**
 * Restored ABSENT-ONLY: the deploy materializes `auth.json` from FASTAGENT_AUTH_SEED (captured on
 * the builder machine at deploy time, so it is at least as fresh as the snapshot's) before the first
 * invocation. Overwriting it with an older snapshot copy could hand back a rotated-away OAuth
 * refresh token. Everything else — sessions, channel state, wake-ups — must come back verbatim.
 */
const PREFER_LOCAL = new Set(["auth.json"]);

interface StateSnapshot {
  v: number;
  files: Record<string, string>;
}

/** Presigned S3 URLs for the one snapshot object, minted per envelope by the forwarder. */
export interface StateUrls {
  getUrl: string;
  putUrl: string;
}

/** Every regular file under `root`, as root-relative POSIX paths (stable across platforms). */
async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // Symlinks/sockets/FIFOs are skipped on purpose: the state root holds plain files, and
    // AgentCore's session storage does not support special files anyway.
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** Pack the whole state root into one gzipped snapshot object. */
export async function packStateRoot(stateRoot: string): Promise<Buffer> {
  const files: Record<string, string> = {};
  let raw = 0;
  for (const rel of await walk(stateRoot)) {
    const content = await readFile(join(stateRoot, rel));
    raw += content.byteLength;
    if (raw > MAX_SNAPSHOT_BYTES) {
      throw new Error(
        `state root exceeds ${MAX_SNAPSHOT_BYTES} bytes — it cannot be snapshotted for cross-deploy durability`,
      );
    }
    files[rel] = content.toString("base64");
  }
  if (raw > WARN_SNAPSHOT_BYTES) {
    log.warn(`[agentcore] state snapshot is large (${Math.round(raw / (1 << 20))} MiB) — every turn round-trips it`);
  }
  return gzipSync(Buffer.from(JSON.stringify({ v: SNAPSHOT_VERSION, files } satisfies StateSnapshot)));
}

/** Apply a snapshot over the state root. Returns how many files were written. */
export async function unpackIntoStateRoot(stateRoot: string, packed: Buffer): Promise<number> {
  let snapshot: StateSnapshot;
  try {
    snapshot = JSON.parse(gunzipSync(packed).toString()) as StateSnapshot;
  } catch (e) {
    throw new Error(`state snapshot is unreadable (${String(e)})`);
  }
  if (snapshot?.v !== SNAPSHOT_VERSION || typeof snapshot.files !== "object" || snapshot.files === null) {
    throw new Error(`state snapshot has an unsupported shape (v=${String(snapshot?.v)})`);
  }
  let written = 0;
  for (const [rel, b64] of Object.entries(snapshot.files)) {
    // A snapshot is written by this same code, but it arrives over the network: refuse anything
    // that could escape the state root.
    if (rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error(`state snapshot contains an unsafe path (${rel})`);
    }
    const target = join(stateRoot, rel);
    if (PREFER_LOCAL.has(rel) && (await exists(target))) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(b64, "base64"));
    written += 1;
  }
  return written;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface StateSyncOptions {
  stateRoot: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The per-process snapshot lifecycle: restore ONCE before anything reads the state root, then push a
 * coalesced snapshot whenever work settles.
 */
export interface StateSync {
  /** Remember the newest presigned URLs (each envelope carries a fresh pair). */
  use(urls: StateUrls): void;
  /** Resolve once the state root is authoritative. REJECTS if a snapshot exists but cannot be
   *  restored — the caller must fail the request rather than serve from an empty state root (and a
   *  failed restore also blocks {@link StateSync.save}, so bad state is never written back).
   *  Resolves immediately while no URLs are known: a direct programmatic invoke runs in its OWN
   *  isolated session/storage and must neither read nor overwrite the ingress snapshot. */
  ready(): Promise<void>;
  /** Whether snapshotting is active (URLs seen). Lets the caller flag a forwarder envelope that
   *  arrived WITHOUT them — a topology fault that would otherwise lose state silently. */
  configured(): boolean;
  /** Request a snapshot upload; coalesces while one is in flight. Errors are logged, not thrown —
   *  the next settle retries, and the local mount still holds the data until the version changes. */
  save(): void;
  /** Await the in-flight (and any queued) upload — the shutdown/test seam. */
  flush(): Promise<void>;
}

export function createStateSync(options: StateSyncOptions): StateSync {
  const { stateRoot } = options;
  const doFetch = options.fetchImpl ?? fetch;
  let urls: StateUrls | undefined;
  let restore: Promise<void> | undefined;
  let restored = false;
  let saving: Promise<void> | undefined;
  let queued = false;

  const runRestore = async (urls: StateUrls): Promise<void> => {
    const res = await doFetch(urls.getUrl, { method: "GET" });
    if (res.status === 404 || res.status === 403) {
      // 403 is what S3 returns for a missing key when the caller may not ListBucket — the forwarder's
      // role is object-scoped, so "absent" arrives either way. A genuinely broken signature also
      // lands here; the deploy just created the pair, so treating it as first boot is the safe read.
      log.info("[agentcore] no state snapshot yet — starting from an empty state root (first deploy)");
      restored = true;
      return;
    }
    if (!res.ok) throw new Error(`state snapshot GET failed: ${res.status}`);
    const written = await unpackIntoStateRoot(stateRoot, Buffer.from(await res.arrayBuffer()));
    log.info(`[agentcore] restored ${written} state file(s) from the snapshot`);
    restored = true;
  };

  const runSave = async (): Promise<void> => {
    do {
      queued = false;
      if (!restored || !urls) return;
      const body = await packStateRoot(stateRoot);
      const res = await doFetch(urls.putUrl, { method: "PUT", body: new Uint8Array(body) });
      if (!res.ok) throw new Error(`state snapshot PUT failed: ${res.status}`);
    } while (queued);
  };

  return {
    use(next) {
      urls = next;
    },
    configured() {
      return urls !== undefined;
    },
    ready() {
      // No URLs = not an ingress envelope (a direct invoke has its own isolated storage): nothing to
      // restore, and deliberately NOT cached, so the first envelope that does carry them still runs
      // the restore.
      if (!urls) return Promise.resolve();
      // One attempt per process otherwise: a rejected restore stays rejected so every subsequent
      // envelope fails the same visible way instead of quietly serving an empty agent.
      restore ??= runRestore(urls);
      return restore;
    },
    save() {
      if (!restored) return; // never overwrite a good snapshot with a state root we failed to fill
      if (saving) {
        queued = true;
        return;
      }
      saving = runSave()
        .catch((e) => {
          log.error(`[agentcore] could not save the state snapshot: ${String(e)} — retrying when work next settles`);
        })
        .finally(() => {
          saving = undefined;
        });
    },
    async flush() {
      while (saving) await saving;
    },
  };
}
