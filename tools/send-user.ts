/**
 * send_user:立即给用户发一条消息(写 outbox.jsonl)。
 */
import { Type } from "typebox";
import { appendJsonl, PATHS } from "../io.ts";
import { tool } from "../lib/define.ts";

export const sendUser = tool({
  name: "send_user",
  label: "Send User",
  description: "给用户发一条消息(写 outbox)",
  parameters: Type.Object({
    text: Type.String({ description: "要发给用户的消息内容" }),
  }),
  execute: async (_toolCallId, params) => {
    await appendJsonl(PATHS.outbox, { ts: Date.now(), text: params.text, via: "send_user" });
    return { content: [{ type: "text", text: "已发送" }], details: {} };
  },
});
