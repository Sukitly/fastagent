/**
 * The serving spine shared by `dev` (its worker) and `start`: channel assembly, Node HTTP binding,
 * long-connection lifecycle, scheduler lifecycle, and the optional Cloudflare quick tunnel.
 */
import type { Agent } from "../agent.ts";
import { INVOKE_EXAMPLE_BODY, createInvokeHandler } from "../channels/http.ts";
import { text } from "../channels/respond.ts";
import { type LoadedLongConnectionChannel, loadChannels } from "../engines/pi/channel.ts";
import { reportModuleLoadFailures } from "../engines/pi/report.ts";
import { type Routes, parseRouteKey, router, serveNode } from "../host/node.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import { loadSchedules } from "../schedule/discover.ts";
import { createScheduler } from "../schedule/scheduler.ts";
import { announceWebhooks, startCloudflareTunnel } from "../tunnel.ts";
import { failStartup } from "./fail.ts";

export interface ServingSurface {
  routes: Routes;
  longConnections: LoadedLongConnectionChannel[];
  /** Route-channel basenames; the tunnel registers only this subset. */
  routeChannels: string[];
  builtinInvoke: boolean;
  /** Marks the built-in health route ready after every long-connection channel first connects. */
  markReady(): void;
}

/**
 * The surface this deployment serves: default `GET /health` plus discovered channels, or the default
 * POST `/invoke` only when neither a route nor a long-connection channel was declared.
 */
export async function routesFor(workspaceDir: string, agent: Agent, stateRoot: string): Promise<ServingSurface> {
  const { routes, longConnections, routeChannels, collisions, failures } = await loadChannels(workspaceDir, {
    agent,
    stateRoot,
  });
  for (const c of collisions) {
    console.error(
      `[fastagent] warn: channel route "${c.route}" (${c.source}) collides with an earlier channel — not mounted`,
    );
  }
  reportModuleLoadFailures(failures);
  if (failures.length > 0 || collisions.length > 0) {
    throw new Error(
      `channel setup is invalid (${failures.length} load failure(s), ${collisions.length} route collision(s)) — ` +
        `fix it, or rename an intentionally disabled file to *.disabled`,
    );
  }
  const builtinInvoke = Object.keys(routes).length === 0 && longConnections.length === 0;
  const channels = builtinInvoke ? { "POST /invoke": createInvokeHandler(agent) } : routes;
  const healthCovered = Object.keys(channels).some((key) => {
    const entry = parseRouteKey(key);
    return entry.path === "/health" && (entry.method === undefined || entry.method === "GET");
  });
  let ready = longConnections.length === 0;
  const health = (): Response => (ready ? text("ok\n", 200) : text("starting\n", 503));
  return {
    routes: healthCovered ? channels : { "GET /health": health, ...channels },
    longConnections,
    routeChannels,
    builtinInvoke,
    markReady() {
      ready = true;
    },
  };
}

/**
 * Bind HTTP, open long-connection channels, and report ready only when both forms are usable. Each
 * adapter owns reconnects; a terminal close rejects `closed` and fails the process visibly. Abort is
 * the sole clean-shutdown command.
 */
export function serve(surface: ServingSurface, port: number, onListening?: (boundPort: number) => void): void {
  const hosted = serveNode(router(surface.routes), { port });
  const abort = new AbortController();
  let stopping = false;

  const stop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    const deadline = setTimeout(() => process.exit(exitCode), 1_000);
    void hosted
      .close()
      .catch(() => {})
      .finally(() => {
        clearTimeout(deadline);
        process.exit(exitCode);
      });
    // Preserve the existing no-drain shutdown contract: stop accepting first, then cut active streams.
    hosted.closeAllConnections();
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));

  hosted.listening.then(
    async (boundPort) => {
      try {
        const runs = surface.longConnections.map((connection) => {
          const run = connection.connect(abort.signal);
          if (
            run === null ||
            typeof run !== "object" ||
            typeof run.ready?.then !== "function" ||
            typeof run.closed?.then !== "function"
          ) {
            throw new Error(`${connection.name} connect(signal) must return { ready: Promise, closed: Promise }`);
          }
          void run.closed.then(
            () => {
              if (!abort.signal.aborted) failStartup(new Error(`${connection.name} closed unexpectedly`));
            },
            (error) => {
              if (!abort.signal.aborted) failStartup(new Error(`${connection.name} failed: ${String(error)}`));
            },
          );
          return { connection, run };
        });
        await Promise.all(
          runs.map(async ({ connection, run }) => {
            await run.ready;
            log.info(`[fastagent] long connection ready: ${connection.name}`);
          }),
        );
        surface.markReady();
        process.send?.({
          type: "ready",
          port: boundPort,
          routeChannels: surface.routeChannels,
        });
        log.info(`[fastagent] http host on :${boundPort}`);
        log.info(`[fastagent] routes: ${Object.keys(surface.routes).join(", ") || "(none)"}`);
        if (surface.longConnections.length > 0) {
          log.info(
            `[fastagent] long connections: ${surface.longConnections.map((connection) => connection.name).join(", ")}`,
          );
        }
        if (surface.builtinInvoke) {
          log.info(
            `[fastagent] try it: curl -s localhost:${boundPort}/invoke -X POST -H 'content-type: application/json' -d '${INVOKE_EXAMPLE_BODY}'`,
          );
        }
        onListening?.(boundPort);
      } catch (error) {
        abort.abort();
        const closing = hosted.close().catch(() => {});
        hosted.closeAllConnections();
        await closing;
        failStartup(error);
      }
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE")
        failStartup(new Error(`port ${port} is already in use; choose another with --port`));
      failStartup(new Error(`cannot bind http channel on :${port}: ${error.message}`));
    },
  );
}

/** Start a Cloudflare tunnel for route channels only. */
export function maybeTunnel(workspaceDir: string, routeChannels: string[], boundPort: number, tunnel: boolean): void {
  if (!tunnel || process.env.FASTAGENT_DEV_WORKER === "1") return;
  void startCloudflareTunnel(boundPort).then((instance) => {
    if (!instance) return;
    void announceWebhooks(workspaceDir, instance.url, { openUrl: openExternalUrl, routeChannels });
    const cleanup = (): void => instance.close();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

/**
 * Load and start the workspace's `schedules/` — a time-trigger firing the agent on each cron. Starts iff
 * there are static schedules OR `selfSchedule` is on. Best-effort stop on process signals.
 */
export async function startSchedules(
  workspaceDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
): Promise<void> {
  const { schedules, failures } = await loadSchedules(workspaceDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  if (schedules.length === 0 && !selfSchedule) return;
  const scheduler = createScheduler({ agent, stateRoot, schedules });
  scheduler.start();
  if (schedules.length > 0) log.info(`[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}`);
  const stop = (): void => scheduler.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
