/**
 * mouse:桌面鼠标事件(xdotool,DISPLAY 锁死)。
 */
import { Type } from "typebox";
import { tool } from "../lib/define.ts";
import { xdo } from "../lib/xdo.ts";

export const mouse = tool({
  name: "click",
  label: "Click",
  description:
    "在虚拟桌面上移动鼠标并点击,坐标为像素(先 screenshot 看图定位)。" +
    "无窗口管理器时,点击也可让多数程序获得焦点;键盘输入仍建议配合 type 的 window 参数",
  parameters: Type.Object({
    x: Type.Number({ description: "x 坐标(像素)" }),
    y: Type.Number({ description: "y 坐标(像素)" }),
    button: Type.Optional(Type.Number({ description: "1 左键 / 2 中键 / 3 右键,默认 1" })),
  }),
  execute: async (_toolCallId, params) => {
    const button = String(params.button ?? 1);
    const out = await xdo(["mousemove", String(params.x), String(params.y), "click", button]);
    return {
      content: [{ type: "text", text: out || `已点击 (${params.x},${params.y}) 键${button}` }],
      details: {},
    };
  },
});
