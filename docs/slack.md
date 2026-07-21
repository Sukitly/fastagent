---
title: Slack channel
description: "Serve an agent as a Slack app with signed Events API ingress, durable threads/context, file IO, and edited live previews."
status: current
---

# Slack channel

The first-party Slack channel uses Slack's [HTTP Events API](https://docs.slack.dev/apis/events-api/using-http-request-urls/) at `POST /slack`. It verifies Slack's [raw-body request signature](https://docs.slack.dev/authentication/verifying-requests-from-slack/), persists accepted work before ACK, serializes turns per session, and delivers the answer by
updating one live-preview message.

## Add the channel

```bash
fastagent add slack
```

Choose one group behavior:

| Mode | Group behavior | Additional access |
|---|---|---|
| `context` (recommended) | Explicit mentions, bare replies in Agent-owned threads, and recent unsummoned discussion | Channel/private-channel/MPIM history events and scopes |
| `mentions` | Explicit `app_mention` only; no bare continuation or background context | Least privilege |

The command creates:

```txt
channels/slack.ts       # signed Events API adapter + policy
tools/slack-send.ts     # text and external-upload file tool
```

It also adds `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` placeholders to `.env.example` and, by
default, starts single-workspace internal-app onboarding.

## Internal-app onboarding

Slack's [App Manifest API](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) requires a user/workspace **App Configuration Token**. The command opens
[Your Apps](https://api.slack.com/apps); generate one under **Your App Configuration Tokens**, then paste
its access and refresh tokens into the hidden prompts. These configuration credentials can manage apps
owned by your user in that workspace, so FastAgent:

- stores them only in owner-readable (`0600`) `<state root>/channels/slack/onboarding.json`;
- never puts it in `.env`, an image, a deploy secret, argv, or logs;
- uses it locally to rotate the 12-hour access token and update the App Manifest.

Slack labels configuration-token rotation / Manifest management as a control-plane API surface that may
change. FastAgent treats every failure as visible and keeps `--no-onboard` plus the manual console path as
the fallback; it never silently claims that an unverified Request URL was installed.

The command then:

1. starts a temporary Cloudflare Quick Tunnel (`cloudflared` is required);
2. creates the internal app from a mode-specific manifest;
3. configures the Bot, writable App Home Messages tab, scopes, and Events API subscriptions;
4. opens [Slack OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/), validates its `state`, exchanges the code, and installs into one workspace;
5. writes only `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` to the gitignored run-root `.env`.

App creation is an irreversible persisted boundary. If OAuth is cancelled or the process stops afterward,
re-run `fastagent add slack`; it resumes the same App rather than creating another. Once installed, run:

```bash
fastagent dev --tunnel
```

The temporary onboarding URL is replaced automatically with the live `<quick-tunnel>/slack` Request URL.
Each later Quick Tunnel receives the same update. `deploy fly --run`, `deploy railway --run`, and Docker
`--run --tunnel` likewise update the deployed URL from the local machine without sending the configuration
token to the host. Invite the App to each channel it should read.

This is an internal, single-workspace installation—not Marketplace/multi-workspace OAuth token storage.

### Manual/scaffold-only setup

Use `fastagent add slack --no-onboard` to create only the channel/tool files. In that mode, create the App
in Slack yourself and configure these base Bot Token Scopes:

```txt
app_mentions:read
chat:write
im:history
files:read
files:write
```

Context mode additionally needs `channels:history`, `groups:history`, and `mpim:history`. Subscribe
`app_mention` and `message.im`; context mode additionally subscribes `message.channels`, `message.groups`,
and `message.mpim`. Set `https://<host>/slack` under Event Subscriptions while FastAgent is running,
then put the Bot Token and Signing Secret in `.env`. Without local onboarding state, tunnel/deploy commands
print this manual Request URL instead of claiming registration succeeded.

## Scaffolded channel

```ts
import { slackChannel } from "@fastagent-sh/fastagent/slack";

export default slackChannel({
  botToken: process.env.SLACK_BOT_TOKEN ?? "",
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  groupBehavior: "context", // or "mentions"
  // Direct and group asks default to independent sessions + Slack threads; opt out independently:
  // directMessageSession: "continuous",
  // groupMessageSession: "continuous",
  onError: (failed) => `⚠️ ${failed.details}`, // development transparency
});
```

Required credentials are validated when serving activates the module, so deployment inspection remains
import-safe while a live endpoint never runs without verification.

## Routing and sessions

The default route answers:

- every human `message.im` DM;
- human `app_mention` events in channels;
- in context + threaded group mode, unmentioned human replies whose `thread_ts` belongs to a durably
  owned Agent thread.

Bot messages, edits, deletes, hidden events, and service subtypes are ignored. `file_share` and
`thread_broadcast` are new human content and remain eligible. Overlapping `app_mention` and `message.*`
deliveries are deduplicated by logical message identity `(team, channel, ts)`, not only `event_id`.

Default sessions:

| Message | Session |
|---|---|
| Top-level DM (`threaded`, default) | `slack:<team>:<channel>:<ts>` |
| DM thread continuation | `slack:<team>:<channel>:<root_ts>` |
| Top-level DM with `directMessageSession: "continuous"` | `slack:<team>:<channel>` |
| Group mention / managed continuation (`threaded`, default) | `slack:<team>:<channel>:<root_ts>` |
| Top-level group mention with `groupMessageSession: "continuous"` | `slack:<team>:<channel>` |
| Existing group thread in continuous mode | `slack:<team>:<channel>:<root_ts>` |

DMs default to the same root model: a top-level message receives its answer in `thread_ts = incoming.ts`,
and later thread replies reuse that root session. `directMessageSession: "continuous"` instead keeps
ordinary top-level DM replies linear. Threaded groups use
`thread_ts = incoming.thread_ts ?? incoming.ts`; a top-level summon therefore creates a Slack thread and
persists that root before ACK. Continuous groups keep top-level turns in one channel session and answer
at channel top level, while explicit summons inside an existing Slack thread preserve that root session
and reply there. Different roots can run concurrently; turns within one root are FIFO.

Override `route(envelope)` for custom policy. It returns `null` to ignore or a `SlackRoute` with optional
`session`, `channelId`, `threadTs`, and `text`. `threadTs: null` explicitly sends at channel top level.
Supplying a custom route disables the default owned-thread and unsummoned-context admission policy; the
custom route is then the complete authority.

## Group context

In context mode, only a top-level summon in threaded group mode creates a durable owned root. Mentioning
the Agent inside an existing human thread answers that turn but does not adopt later bare replies. This
matches Feishu/Lark's managed-thread boundary. Unsummoned human discussion is bucketed by workspace +
channel + concrete thread root.
The next answered turn in that place receives a bounded sender-prefixed block. Consumption is durable:

1. persist each background message before webhook ACK;
2. snapshot with `peek` when the turn dequeues;
3. commit exactly that snapshot only when the Agent emits `completed`;
4. retain it on failure/crash, and retain messages that arrive while the turn is running.

This mode deliberately lets the app read messages in channels where it is installed. Use `mentions` when
that permission or retention boundary is inappropriate. State is local to the deployment and self-ignored
from git, but operators still own retention/privacy policy.

## Inbound files

Events persist stable Slack file IDs—never temporary private URLs. At dequeue, the channel calls
`files.info`, then:

- downloads images as vision `prompt.images`;
- writes ordinary files under `<state root>/channels/slack/files/<channel>/` and adds their absolute paths to the prompt;
- sends the Bot token on private-file downloads;
- accepts only HTTPS Slack-owned download/redirect hosts;
- enforces a streaming 20 MB cap and a download timeout;
- sanitizes names and prefixes them with the Slack file ID.

A current-message file is primary input: an inaccessible, deleted, external-without-bytes, not-yet-ready,
oversized, or Slack Connect-denied file produces a visible failed turn instead of silently running without
it. Earlier buffered files degrade individually; readable siblings still load and the prompt counts missing
ones.

The selected model must support vision for image inputs. Canvas and other remote/external file modes are
usable only when Slack exposes authenticated downloadable bytes.

## Replies and `slack-send`

The channel posts `💭 Thinking…`, updates the same message no faster than every three seconds, and settles
it into the final Slack mrkdwn answer. Long answers are split under Slack's practical message cap. Preview
updates are best-effort; the terminal write is authoritative and failures remain in operator logs.

The scaffolded `slack-send` tool supports text or one local file. File mode uses Slack's current [external
upload protocol](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/):

```txt
files.getUploadURLExternal
→ upload bytes to upload_url
→ files.completeUploadExternal
```

`channel_id` and the parent `thread_ts` are supplied to the completion call. Upload delivery is
at-least-once: if Slack commits completion but the network response is lost, an explicit retry may post a
duplicate. The tool does not hide that uncertainty with an automatic final-step retry.

## Durability and state

Slack state lives under:

```txt
<state root>/channels/slack/
├── turns.json
├── seen.json
├── owned-threads.json
├── buffers.json
└── files/
```

An accepted turn is persisted before the 200 ACK and replayed after an interrupted process. Replay is
at-least-once: side-effecting Agent tools must be idempotent or tolerate duplication. The execution ceiling
drops a turn that repeatedly starts without finishing and notifies the thread instead of crash-looping
forever. File-backed channel state supports one process/replica only.

## Production

`fastagent deploy docker|fly|railway` discovers Slack, carries both required secret names, and prints the
stable `/slack` Request URL. `--run` deploys the app but still reports Slack registration as the required
manual console step. Mount `FASTAGENT_STATE_DIR` on durable storage and keep one replica.

## Current boundaries

- HTTP Events API only; Socket Mode is not included.
- One Slack workspace installation/token per channel instance; no OAuth installation store or Marketplace multi-tenancy.
- Edited/deleted messages do not mutate Agent history or buffered context.
- Native `chat.startStream`/task UI is not used; compatibility comes from `chat.postMessage` + `chat.update`.
