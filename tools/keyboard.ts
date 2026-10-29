/**
 * keyboard:桌面键盘事件(xdotool type/key + 按标题聚焦窗口)。
 */
import { Type } from "typebox";
import { tool } from "../lib/define.ts";
import { xdo } from "../lib/xdo.ts";

export const keyboard = tool({
  name: "type",
  label: "Type",
  description:
    "模拟键盘输入。text 输入一串文本(ASCII);keys 发送组合键,如 Return、ctrl+c、space。" +
    "无窗口管理器时点击不会移动键盘焦点,可用 window 按窗口标题先聚焦再输入",
  parameters: Type.Object({
    text: Type.Optional(Type.String({ description: "要键入的文本" })),
    keys: Type.Optional(Type.String({ description: '组合键,空格分隔,如 "ctrl+a Return"' })),
    window: Type.Optional(Type.String({ description: "窗口标题子串,输入前先聚焦到它,如 Calculator" })),
  }),
  execute: async (_toolCallId, params) => {
    let note = "";
    if (params.window) {
      try {
        await xdo(["search", "--name", params.window, "windowfocus", "--sync"]);
      } catch (err) {
        note = `(聚焦 "${params.window}" 失败: ${err instanceof Error ? err.message : err}) `;
      }
    }
    const out = params.text
      ? await xdo(["type", "--clearmodifiers", params.text])
      : await xdo(["key", ...(params.keys ?? "").split(/\s+/).filter(Boolean)]);
    return { content: [{ type: "text", text: note + (out || "已输入") }], details: {} };
  },
});
