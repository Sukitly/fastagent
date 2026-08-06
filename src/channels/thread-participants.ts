/**
 * SHARED: who the agent has HEARD in a group thread — the sole input to the participant model's summon
 * rule. **The derivation lives in docs/design/participant-model.md §3** (why the rule is defined over
 * observation rather than the thread's true membership, what the weaker claim costs in both
 * directions, and why recording is never gated on configuration). Repeating it here would mean two
 * copies to keep true; what follows is only what a caller of this module must not get wrong.
 *
 * - **The key MUST be the string the session uses.** A record here is a claim about that session's
 *   memory, so the two cannot be keyed independently — including the channel brand
 *   (`feishu:<chat>:<thread>`, `slack:<team>:<channel>:<thread_ts>`). This file is already per-channel
 *   and would not need the prefix, but SESSION ids share one namespace across every channel in a
 *   deployment, so dropping it would key participation to a session that is not the one that answered.
 * - **Write both halves under one condition**, and gate that condition on STRUCTURAL facts only (is
 *   this a group? a thread? a human speaking?) — never on configuration, which changes while records
 *   outlive the change. The own-authorship source of participation (a thread rooted on the agent's
 *   message) shares the same gate: it is only ever merged for a group-thread message a human sent.
 * - **Observations only accumulate.** Nothing here sheds: no platform signals that someone stopped
 *   taking part, and the error directions are not symmetric — over-counting humans makes the agent ask
 *   to be named, under-counting makes it speak into a crowd.
 * - Keyed by `thread_id`, never a reply-chain root: Feishu's `root_id` moves with the chain, so it
 *   cannot identify a side conversation at all.
 */
import { log } from "../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** Cap on remembered threads. Losing one costs a mention to re-enter that thread, so an unbounded file
 *  buys little — and a merge that carries new information rewrites the whole map synchronously, so the
 *  map's size is the cost of every such write. What keeps that bounded is that only NEW information
 *  writes at all (a repeat speaker, or any message once MAX_HUMANS is reached, returns before
 *  persisting), and that the map stays small enough for state.ts's premise to hold — these writes land
 *  synchronously on the acceptance path, so the whole file is the cost of each one. A thousand records
 *  is tens of KB, and the records that matter (threads the agent takes part in) are far fewer than
 *  that; the dominant traffic is bystanders, which is what the eviction policy below is aimed at.
 *
 *  Eviction prefers BYSTANDER threads — ones the agent has only listened to. They are written on the
 *  same path and vastly outnumber the rest (every thread in every visible channel), yet losing one
 *  costs nothing: the summon rule refuses a thread the agent has not spoken in anyway, so the record
 *  would have to be rebuilt by the mention that admits it. Evicting purely by age would let this
 *  traffic push out the threads the agent is actively serving, silently reverting them to
 *  mention-only. This is also what makes it safe to record threads no rule currently reads (those
 *  behind a custom route, or under a posture whose summon rule is off — see the header). */
const MAX_THREADS = 1000;

/** Cap on remembered humans per thread. The rule only asks "have I heard a second one?", so two is
 *  already the whole answer and anything beyond it is weight nothing reads. */
const MAX_HUMANS = 2;

interface ThreadParticipation {
  /** Distinct humans heard in this thread (capped, see {@link MAX_HUMANS}). */
  humans: string[];
  /** Whether the agent TAKES PART here — what makes it a participant rather than a bystander. Two
   *  ways it becomes true: the agent answered a turn in this thread, or the thread grew from a
   *  message the agent itself wrote (a channel that records its own sends can know this — see
   *  feishu's sent ring). "Answered here" alone is NOT the definition: the second source is
   *  established before any turn ever ran in the thread. */
  agentParticipates: boolean;
}

export interface ThreadParticipants {
  /**
   * The participant model's summon rule (docs/design/participant-model.md §3): does a bare message in
   * this thread address the agent? True where it takes part AND no second human has been heard. Lives
   * here rather than in each channel because it is one rule over one store — `<= 1` is an easy edge to
   * get wrong twice, and "a second human restores the mention requirement" must have one place to change.
   */
  admitsBareMessage(key: string): boolean;
  /**
   * Merge in what was just heard (or said — participation includes the agent's own authorship).
   * Idempotent; a failed write is a warning, never a failed delivery.
   *
   * The parameter only admits values the store can honour: observations accumulate, so
   * `agentParticipates` can be set but never cleared and `humans` unions. Passing `false` would
   * compile and do nothing, so the type refuses it — "never shed" is an invariant, not a convention.
   */
  merge(key: string, heard: { humans?: string[]; agentParticipates?: true }): void;
}

