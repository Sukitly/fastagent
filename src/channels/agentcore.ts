/**
 * AWS AgentCore Runtime adapter: serve fastagent's whole HTTP surface through the Runtime's service
 * contract. AgentCore gives a container exactly TWO paths — `POST /invocations` (the only ingress,
 * reached via the SigV4 `InvokeAgentRuntime` API) and `GET /ping` (health) — and no public URL, so
 * the deployment fronts webhooks with a thin forwarder Lambda and delivers cron slots from
 * EventBridge Scheduler; both arrive here as an ENVELOPE in the /invocations payload:
 *
 *  - `{ kind: "webhook", method, path, headers?, bodyB64? }` — a verbatim webhook request captured
 *    by the forwarder. Reconstructed into a real `Request` and dispatched to the SAME channel routes
 *    a direct deployment serves — signature verification (Telegram secret token, Feishu signatures)
 *    runs unchanged inside the channel. The channel's HTTP response travels back INSIDE the
 *    transport reply (`{ status, headers, bodyB64 }`, transport always 200): AgentCore folds a
 *    container non-2xx into its own 424 RuntimeClientError, so riding the real status inside the
 *    envelope is the only way the forwarder can re-emit it verbatim (a Feishu URL-verification
 *    challenge needs the exact body + content-type back).
 *  - `{ kind: "schedule-fire", name, slot }` — one cron instant from the external clock. Dispatched
 *    to {@link fireScheduleOnce}-shaped `fire` with the slot as the idempotency key (EventBridge
 *    delivery is at-least-once; a duplicate slot must not double-fire).
 *  - `{ kind: "invoke", session, text }` — the programmatic data plane; streams the invoke back as
 *    SSE (AgentCore's streaming response form), reusing the HTTP channel's handler wholesale.
 *
 * `/ping` reports `HealthyBusy` while process-wide background work is in flight (busy.ts) — webhook
 * channels ACK fast and run turns fire-and-forget, and AgentCore ends an idle session, so without
 * this signal a long turn would be killed mid-flight right after its ACK. `Healthy` when idle lets
 * the platform reclaim the microVM (that idle-to-zero IS the point of this deployment).
 */
import { Buffer } from "node:buffer";
import type { Agent } from "../agent.ts";
import type { Routes } from "../host/node.ts";
import { router } from "../host/node.ts";
import { log } from "../log.ts";
import { rememberWakeAlarmUrl } from "../schedule/wake-alarm.ts";
import type { ScheduleFireOutcome } from "../schedule/scheduler.ts";
import { readBodyCapped } from "./body.ts";
import { createInvokeHandler } from "./http.ts";
import { text } from "./respond.ts";

/** Envelope cap: the largest channel webhook body (1 MiB, e.g. telegram's MAX_UPDATE_BYTES) after
 *  base64 expansion (×4/3) plus envelope overhead — 2 MiB covers it with headroom. */
export const MAX_ENVELOPE_BYTES = 2 << 20;

/** What the forwarder Lambda / EventBridge deliver in the `/invocations` payload. Every kind may
 *  carry `wake` — the forwarder's self-resolved public URL, which the adapter persists so the wake
 *  ALARM sink (schedule/wake-alarm.ts) can call back without the URL being baked anywhere. */
export type AgentcoreEnvelope = { wake?: { url: string } } & (
  | {
      kind: "webhook";
      /** Original webhook request line, verbatim. `path` must be absolute ("/telegram"). */
      method: string;
      path: string;
      /** Original headers — signature material (secret tokens, Feishu signatures) rides here. */
      headers?: Record<string, string>;
      /** Original body, base64 (webhook bodies are JSON but the tunnel must be byte-exact). */
      bodyB64?: string;
    }
  | {
      kind: "schedule-fire";
      name: string;
      /** The cron instant this fire is FOR (ISO) — the slot-idempotency key. */
      slot: string;
    }
  | { kind: "invoke"; session: string; text: string }
  /** An EventBridge wake-up poke: the invocation ITSELF is the payload — it wakes the container,
   *  whose boot drain / 30s wake pump then fires whatever is due. The handler only acks. */
  | { kind: "wake-poke" }
);

/** The webhook envelope's reply: the channel's real HTTP response, ridden inside a transport-200
 *  body so the forwarder can re-emit it verbatim (see the module header on AgentCore's 424 folding). */
export interface WebhookReply {
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}

export interface AgentcoreAdapterOptions {
  /** The serving routes a direct deployment would mount (channels or the builtin invoke + health). */
  routes: Routes;
  agent: Agent;
  /** Where the forwarder URL from envelopes is persisted for the wake-alarm sink (the state root). */
  stateRoot: string;
  /** Process-wide background-work signal (busy.ts `activeWork() > 0`) — injected for tests. */
  isBusy: () => boolean;
  /** Slot-idempotent schedule fire ({@link fireScheduleOnce} bound to this workspace's schedules);
   *  undefined when the workspace has none — a schedule-fire envelope then 404s (deploy drift: an
   *  external clock still firing for a schedule this definition no longer has). */
  fire?: (name: string, slot: Date) => Promise<ScheduleFireOutcome>;
}

const jsonHeaders = { "content-type": "application/json" } as const;
const json = (body: unknown, status: number): Response =>
  new Response(`${JSON.stringify(body)}\n`, { status, headers: jsonHeaders });

