/**
 * Run one turn (the IO half of canonical Feishu→Agent translation): assemble its inputs — resolve the reply
 * referent (a summon that replies to an earlier message names it only by `parent_id`; the content is
 * NOT in the event, so it is fetched here) and the attachments (vision images inline, files to disk) —
 * and stream `agent.invoke` with the assembled prompt. Split from parse.ts (which is pure) because this
 * half touches the Open API + disk; split from feishu.ts so the factory keeps only wiring and the
 * per-turn lifecycle.
 *
 * Inputs have two tiers. PRIMARY is the summoning message plus the message it explicitly replied to;
 * any load failure there aborts visibly so the Agent never runs without an input the user pointed at.
 * BUFFERED resources come from earlier un-summoned thread/group discussion and degrade per attachment:
 * one expired background file must not block the current ask or hide its still-readable siblings.
 */
import type { Agent, AgentEvent, ImageRef } from "../../agent.ts";
import { log } from "../../log.ts";
import {
  type BusyRetry,
  DEFAULT_BUSY_RETRY,
  attachedFilesManifest,
  attributedFileName,
  backgroundImagesManifest,
  missingAttachmentsNote,
  streamTurnWithBusyRetry,
} from "../invoke-turn-kit.ts";
import type { FeishuBufferedRef } from "./context-buffer.ts";
import type { DownloadedFile, FeishuApi } from "./feishu-api.ts";
import { type FeishuMention, parseContent } from "./parse.ts";
import { REFERENT_MAX_CODE_POINTS, truncateCodePointPrefix } from "../text.ts";

/** The per-turn REPLY CONTRACT, appended to the prompt (not the system prompt). Two halves, one
 *  concept — what happens to the reply: its FORMAT (rendered in a card whose markdown element is the
 *  natural fit for LLM output — steer away from HTML/plain) and its DELIVERY OWNERSHIP (the channel
 *  itself delivers it; answering through a send TOOL instead is the observed failure — the channel
 *  then settles an empty turn as "(no reply)" next to the tool's un-threaded duplicate). */
const REPLY_INSTRUCTION =
  "\n\n(Format your reply in standard Markdown — it is rendered in a Feishu/Lark card. This reply is " +
  "delivered to the current chat by the channel itself: do not call a send tool to answer the " +
  "current chat.)";

/** Everything the transport needs to fetch a turn's attachments. */
export interface FeishuTurnTransport {
  api: FeishuApi;
  chatId: string;
  filesDir: string;
  label: string;
  /** THIS app's own id (`cli_…`) — the identity a fetched message's `sender.id` carries when the
   *  sender is an app. Needed to tell the agent's OWN messages from any other bot's in the same chat:
   *  `sender_type` alone says "some app", which is not the question the referent path asks. */
  appId: string;
}

/** An attachment reference: the resource key inside its CARRYING message (the resource API addresses
 *  bytes by message_id + key, so the pair travels together through the turn record). */
interface FeishuAttachmentInput {
  msg: string;
  key: string;
  name?: string;
}

/** A turn's primary resources plus background resources folded from the context buffer. */
export interface FeishuTurnAttachments {
  primary: {
    images: FeishuAttachmentInput[];
    files: FeishuAttachmentInput[];
    /** The replied-to message's id, when the summon is a reply. */
    parentId?: string;
  };
  buffered: { files: FeishuBufferedRef[]; images: FeishuBufferedRef[]; skipped: number };
}

/** A turn's inputs, resolved to what agent.invoke consumes: vision images inline, plus a prompt suffix
 *  (the reply-referent block + the downloaded-file manifest) appended after the base text. */
interface ResolvedInputs {
  images: ImageRef[] | undefined;
  promptSuffix: string;
}

/**
 * Resolve a turn's inputs (module header): fetch the reply referent's content, then load every image
 * (vision) and file (disk). Primary failures throw; buffered resources degrade independently.
 */
