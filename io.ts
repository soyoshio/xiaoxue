/**
 * IO 契约(SPEC §2)——唯一与磁盘交互的运行时层(第 4 点)。
 *
 * 本层标定文件位置,全部由 .env 显式提供,无默认值。
 * 上层(context/tools/agent)只通过这里的函数读写:
 *   - 人设文件(AGENT_PERSONA)  模型人设(低频写,进稳定前缀;bash 拒绝含 persona 的命令)
 *   - 事件状态(AGENT_RUN_DIR/state.json)  每次醒来后原子写,不作为工具路径暴露
 * 启动时 ensureRuntime 会把这些位置上不存在的目录/文件创建出来(空文件)。
 *
 * 约定:
 * - 运行时目录(AGENT_RUN_DIR) :append-only JSONL + 原子写 state.json;单写者 = daemon
 *           例外:inbox.jsonl 允许外部以 O_APPEND 单行追加(CLI send / 前端 API);
 *           wake.json 由外部工具递增 seq,daemon 轮询发现变化后醒来;
 *           消费用字节偏移 cursor;整轮成功后推进,失败/崩溃重试为至少一次投递
 * - 记忆文件(AGENT_MEMORY 主记忆 / AGENT_FRIEND 朋友的) :由模型按人设经 bash 自主维护,低频写
 * - 记忆细节目录(AGENT_MEMORY_DIR) :她自己维护的其他 md 文件落这里
 * - 总结归档目录(AGENT_SUMMARY_DIR) :压缩时写入 <时间>.md(摘要)+ <时间>.json(被压缩的原始记录)
 * - 启动只创建缺失文件;JSONL 读取跳过坏行与半行,不重写已有内容
 */
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { PROJECT_DIR, envRequired } from "./env.ts";

// 所有文件位置均在 .env 显式标注,无默认值;相对路径以项目目录为基准。
const projectPath = (path: string) => resolve(PROJECT_DIR, path);
export const HOME_DIR = projectPath(envRequired("AGENT_HOME"));
export const PERSONA_PATH = projectPath(envRequired("AGENT_PERSONA"));
export const MEMORY_FILE = projectPath(envRequired("AGENT_MEMORY")); // 她自己的记忆(主记忆文件)
export const MEMORY_DIR = projectPath(envRequired("AGENT_MEMORY_DIR")); // 记忆细节目录(她自维护的其他 md)
export const FRIEND_FILE = projectPath(envRequired("AGENT_FRIEND")); // 关于朋友的记忆
export const SUMMARY_DIR = projectPath(envRequired("AGENT_SUMMARY_DIR")); // 总结归档目录
export const RUN_DIR = projectPath(envRequired("AGENT_RUN_DIR"));

export const PATHS = {
  // 核心文件:人设 / 记忆(自己、朋友) / 事件状态
  persona: PERSONA_PATH,
  memory: MEMORY_FILE,
  friend: FRIEND_FILE,
  state: `${RUN_DIR}/state.json`,
  wake: `${RUN_DIR}/wake.json`,
  // 其余运行时文件
  inbox: `${RUN_DIR}/inbox.jsonl`,
  outbox: `${RUN_DIR}/outbox.jsonl`,
  transcript: `${RUN_DIR}/transcript.jsonl`,
  llm: `${RUN_DIR}/llm.jsonl`,
  metrics: `${RUN_DIR}/metrics.jsonl`,
  screen: `${RUN_DIR}/screen.png`,
} as const;

// ---------- 事件状态(state.json) ----------

export interface State {
  cursors: { inbox: number };
  lastTs: number | null;
  wakeId: string;
}


/** 读状态:文件不存在才使用初始值;读取/解析失败直接抛错,避免 cursor 归零重放 */
export async function loadState(): Promise<State> {
  let text: string;
  try {
    text = (await readFile(PATHS.state)).toString("utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { cursors: { inbox: 0 }, lastTs: null, wakeId: "init" };
    }
    throw err;
  }
  const o = JSON.parse(text) as Partial<State>;
  return {
    cursors: { inbox: o.cursors?.inbox ?? 0 },
    lastTs: o.lastTs ?? null,
    wakeId: o.wakeId ?? "init",
  };
}

