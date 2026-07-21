/** Feishu/Lark app-level event subscription choice used by onboarding and scaffolding. */
export type FeishuSubscriptionMode = "webhook" | "websocket";

/** Onboarding choice for group visibility. `context` needs the tenant-wide group-message scope; the
 * runtime remains capability-driven because the platform, not channel source, decides which events
 * are delivered. */
export type FeishuGroupBehavior = "context" | "mentions";

/** A resolved group-behavior decision plus whether the author actually chose it (flag or prompt).
 * A defaulted "context" (non-interactive, no flag) must never drive the sensitive-scope write. */
export interface GroupBehaviorChoice {
  behavior: FeishuGroupBehavior;
  explicit: boolean;
}

/** The sensitive tenant scope behind both managed-thread bare replies and group context buffering. */
export const FEISHU_GROUP_CONTEXT_SCOPE = "im:message.group_msg";
