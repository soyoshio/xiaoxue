/**
 * screenshot:截取虚拟桌面 + 直接注入(image part,复用 view-image 的 imageContent)。
 * 保存路径固定(run/screen.png,每次覆盖写),供 view_image 回看与前端展示。
 *
 * 截图核心是纯 TS 手写 X11 协议,零外部依赖(不装 imagemagick/scrot):
 * 连接 /tmp/.X11-unix/X<display> → 握手(11.0,无鉴权)→ 解析 setup 拿
 * root 窗口/尺寸/深度与 bpp → GetImage(ZPixmap) → 解码像素 → 编码 PNG。
 *
 * 支持的像素格式:
 * - depth 16 / bpp 16:RGB565 小端(Xvfb 默认 16 位屏)
 * - depth 24 / bpp 32:BGRX 字节序(常见 TrueColor)
 *
 * 已知环境:Xvfb :99,1024x768x16,RGB565 masks R=0xf800 G=0x7e0 B=0x1f,
 * scanlinePad=32,root=0x3ff。
 */
import { createConnection, type Socket } from "node:net";
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { PATHS } from "../io.ts";
import { tool } from "../lib/define.ts";
import { DISPLAY } from "../lib/xdo.ts";
import { imageContent } from "./view-image.ts";

// ---------- X11 截图核心 ----------

interface ScreenCapture {
  /** PNG 编码后的截图 */
  png: Buffer;
  /** RGB888 原始像素,width*height*3 */
  rgb: Buffer;
  width: number;
  height: number;
}

function socketPathFor(display: string): string {
  const m = /^(?:([^:]*):)?(\d+)(?:\.\d+)?$/.exec(display.trim());
  if (!m) throw new Error(`无法解析 DISPLAY: "${display}"`);
  const host = m[1] ?? "";
  if (host && host !== "unix" && host !== "localhost") {
    throw new Error(`只支持本地 unix socket 显示(如 :99),不支持 "${display}"`);
  }
  return `/tmp/.X11-unix/X${m[2]}`;
}

/** 从 socket 累积读:按字节数取满为止(处理 Unix socket 流的分片) */
class ByteReader {
  private pending = Buffer.alloc(0);
  private failed: Error | null = null;
  readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk as Buffer]);
    });
    const onEnd = (err?: Error) => {
      this.failed = err ?? new Error("连接中断,数据不足");
    };
    socket.on("close", () => onEnd());
    socket.on("error", (err) => onEnd(err));
  }

  async read(n: number): Promise<Buffer> {
    while (this.pending.length < n) {
      if (this.failed) throw this.failed;
      await new Promise<void>((resolve) => {
        const onData = () => {
          this.socket.off("close", onData);
          this.socket.off("error", onData);
          resolve();
        };
        this.socket.once("data", onData);
        this.socket.once("close", onData);
        this.socket.once("error", onData);
      });
    }
    const out = Buffer.from(this.pending.subarray(0, n));
    this.pending = this.pending.subarray(n);
    return out;
  }
}

// ---------- PNG 编码(RGB888,无隔行) ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // 每行前加 filter byte 0(None)
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- X11 协议 ----------

interface ConnInfo {
  root: number;
  width: number;
  height: number;
  depth: number;
  bpp: number;
  scanlinePadBits: number;
}

async function connect(display: string): Promise<{ socket: Socket; reader: ByteReader }> {
  const path = socketPathFor(display);
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", (err) => reject(new Error(`连接 ${path} 失败: ${err.message}`)));
  });
  socket.on("error", () => {}); // 吞掉后续的 socket 错误
  return { socket, reader: new ByteReader(socket) };
}

