/**
 * view_image:把磁盘上的图片直接注入模型的视觉输入(image content part)。
 * 本文件导出的 imageContent() 是共享注入原语,screenshot 也复用它。
 */
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { tool } from "../lib/define.ts";
import { envInt } from "../env.ts";

const MAX_MB = envInt("AGENT_IMAGE_MAX_MB", 1);
const MAX_BYTES = MAX_MB * 1024 * 1024;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 共享原语:二进制图片 → pi-ai ImageContent(base64) */
export function imageContent(data: Buffer, mimeType: string) {
  return { type: "image" as const, data: data.toString("base64"), mimeType };
}

export const viewImage = tool({
  name: "view_image",
  label: "View Image",
  description:
    `读取磁盘上的图片并注入你的视觉输入(png/jpg/jpeg/webp/gif,≤${MAX_MB}MB)。` +
    "看任何图片(bash 下载/生成的、截图存档)都用它,不要试图用 bash cat 图片",
  parameters: Type.Object({
    path: Type.String({ description: "图片文件路径" }),
  }),
  execute: async (_toolCallId, params) => {
    const buf = await readFile(params.path);
    if (buf.length > MAX_BYTES) throw new Error(`图片超过 ${MAX_MB}MB`);
    const ext = params.path.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME[ext];
    if (!mime) throw new Error(`不支持的图片格式: .${ext}`);
    return {
      content: [imageContent(buf, mime), { type: "text" as const, text: `已注入图片 ${params.path} (${(buf.length / 1024).toFixed(1)}KB)` }],
      details: {},
    };
  },
});