async function resolveTurnInputs(t: FeishuTurnTransport, attachments: FeishuTurnAttachments): Promise<ResolvedInputs> {
  const images = [...attachments.primary.images];
  const files = [...attachments.primary.files];
  let referentBlock = "";
  if (attachments.primary.parentId !== undefined) {
    const parentId = attachments.primary.parentId;
    // A referent is CONTEXT, not the ask. Losing it (deleted, restricted, unreadable) must not cost
    // the user their answer — every first message of a thread carries one, so a hard failure here
    // would turn an ordinary platform edge into a lost turn. Degrade visibly instead: the operator
    // gets a warning, and the model is told the quote could not be read rather than being left to
    // guess what "about that" refers to.
    // A deleted or invisible message comes back as an EMPTY item list rather than an error, so the
    // warning belongs on the branch that renders the marker — that is the one the operator must see.
    let failure: string | undefined;
    const parent = await t.api.getMessage(parentId).catch((error) => {
      failure = String(error);
      return undefined;
    });
    if (!parent) {
      log.warn(
        `${t.label} could not read replied-to message ${parentId} (${failure ?? "no such message"}) — the model is told the quote is unreadable`,
      );
      // Fall THROUGH: the resources this turn carries are the ask itself. Returning here would drop
      // the images and files the user explicitly attached along with the referent they merely quoted.
      referentBlock = `\n\n[replied-to message (msg ${parentId}) could not be read]`;
    } else {
      const parsed = parseContent({
        message_type: parent.msg_type ?? "unknown",
        content: parent.body?.content ?? "",
        mentions: parent.mentions as FeishuMention[] | undefined,
      });
      // The referent's own resources join the turn as primary inputs, carried by the PARENT message id.
      for (const key of parsed.imageKeys) images.push({ msg: parentId, key });
      for (const ref of parsed.fileRefs) files.push({ msg: parentId, key: ref.key, name: ref.name });
      // getMessage's sender is `{ id, id_type, sender_type }` — a DIFFERENT shape from the event's
      // sender (`{ sender_id: { open_id } }`), so the label is built here, not via parse.senderLabel.
      //
      // OWN means THIS app, not "an app". A group can hold several bots, and `sender_type === "app"`
      // is true for every one of them — matching on it alone would tell the model it wrote another
      // bot's message. The identity to compare is the app id, because an app sender carries
      // `id_type: "app_id"`: the cached bot open_id answers a different question (who was @mentioned)
      // and would never match here. A missing or unexpected id fails CLOSED — labelled by id, never
      // claimed as the agent's own.
      const appSender = parent.sender?.sender_type === "app";
      const senderId = parent.sender?.id;
      const ownMessage = appSender && senderId === t.appId;
      // An app is not a person: labelling another bot's message "user cli_…" is the same misattribution
      // in a quieter form, so the noun follows the sender type.
      const from = ownMessage ? "you, the agent" : senderId ? `${appSender ? "app" : "user"} ${senderId}` : undefined;
      referentBlock = `\n\n[replied-to message (msg ${parentId}${from ? `, from ${from}` : ""}): ${truncateCodePointPrefix(parsed.text, REFERENT_MAX_CODE_POINTS) || "(empty)"}]`;
      // The chain STOPS here, at the one message the user pointed at. Walking further — to what that
      // message was itself replying to — was built and removed: it reconstructs HISTORY out of reply
      // pointers, and history is the session's job. That framing has no non-arbitrary answers (how
      // many levels? what about the level above that? how is it deduplicated against what the session
      // already holds? how does an IMAGE two levels up become prompt text at all?), and every one of
      // those questions is a symptom of solving a session-layer problem in the prompt layer. The real
      // gap it was papering over — a thread opened on a room answer starts with an EMPTY session while
      // the room's session holds the exchange — belongs to memory inheritance (design/participant-
      // model.md §8, rungs 3-4), where images and tool results come along for free because they are
      // already in the history rather than being re-serialised into a prompt string.
    }
  }

  // Primary first and fail-fast: these are resources the current user explicitly pointed at.
  const imageRefs: ImageRef[] = [];
  for (const ref of images) imageRefs.push(await t.api.fetchImage(ref.msg, ref.key));
  const downloaded: DownloadedFile[] = [];
  for (const ref of files)
    downloaded.push(await t.api.fetchFile(ref.msg, ref.key, ref.name ?? ref.key, t.chatId, t.filesDir));

  // A replied-to buffered message is now primary. Filter by message-scoped identity so it is not
  // downloaded twice or rendered twice in the manifest.
  const primaryImages = new Set(images.map((ref) => `${ref.msg}\u0000${ref.key}`));
  const primaryFiles = new Set(files.map((ref) => `${ref.msg}\u0000${ref.key}`));
  const bufferedImages = attachments.buffered.images.filter(
    (ref) => !primaryImages.has(`${ref.messageId}\u0000${ref.key}`),
  );
  const bufferedFiles = attachments.buffered.files.filter(
    (ref) => !primaryFiles.has(`${ref.messageId}\u0000${ref.key}`),
  );
  const backgroundImages: { image: ImageRef; ref: FeishuBufferedRef }[] = [];
  const backgroundFiles: { file: DownloadedFile; ref: FeishuBufferedRef }[] = [];
  let lost = 0;
  const imageResults = await Promise.allSettled(
    bufferedImages.map(async (ref) => ({ ref, image: await t.api.fetchImage(ref.messageId, ref.key) })),
  );
  for (const result of imageResults) {
    if (result.status === "fulfilled") backgroundImages.push(result.value);
    else {
      lost++;
      log.warn(`${t.label} could not load an earlier (buffered) image: ${String(result.reason)}`);
    }
  }
  const fileResults = await Promise.allSettled(
    bufferedFiles.map(async (ref) => ({
      ref,
      file: await t.api.fetchFile(ref.messageId, ref.key, ref.name ?? ref.key, t.chatId, t.filesDir),
    })),
  );
  for (const result of fileResults) {
    if (result.status === "fulfilled") backgroundFiles.push(result.value);
    else {
      lost++;
      log.warn(`${t.label} could not load an earlier (buffered) attachment: ${String(result.reason)}`);
    }
  }
  const missingNote = missingAttachmentsNote(lost + attachments.buffered.skipped);
  const backgroundImageManifest = backgroundImagesManifest(
    imageRefs.length,
    backgroundImages.map(({ ref }) => ref),
  );
  const allFiles = [
    ...downloaded,
    ...backgroundFiles.map(({ file, ref }) => ({
      ...file,
      name: attributedFileName(file.name, ref.from, ref.messageId),
    })),
  ];
  const allImages = [...imageRefs, ...backgroundImages.map(({ image }) => image)];
  return {
    images: allImages.length ? allImages : undefined,
    promptSuffix: `${referentBlock}${missingNote}${backgroundImageManifest}${attachedFilesManifest(allFiles)}`,
  };
}

/**
 * Run one turn: resolve its inputs, then stream agent.invoke with the shared busy-wait
 * (invoke-turn-kit — `onCompleted` is the durable-commit point; see streamTurnWithBusyRetry). A
 * primary-input failure surfaces as a `failed` event (never a silent drop).
 */
export async function* invokeFeishuTurn(
  agent: Agent,
  session: string,
  text: string,
  transport: FeishuTurnTransport,
  attachments: FeishuTurnAttachments,
  onCompleted?: () => void,
  busyRetry: BusyRetry = DEFAULT_BUSY_RETRY,
): AsyncIterable<AgentEvent> {
  let resolved: ResolvedInputs;
  try {
    resolved = await resolveTurnInputs(transport, attachments);
  } catch (e) {
    yield { type: "failed", details: `could not load attachment: ${String(e)}`, retryable: true };
    return;
  }
  const prompt = { text: `${text}${resolved.promptSuffix}${REPLY_INSTRUCTION}`, images: resolved.images };
  yield* streamTurnWithBusyRetry(agent, session, prompt, { label: transport.label, onCompleted, busyRetry });
}
