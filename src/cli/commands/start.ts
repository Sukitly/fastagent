/**
 * `fastagent start [dir]`: run the agent in production posture — the SAME assembly as dev (your
 * directory is the agent), just no file-watching. No build step: start reads the definition directly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { authSeedBytes, collectAuthSeed } from "../../deploy/fly/run.ts";
import { loadDotEnv } from "../../env.ts";
import { resolveAuthPath, resolveSessionsDirOverride } from "../../engines/pi/config.ts";
import { isUnderDir } from "../../engines/pi/definition.ts";
import { reportDefinitionWarnings, reportModuleLoadFailures, reportToolCollisions } from "../../engines/pi/report.ts";
import { createPiAgentFromWorkspace } from "../../engines/pi/workspace.ts";
import { log, setLogLevel } from "../../log.ts";
import { createWakeAlarmSink, reconcileWakeAlarms } from "../../schedule/wake-alarm.ts";
import { setWakeupsSink } from "../../schedule/wakeups.ts";
import { logAgentLoop } from "../../observe.ts";
import { installProxyFetch } from "../../proxy.ts";
import { exists } from "../../scaffold/init.ts";
import { failStartup } from "../fail.ts";
import { maybeTunnel, mountAgentcore, mountSessionControl, routesFor, serve, startSchedules } from "../serve.ts";
import { parsePort, reportAuth, resolveFirstRunModel } from "../shared.ts";

export interface StartOptions {
  port?: string;
  model?: string;
  sessionsDir?: string;
  authPath?: string;
  tunnel?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const dir = resolve(dirArg);
  setLogLevel("info"); // production posture: info+, the debug turn trace (and its end-user content) gated out
  const portFlag = parsePort(opts.port, "--port", "flag");
  loadDotEnv(dir);
  installProxyFetch();
  await resolveFirstRunModel(dir, opts);

  // A `deploy --run` may carry the operator's local credential as FASTAGENT_AUTH_SEED —
  // materialize it onto the writable state root BEFORE the opener resolves auth (once, absent-only).
  // Same resolveAuthPath the opener uses — ONE owner of the flag > env > default chain.
  await maybeSeedAuth(resolveAuthPath(dir, opts.authPath));

  // The same opener dev uses (single assembly source), just no watch.
  const sessionsDirOverride = resolveSessionsDirOverride(opts.sessionsDir);
  const {
    agent,
    definition,
    agentDir,
    config,
    modelSpec,
    stateRoot,
    sessionsDir,
    authPath,
    toolNames,
    deferredToolNames,
    toolCollisions,
    toolFailures,
    sessionControl,
  } = await createPiAgentFromWorkspace(dir, {
    model: opts.model,
    sessionsDir: sessionsDirOverride,
    authPath: opts.authPath,
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);

  log.info(`[fastagent] start:  ${dir}`);
  if (agentDir !== dir) log.info(`[fastagent] agent:  ${agentDir}`);
  log.info(`[fastagent] model:  ${modelSpec}${config.thinkingLevel ? ` (thinking: ${config.thinkingLevel})` : ""}`);
  await reportAuth(modelSpec, authPath);
  log.info(`[fastagent] context: ${definition.contextFiles.map((f) => f.path).join(", ") || "(none)"}`);
  if (definition.persona) log.info(`[fastagent] persona: persona.md`);
  log.info(`[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (toolNames.length > 0) log.info(`[fastagent] tools:  ${toolNames.join(", ")}`);
  if (deferredToolNames.length > 0) {
    log.info(`[fastagent] deferred: ${deferredToolNames.join(", ")} (activated via search_tools)`);
  }
  reportToolCollisions(toolCollisions);
  reportModuleLoadFailures(toolFailures);
  log.info(`[fastagent] state:  ${stateRoot}`);
  log.info(`[fastagent] sessions: ${sessionsDir}`);
  // State defaults under the definition dir, which a redeploy may replace wholesale. Gate on where the
  // root ACTUALLY resolved (in-tree?), not on the raw env var: an empty `FASTAGENT_STATE_DIR=""` reads
  // as unset (resolveStateRoot) and still lands in-tree, so a raw `=== undefined` check would wrongly
  // silence the warning. A sessions/auth override to a volume does not help — channel state (the
  // telegram turn/context files replay depends on) is still in-tree.
  if (isUnderDir(stateRoot, dir)) {
    log.info(
      `[fastagent] note: state (auth, sessions, channel state) lives under the definition dir; point ` +
        `FASTAGENT_STATE_DIR at a persistent volume so a redeploy that replaces the dir does not wipe it.`,
    );
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);

  // Same debug turn trace as dev; gated out here by the info level (see dev.ts serveOnce).
  const traced = logAgentLoop(agent);
  const routed = await routesFor(agentDir, traced, stateRoot, sessionControl).catch(failStartup);
  const withControl = mountSessionControl(routed.routes, sessionControl, stateRoot, {
    tunnel: opts.tunnel ?? false,
    agent: traced,
  });
  // AgentCore Runtime posture (FASTAGENT_AGENTCORE=1, set by the generated deploy artifacts): the
  // adapter (POST /invocations + GET /ping) is the container's only reachable surface, and cron
  // slots arrive from the external clock through it — so no resident cron timers.
  const agentcore = process.env.FASTAGENT_AGENTCORE === "1";
  // AgentCore + selfSchedule: register the wake-ALARM sink BEFORE the scheduler starts — the boot
  // wake pump may advance a recurring entry (a store save) and that save must already re-arm its
  // alarm. The secret arrives via the stack (FASTAGENT_WAKE_SECRET); without it the deployment
  // degrades to awake-only wakes — warned, never silent.
  if (agentcore && config.selfSchedule) {
    const wakeSecret = process.env.FASTAGENT_WAKE_SECRET;
    if (wakeSecret) {
      const sink = createWakeAlarmSink({ secret: wakeSecret });
      setWakeupsSink(sink);
      reconcileWakeAlarms(stateRoot, sink); // pending wakes may have lost their alarms across a redeploy
      log.info(`[fastagent] wake alarms: EventBridge-backed via the forwarder`);
    } else {
      log.warn(
        `[fastagent] FASTAGENT_WAKE_SECRET is not set — wake-ups fire only while a session is awake ` +
          `(redeploy with the current template to fix)`,
      );
    }
  }
  const schedules = await startSchedules(agentDir, traced, stateRoot, config.selfSchedule ?? false, {
    externalClock: agentcore,
  });
  let routes = withControl.routes;
  if (agentcore) {
    try {
      routes = mountAgentcore(routes, { agent: traced, stateRoot, schedules });
    } catch (e) {
      failStartup(e);
    }
    log.info(`[fastagent] agentcore: serving POST /invocations + GET /ping (FASTAGENT_AGENTCORE=1)`);
  }
  serve(
    { ...routed, routes },
    portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? config.http?.port ?? 8787,
    (p) => {
      withControl.announce(p);
      maybeTunnel(dir, routed.routeChannels, p, opts.tunnel ?? false, stateRoot);
    },
  );
  // No graceful drain: webhook turns run fire-and-forget; SIGTERM just exits mid-turn. Whether an
  // in-flight turn is LOST depends on the channel: the Telegram channel persists turn intent pre-ACK
  // and replays it next start (turn-store.ts, L1 durable execution, at-least-once); HTTP and other
  // channels have no such layer, so their in-flight turns are still lost (the asker re-invokes).
}

/**
 * Materialize `FASTAGENT_AUTH_SEED` (base64 of an auth.json, set by `deploy --run`) onto the
 * writable state root ONCE — only when the seed is set AND the auth file is absent, so a refreshed
 * volume copy is never clobbered by the stale seed. Lets a deploy carry the operator's local
 * OAuth/API credential so the box runs on the SAME subscription. No-op locally (the seed is unset).
 */
async function maybeSeedAuth(authPath: string): Promise<void> {
  // collectAuthSeed: the seed may arrive CHUNKED (FASTAGENT_AUTH_SEED + _2…) on hosts with a small
  // env-value max length (AgentCore); single-var hosts are unchanged.
  const bytes = authSeedBytes(collectAuthSeed(process.env), await exists(authPath));
  if (!bytes) return;
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, bytes);
  log.info(`[fastagent] seeded ${authPath} from FASTAGENT_AUTH_SEED (first boot)`);
}