/**
 * Build the AgentCore serving surface: `{ "POST /invocations", "GET /ping" }`. The caller merges it
 * over its routes (collision-checked at the mount site, serve.ts) — the inner routes stay mounted
 * too, which is harmless (AgentCore routes only /invocations and /ping into the container) and keeps
 * a local `curl` debug surface.
 */
export function agentcoreRoutes(options: AgentcoreAdapterOptions): Routes {
  const { routes, agent, stateRoot, isBusy, fire } = options;
  const dispatch = router(routes);
  const invokeHandler = createInvokeHandler(agent);

  const invocations = async (req: Request): Promise<Response> => {
    const body = await readBodyCapped(req, MAX_ENVELOPE_BYTES);
    if ("tooLarge" in body) return text("envelope too large\n", 413);
    let envelope: AgentcoreEnvelope;
    try {
      envelope = JSON.parse(body.text) as AgentcoreEnvelope;
    } catch {
      return text("invalid json\n", 400);
    }
    if (envelope === null || typeof envelope !== "object" || typeof envelope.kind !== "string") {
      return text('need { "kind": "webhook" | "schedule-fire" | "invoke" | "wake-poke", ... }\n', 400);
    }
    // The forwarder rides its public URL along on every envelope — persist it (write-if-changed) so
    // the wake-alarm sink can call back. Total: a bad persist must not fail the turn.
    if (typeof envelope.wake?.url === "string") {
      try {
        rememberWakeAlarmUrl(stateRoot, envelope.wake.url);
      } catch (e) {
        log.error(`[agentcore] could not persist the wake-alarm URL: ${String(e)}`);
      }
    }

    switch (envelope.kind) {
      case "webhook": {
        const { method, path, headers, bodyB64 } = envelope;
        if (typeof method !== "string" || typeof path !== "string" || !path.startsWith("/")) {
          return text('webhook envelope needs { "method": string, "path": "/..." }\n', 400);
        }
        const inner = new Request(`http://agentcore.local${path}`, {
          method,
          headers: headers ?? {},
          body:
            typeof bodyB64 === "string" && method !== "GET" && method !== "HEAD"
              ? Buffer.from(bodyB64, "base64")
              : undefined,
        });
        const response = await dispatch(inner);
        // Buffer the channel's ACK (webhook ACKs are small by design — the turn itself runs
        // fire-and-forget) and ride it inside the transport reply, byte-exact.
        const replyBody = Buffer.from(await response.arrayBuffer());
        const replyHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          replyHeaders[key] = value;
        });
        const reply: WebhookReply = {
          status: response.status,
          headers: replyHeaders,
          bodyB64: replyBody.toString("base64"),
        };
        return json(reply, 200);
      }
      case "schedule-fire": {
        const { name, slot } = envelope;
        if (typeof name !== "string" || typeof slot !== "string" || Number.isNaN(Date.parse(slot))) {
          return text('schedule-fire envelope needs { "name": string, "slot": ISO-date }\n', 400);
        }
        // No fire capability (no schedules in this definition) or an unknown name is deploy drift —
        // an external clock rule outliving the schedule it fired for. 404 keeps it VISIBLE in the
        // clock's logs (a 200 would silently absorb every future fire).
        if (!fire) return text(`no schedules in this deployment (schedule-fire "${name}")\n`, 404);
        try {
          const outcome = await fire(name, new Date(slot));
          return json(outcome, 200);
        } catch (e) {
          if (e instanceof UnknownScheduleError) return text(`${e.message}\n`, 404);
          // A claim-state fault (unreadable/unwritable fires.json) — surface it as the request's
          // failure so the external clock's logs carry it (fail visibly, never a silent absorb).
          log.error(`[agentcore] schedule-fire ${name} failed: ${String(e)}`);
          return text(`schedule-fire failed: ${String(e)}\n`, 500);
        }
      }
      case "wake-poke": {
        // The poke's job is DONE by arriving: the invocation woke (or kept awake) the container, and
        // the wake pump (boot drain + 30s poll) fires whatever is due. Nothing to dispatch.
        return json({ ok: true }, 200);
      }
      case "invoke": {
        // Reuse the HTTP channel's handler wholesale (SSE, cancellation, backpressure) by handing it
        // the shape it already validates — one protocol, one implementation.
        const inner = new Request("http://agentcore.local/invoke", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ session: envelope.session, text: envelope.text }),
        });
        return invokeHandler(inner);
      }
      default:
        return text(`unknown envelope kind "${(envelope as { kind: string }).kind}"\n`, 400);
    }
  };

  return {
    "POST /invocations": invocations,
    // The Runtime ping contract: Healthy = reclaimable, HealthyBusy = keep the session alive
    // (background turns in flight). No time_of_last_update — the platform tracks status changes
    // itself, and a timestamp advancing every ping would defeat the idle timeout (their docs warn).
    "GET /ping": () => json({ status: isBusy() ? "HealthyBusy" : "Healthy" }, 200),
  };
}

/** Thrown by the mount-site `fire` binding when the envelope names a schedule this workspace does
 *  not have — the adapter maps it to 404 (deploy drift stays visible in the external clock's logs). */
export class UnknownScheduleError extends Error {
  constructor(name: string) {
    super(`unknown schedule "${name}"`);
    this.name = "UnknownScheduleError";
  }
}
