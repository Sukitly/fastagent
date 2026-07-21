import type { RegistrationOutcome } from "../registration.ts";
import { waitForHealth } from "../wait-health.ts";
import { updateSlackAppManifest } from "./config-api.ts";
import { buildSlackManifest } from "./manifest.ts";
import { currentSlackConfigToken, readSlackOnboardingState } from "./onboarding-state.ts";

export interface RegisterSlackWebhookOptions {
  stateRoot: string;
  log?: (message: string) => void;
  healthTimeoutMs?: number;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

/** Update one onboarded internal Slack app without sending its configuration credential to the host. */
export async function registerSlackWebhook(
  baseUrl: string,
  options: RegisterSlackWebhookOptions,
): Promise<RegistrationOutcome> {
  const note = options.log ?? ((message: string) => console.error(message));
  let state: Awaited<ReturnType<typeof readSlackOnboardingState>>;
  try {
    state = await readSlackOnboardingState(options.stateRoot);
  } catch (error) {
    note(`[fastagent] slack: cannot read local onboarding state: ${String(error)}`);
    return "failed";
  }
  if (!state?.appId || !state.installedAt) {
    note(
      `[fastagent] slack: no completed local onboarding state — set Event Subscriptions → Request URL = ${baseUrl}/slack manually, or re-run \`fastagent add slack\` interactively`,
    );
    return "manual";
  }
  const healthy = await waitForHealth(`${baseUrl}/health`, options.healthTimeoutMs ?? 45_000, 500);
  if (!healthy) {
    note(`[fastagent] slack: ${baseUrl}/health did not become reachable; Request URL was not changed`);
    return "failed";
  }
  try {
    const current = await currentSlackConfigToken(options.stateRoot, state, {
      apiBaseUrl: options.apiBaseUrl,
      fetch: options.fetch,
    });
    await updateSlackAppManifest(
      current.token,
      current.state.appId as string,
      buildSlackManifest({
        name: current.state.appName,
        groupBehavior: current.state.groupBehavior,
        requestUrl: `${baseUrl}/slack`,
      }),
      { apiBaseUrl: options.apiBaseUrl, fetch: options.fetch },
    );
    note(`[fastagent] slack: Event Subscriptions Request URL registered → ${baseUrl}/slack`);
    return "registered";
  } catch (error) {
    note(
      `[fastagent] slack: automatic Request URL registration failed: ${String(error)} — ` +
        `re-run \`fastagent add slack\` to repair onboarding, or set ${baseUrl}/slack in the Slack console`,
    );
    return "failed";
  }
}
