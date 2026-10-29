/**
 * 工具注册表(第 3 点):agent.ts 只 import 这里,不接触具体工具实现。
 *
 * 收录:
 * - view_image / screenshot:图片以 image part 注入视觉输入。
 * - 桌面操作三件套:screenshot(看)→ click/type(动)→ screenshot(验证)。
 * - send_user 是 IO 出口,经 io.ts 落盘。
 * 基础设施在 lib/(define.ts 定义助手、xdo.ts xdotool 封装)。
 */
import { bash } from "./bash.ts";
import { viewImage } from "./view-image.ts";
import { screenshot } from "./screenshot.ts";
import { mouse } from "./mouse.ts";
import { keyboard } from "./keyboard.ts";
import { sendUser } from "./send-user.ts";

export const tools = [bash, viewImage, screenshot, mouse, keyboard, sendUser];
