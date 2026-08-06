import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeishuEventHeader, FeishuMessageEvent } from "../src/channels/feishu/model.ts";
import { decodeFeishuContent, normalizeFeishuMessage } from "../src/channels/feishu/normalize.ts";

interface MessageFixture {
  schema: string;
  header: FeishuEventHeader;
  event: FeishuMessageEvent;
}

function fixture(kind: "feishu" | "lark"): MessageFixture {
  const url = new URL(`./fixtures/${kind}/message.receive_v1.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as MessageFixture;
}

describe("Feishu/Lark normalized webhook model", () => {
  it("normalizes the conversation place and decoded content the turn wiring consumes", () => {
    const raw = fixture("feishu");
    const message = normalizeFeishuMessage(raw.event);

    expect(raw.schema).toBe("2.0");
    expect(message).toEqual({
      conversation: {
        chatId: "oc_feishu_chat",
        threadId: "omt_feishu_topic",
      },
      content: {
        text: "@FastAgent review this",
        hasMentions: true,
        resources: [],
      },
    });
  });

  it("normalizes the same Lark wire model and scopes every resource to its carrying message", () => {
    const raw = fixture("lark");
    const message = normalizeFeishuMessage(raw.event);

    expect(raw.header.event_type).toBe("im.message.receive_v1");
    expect(message?.conversation).toEqual({
      chatId: "oc_lark_chat",
      threadId: undefined,
    });
    expect(message?.content.text).toContain("Project update");
    expect(message?.content.text).toContain("the spec (https://example.test/spec)");
    expect(message?.content.hasMentions).toBe(false);
    expect(message?.content.resources).toEqual([
      { kind: "image", key: "img_lark_1", messageId: "om_lark_message_1" },
      { kind: "video", key: "file_lark_1", name: "demo.mp4", messageId: "om_lark_message_1" },
    ]);
  });

  it("rejects an event without a message identity at the normalization boundary", () => {
    expect(normalizeFeishuMessage({ sender: { sender_type: "user" } })).toBeNull();
  });
});

describe("card (interactive) decoding — the shape the agent's OWN answers come back as", () => {
  // What a query API hands back for a card: `title` + `elements` paragraphs of the same tagged nodes
  // as `post`. NOT what we sent (an entity reference holding only a card_id) — the platform renders it
  // down on the way out, which is why this needs no cardkit read.
  const card = {
    title: "需要先确认两项",
    elements: [
      [{ tag: "text", text: "确认后我会给出文件级方案；批准后再实现 SVG 足球页面。" }],
      [
        { tag: "a", href: "https://example.test/pr/1", text: "PR" },
        { tag: "img", image_key: "img_card_1" },
      ],
      [{ tag: "note", elements: [{ tag: "text", text: "备注" }] }],
    ],
  };

  it("reads a card's text instead of the bare type marker", () => {
    const decoded = decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) });

    expect(decoded.text).toContain("需要先确认两项"); // the title
    expect(decoded.text).toContain("SVG 足球页面"); // the ask, restated inside the agent's own answer
    expect(decoded.text).toContain("PR (https://example.test/pr/1)");
    expect(decoded.text).toContain("备注"); // `note` nests its own elements
    expect(decoded.text).not.toBe("[interactive message]");
  });

  it("collects NO resources from a card — the platform cannot serve them, so a key here would only fail", () => {
    // `im/v1/messages/:id/resources/:key` answers 234043 ("Unsupported message type") for a card
    // message id: a documented limitation, not a permission gap, so the download can never succeed.
    // A collected key becomes a PRIMARY turn input, and primary loads are fail-fast — so collecting
    // would turn a card that merely read as a marker into a turn that ERRORS OUT. Strictly worse than
    // the gap this branch closes.
    const decoded = decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) });

    expect(decoded.resources).toEqual([]);
    expect(decoded.text).toContain("[image]"); // the model still learns the image is there
  });

  it("still collects resources from a POST — the restriction is the card's, not the walker's", () => {
    // The same node walker backs both branches, so pinning this here keeps a future "just don't
    // collect" simplification from silently disarming rich-text attachments, which DO download.
    const post = {
      content: [[{ tag: "img", image_key: "img_post_1" }]],
    };
    expect(decodeFeishuContent({ message_type: "post", content: JSON.stringify(post) }).resources).toEqual([
      { kind: "image", key: "img_post_1" },
    ]);
  });

  it("accepts BOTH spellings — the platform's docs disagree with themselves (`interactive` vs `card`)", () => {
    // The field table says `interactive` (the receive event's spelling); the message-object example
    // says `"msg_type": "card"`. Matching one would leave the other on the default branch with exactly
    // the symptom this fixes, so the failure would look identical to no fix at all.
    const asCard = decodeFeishuContent({ message_type: "card", content: JSON.stringify(card) });
    expect(asCard.text).toContain("SVG 足球页面");
  });

  it("keeps the marker when a card renders to nothing — empty would read as a blank message", () => {
    const controlsOnly = { elements: [[{ tag: "button", type: "primary" }]] };
    expect(decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(controlsOnly) }).text).toBe(
      "[interactive message]",
    );
  });

  it("reads a widget's visible label, since a card is read for what it SAYS", () => {
    const labelled = {
      elements: [
        [
          { tag: "button", text: "批准" },
          { tag: "select_static", placeholder: "选一个" },
        ],
      ],
    };
    const decoded = decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(labelled) });
    expect(decoded.text).toContain("批准");
    expect(decoded.text).toContain("选一个");
  });
});