/** 握手:小端,协议 11.0,无鉴权;解析 setup 拿 root 信息 */
async function handshake(reader: ByteReader): Promise<ConnInfo> {
  const hello = Buffer.alloc(12);
  hello[0] = 0x6c; // 'l' = 小端
  hello.writeUInt16LE(11, 2);
  hello.writeUInt16LE(0, 4);
  // auth name/data 长度均为 0
  reader.socket.write(hello);

  const header = await reader.read(8);
  const status = header[0];
  if (status !== 1) {
    const reasonLen = header.readUInt16LE(4);
    const reason = reasonLen ? (await reader.read(reasonLen)).toString("utf-8") : "";
    throw new Error(
      status === 2
        ? `X 服务器要求鉴权(未提供 XAUTHORITY): ${reason}`
        : `X 握手失败: ${reason || `status=${status}`}`,
    );
  }
  const extraLen = header.readUInt16LE(6) * 4;
  const setup = await reader.read(extraLen);

  const numFormats = setup[21];
  const scanlinePadBits = setup[24];
  // 32 字节固定头 + vendor(padded) + formats(每个 8 字节) → roots
  const vendorLen = setup.readUInt16LE(16);
  const vendorPadded = Math.ceil(vendorLen / 4) * 4;
  const rootsOff = 32 + vendorPadded + numFormats * 8;

  const root = setup.readUInt32LE(rootsOff);
  const width = setup.readUInt16LE(rootsOff + 20);
  const height = setup.readUInt16LE(rootsOff + 22);
  const depth = setup[rootsOff + 38];

  // 在 pixmap formats 里找该 depth 的 bpp
  let bpp = 0;
  for (let i = 0; i < numFormats; i++) {
    const off = 32 + vendorPadded + i * 8;
    if (setup[off] === depth) {
      bpp = setup[off + 2];
      break;
    }
  }
  if (!bpp) throw new Error(`setup 中找不到 depth=${depth} 的像素格式`);
  return { root, width, height, depth, bpp, scanlinePadBits };
}

/** GetImage(ZPixmap) 整个 root 窗口;跳过中途到达的事件/错误 */
async function getImage(reader: ByteReader, info: ConnInfo): Promise<Buffer> {
  const req = Buffer.alloc(20);
  req[0] = 73; // GetImage
  req[1] = 2; // ZPixmap
  req.writeUInt16LE(5, 2); // 请求长度:20 字节 / 4(X11 请求头此字段是长度,不是序列号)
  req.writeUInt32LE(info.root, 4);
  req.writeInt16LE(0, 8); // x
  req.writeInt16LE(0, 10); // y
  req.writeUInt16LE(info.width, 12);
  req.writeUInt16LE(info.height, 14);
  req.writeUInt32LE(0xffffffff, 16); // plane mask: 全部
  reader.socket.write(req);

  for (;;) {
    const head = await reader.read(32);
    const type = head[0];
    if (type === 1) {
      const dataLen = head.readUInt32LE(4) * 4;
      return await reader.read(dataLen);
    }
    if (type === 0) {
      throw new Error(`GetImage 被拒绝: X error code=${head[1]}`);
    }
    // 其他 = 事件(32 字节已整读),继续等 reply
  }
}

/** ZPixmap 像素 → RGB888;行跨距按 scanlinePad 对齐 */
function decodePixels(data: Buffer, info: ConnInfo): Buffer {
  const { width, height, bpp, scanlinePadBits } = info;
  if (bpp !== 16 && bpp !== 32) throw new Error(`暂只支持 bpp=16/32,当前 depth=${info.depth} bpp=${bpp}`);
  const padBytes = Math.max(1, scanlinePadBits / 8);
  const rowBytes = Math.ceil((width * (bpp / 8)) / padBytes) * padBytes;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number;
      if (bpp === 16) {
        // RGB565 小端
        const v = data.readUInt16LE(rowOff + x * 2);
        r = (((v >> 11) & 0x1f) * 255) / 31;
        g = (((v >> 5) & 0x3f) * 255) / 63;
        b = ((v & 0x1f) * 255) / 31;
      } else {
        // bpp 32:BGRX 字节序(Blue 在低地址)
        const off = rowOff + x * 4;
        b = data[off];
        g = data[off + 1];
        r = data[off + 2];
      }
      const o = (y * width + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  return rgb;
}

/** 截取 display(默认 :99)整屏,返回 PNG + RGB888 */
async function captureScreen(display = ":99"): Promise<ScreenCapture> {
  const { socket, reader } = await connect(display);
  try {
    const info = await handshake(reader);
    const data = await getImage(reader, info);
    const rgb = decodePixels(data, info);
    return { png: encodePng(rgb, info.width, info.height), rgb, width: info.width, height: info.height };
  } finally {
    socket.destroy();
  }
}

// ---------- 工具 ----------

export const screenshot = tool({
  name: "screenshot",
  label: "Screenshot",
  description:
    `截取虚拟桌面(${DISPLAY})当前画面并注入你的视觉输入。` +
    "操作桌面前后都截图:先观察再行动,行动后验证",
  parameters: Type.Object({}),
  execute: async () => {
    const cap = await captureScreen(DISPLAY);
    await writeFile(PATHS.screen, cap.png);
    return {
      content: [
        imageContent(cap.png, "image/png"),
        { type: "text" as const, text: `已截图 (${cap.width}x${cap.height})` },
      ],
      details: {},
    };
  },
});
