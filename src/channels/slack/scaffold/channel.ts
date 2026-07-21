import { slackChannel } from "@fastagent-sh/fastagent/slack";

// Slack HTTP Events API channel. Setup:
//   1. Create a Slack app at https://api.slack.com/apps and add a bot user.
//   2. Bot Token Scopes: app_mentions:read, chat:write, im:history, files:read, files:write.
//      Context-aware groups additionally need channels:history, groups:history, mpim:history.
//   3. Event Subscriptions: app_mention + message.im. Context-aware groups additionally subscribe
//      message.channels, message.groups, and message.mpim. Set Request URL to https://<host>/slack.
//   4. Install/reinstall the app to the workspace after changing scopes.
export default slackChannel({
  botToken: process.env.SLACK_BOT_TOKEN ?? "", // Bot User OAuth Token (xoxb-…)
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "", // Basic Information → App Credentials
  groupBehavior: "context", // "context" (recommended) or "mentions" (least privilege)
  // Direct and group asks default to independent sessions + Slack threads; opt out independently:
  // directMessageSession: "continuous",
  // groupMessageSession: "continuous",
  // Dev/personal bot: surface raw errors. Remove this for a customer-facing bot; details remain in logs.
  onError: (failed) => `⚠️ ${failed.details}`,
});