/** The on-disk shape, including the legacy key: records written before the participation rename
 *  carry `agentSpoke` — read as the same fact (answering was then the only source), migrated to the
 *  new key on the next full-map write. Read-compat is permanent; it costs one nullish coalesce. */
interface StoredParticipation {
  humans: string[];
  agentParticipates?: boolean;
  agentSpoke?: boolean;
}

function isStoredParticipation(value: unknown): value is StoredParticipation {
  const record = value as StoredParticipation;
  if (!Array.isArray(record?.humans) || !record.humans.every((human) => typeof human === "string")) return false;
  // Each key is validated on its OWN, then at least one must be present. A single "either is a boolean"
  // test would accept a record whose new key holds a non-boolean as long as the legacy key is valid —
  // and the loader's `??` chain would then carry that value into memory and rewrite it to disk on the
  // next full-map write, laundering corrupt input into the migrated shape.
  const present = (key: "agentParticipates" | "agentSpoke"): boolean | undefined =>
    record[key] === undefined ? undefined : typeof record[key] === "boolean";
  const newKey = present("agentParticipates");
  const legacyKey = present("agentSpoke");
  if (newKey === false || legacyKey === false) return false;
  return newKey === true || legacyKey === true;
}

export function createThreadParticipants(path: string, label: string): ThreadParticipants {
  const raw = loadStateFile(path);
  const records = new Map<string, ThreadParticipation>();
  if (raw !== undefined) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.values(raw).every(isStoredParticipation)
    ) {
      for (const [key, record] of Object.entries(raw as Record<string, StoredParticipation>)) {
        records.set(key, {
          humans: record.humans,
          agentParticipates: record.agentParticipates ?? record.agentSpoke ?? false,
        });
      }
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no thread participation`);
    }
  }

  return {
    admitsBareMessage(key) {
      const heard = records.get(key);
      return heard?.agentParticipates === true && heard.humans.length <= 1;
    },
    merge(key, heard) {
      const previous = records.get(key);
      const humans = new Set(previous?.humans ?? []);
      for (const human of heard.humans ?? []) {
        if (humans.size >= MAX_HUMANS) break;
        humans.add(human);
      }
      const next: ThreadParticipation = {
        humans: [...humans],
        agentParticipates: (previous?.agentParticipates ?? false) || (heard.agentParticipates ?? false),
      };
      // `humans` starts from `previous` and only grows, so equal size IS set equality here.
      const unchanged =
        previous !== undefined &&
        previous.agentParticipates === next.agentParticipates &&
        previous.humans.length === next.humans.length;
      // Re-insert so insertion order is "least recently TOUCHED first" — including when nothing
      // changed. A thread in its steady state (the agent answers, the same person keeps talking) stops
      // carrying new information and would otherwise never refresh its position again, leaving the
      // thread being served right now at the head of the eviction order.
      //
      // PROCESS-LOCAL: a touch alone never writes, and such a thread has nothing left to write (it has
      // reached MAX_HUMANS), so the refreshed order survives only until restart. That is the right
      // trade for a cache — persisting recency would mean a whole-map write per message — and the
      // consequence is bounded: after a restart, eviction order among participant threads is the order
      // they last carried new information.
      records.delete(key);
      records.set(key, next);
      if (unchanged) return;
      while (records.size > MAX_THREADS) {
        // Oldest bystander first; only when every record is a thread the agent takes part in does age
        // alone decide. NEVER the key just merged: it is the most recently touched record, so evicting
        // it contradicts the recency policy re-established above — and worse, a channel that records a
        // thread's humans and its own participation in two steps would then write the second half onto
        // an empty record, producing "answered here, heard nobody" and a permanent bare-message admit.
        let evict: string | undefined;
        for (const [candidate, record] of records) {
          if (candidate === key) continue;
          if (!record.agentParticipates) {
            evict = candidate;
            break;
          }
          evict ??= candidate;
        }
        if (evict === undefined) break;
        records.delete(evict);
      }
      try {
        saveStateFile(path, Object.fromEntries(records));
      } catch (error) {
        // Cache only: memory stays correct for this process, and the whole map is rewritten on the
        // next successful merge — so a failed write costs durability only until then, and a thread
        // whose record is lost simply needs a mention to re-enter.
        log.warn(`${label} could not persist thread participation ${path}: ${String(error)}`);
      }
    },
  };
}