/** 写状态:原子写(tmp + rename) */
export async function saveState(state: State): Promise<void> {
  await atomicWriteJson(PATHS.state, state);
}

// ---------- 外部唤醒信号(wake.json) ----------

export interface WakeSignal {
  seq: number;
  ts: number;
  source: string;
  id: string;
}

export async function readWakeSignal(): Promise<WakeSignal> {
  const o = await readJsonOrNull<Partial<WakeSignal>>(PATHS.wake);
  if (!o) throw new Error(`无法读取唤醒信号: ${PATHS.wake}`);
  return {
    seq: o?.seq ?? 0,
    ts: o?.ts ?? 0,
    source: o?.source ?? "init",
    id: o?.id ?? `${o?.seq ?? 0}:${o?.ts ?? 0}:${o?.source ?? "init"}`,
  };
}

export async function signalWake(source = "external", id = randomUUID()): Promise<void> {
  const current = await readWakeSignal();
  await atomicWriteJson(PATHS.wake, { seq: current.seq + 1, ts: Date.now(), source, id });
}

// ---------- 人设 ----------

export async function readPersona(): Promise<string | null> {
  return readTextOrNull(PATHS.persona);
}

// ---------- transcript ----------

export interface TranscriptEvent {
  seq: number;
  ts: number;
  role: "user" | "assistant" | "tool";
  text?: string;
  meta?: Record<string, unknown>;
}

export async function readTranscript(): Promise<TranscriptEvent[]> {
  return (await readAllJsonl(PATHS.transcript)) as unknown as TranscriptEvent[];
}

// ---------- 低层原语(jsonl / 原子写 / 修复) ----------

/** 只消费以 \n 结尾的完整行;半行留给下一次读取 */
export async function readJsonlFrom(
  path: string,
  offset: number,
): Promise<{ items: Record<string, unknown>[]; offset: number }> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return { items: [], offset };
  }
  if (offset > buf.length) offset = 0; // 文件被清理/轮换
  const text = buf.subarray(offset).toString("utf-8");
  const cut = text.lastIndexOf("\n");
  if (cut === -1) return { items: [], offset };
  const complete = text.slice(0, cut + 1);
  const items: Record<string, unknown>[] = [];
  for (const line of complete.split("\n")) {
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      /* 坏行跳过,不重写已有文件 */
    }
  }
  return { items, offset: offset + Buffer.byteLength(complete) };
}

export async function readAllJsonl(path: string): Promise<Record<string, unknown>[]> {
  return (await readJsonlFrom(path, 0)).items;
}

export async function appendJsonl(path: string, obj: unknown): Promise<void> {
  const file = await open(path, "a+");
  try {
    const size = (await file.stat()).size;
    let separator = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 10) separator = "\n";
    }
    await file.appendFile(separator + JSON.stringify(obj) + "\n");
  } finally {
    await file.close();
  }
}


export async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, path);
}

/** 原子重写整个 jsonl(压缩截断 transcript 用) */
export async function atomicWriteJsonl(path: string, rows: unknown[]): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
  await rename(tmp, path);
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse((await readFile(path)).toString("utf-8")) as T;
  } catch {
    return null;
  }
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return (await readFile(path)).toString("utf-8");
  } catch {
    return null;
  }
}


export async function ensureRuntime(): Promise<void> {
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(HOME_DIR, { recursive: true });
  await mkdir(SUMMARY_DIR, { recursive: true });
  await mkdir(MEMORY_DIR, { recursive: true });
  // 人设/记忆文件可能在任意位置,先把父目录建出来
  for (const p of [PERSONA_PATH, MEMORY_FILE, FRIEND_FILE]) {
    await mkdir(dirname(p), { recursive: true });
  }
  for (const p of [PATHS.inbox, PATHS.outbox, PATHS.transcript, PATHS.llm, PATHS.metrics]) {
    await appendFile(p, "");
  }
  try {
    await writeFile(PATHS.wake, JSON.stringify({ seq: 0, ts: 0, source: "init", id: "init" }), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // 追加空内容只创建缺失文件,不截断已有文件
  for (const p of [PATHS.persona, PATHS.memory, PATHS.friend]) {
    await appendFile(p, "");
  }
}
