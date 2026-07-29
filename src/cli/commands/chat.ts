/** `fastagent chat [dir]`: open the SAME assembled agent in pi's interactive TUI. */
import { resolve } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { resolvePlacement } from "../../engines/pi/config.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup, failStartupOn } from "../fail.ts";
import { resolveFirstRunModel } from "../shared.ts";

export async function runChat(dirArg: string, opts: { model?: string; authPath?: string }): Promise<void> {
  const ws = failStartupOn(() => resolvePlacement(resolve(dirArg)));
  loadDotEnv(ws.agentDir);
  installProxyFetch(); // model calls (and the login dialog) must go through the proxy too
  // First-run funnel, FULL picker: chat authenticates through fastagent's credential store like every
  // other command (the shared session builder injects it — see engines/pi/session-builder.ts), so the
  // credential-annotated catalog and inline login apply here too.
  await resolveFirstRunModel(ws.agentDir, { model: opts.model, authPath: opts.authPath });
  // Run the chat process AT the workspace: pi resolves a session's cwd as `header.cwd ?? process.cwd()`,
  // so aligning process.cwd() with the workspace keeps a cwd-less session on it. Paths are absolute.
  process.chdir(ws.workspace);
  // Lazy-import: chat pulls pi's interactive TUI module graph; headless start/dev never need it.
  const { runPiChat } = await import("../../engines/pi/chat.ts");
  await runPiChat(ws.workspace, { model: opts.model, authPath: opts.authPath }).catch(failStartup);
}
