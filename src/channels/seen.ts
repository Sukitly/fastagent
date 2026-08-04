/** Best-effort bounded durable ID rings, recorded only after the caller's pre-ACK side effect is durable. */
import { log } from "../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

export interface IdRing {
  has(id: string): boolean;
  add(id: string): void;
}

export type SeenRing = IdRing;

/**
 * The NEUTRAL ring: same data shape for every use, but responsibility is per use — a write failure's
 * diagnostic must name what actually degrades (`degradedNote`), or the operator debugs the wrong
 * subsystem, and the cap is a retention decision each use owns rather than inherits.
 */
export function createIdRing(path: string, label: string, opts: { cap: number; degradedNote: string }): IdRing {
  const { cap, degradedNote } = opts;
  const raw = loadStateFile(path);
  const order =
    raw === undefined
      ? []
      : Array.isArray(raw) && raw.every((id) => typeof id === "string")
        ? raw.slice(-cap)
        : undefined;
  if (order === undefined) log.warn(`${label} unexpected shape in ${path} — starting with no recorded ids`);
  const values = order ?? [];
  const ids = new Set(values);
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      values.push(id);
      while (values.length > cap) {
        const evicted = values.shift();
        if (evicted !== undefined) ids.delete(evicted);
      }
      try {
        saveStateFile(path, values);
      } catch (error) {
        log.warn(`${label} id-ring write failed (${degradedNote}): ${String(error)}`);
      }
    },
  };
}

/** The inbound DELIVERY-DEDUP ring (platforms re-push; `has` keeps a re-push idempotent). */
export function createSeenRing(path: string, label: string, cap = 2000): SeenRing {
  return createIdRing(path, label, { cap, degradedNote: "delivery dedup is in-memory until restart" });
}
