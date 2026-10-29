/**
 * 上下文维护节点。
 *
 * 每次醒来都从磁盘重新构建:
 *   system(人设 + 一条系统提醒) → 最近 K 轮历史 → 本轮新消息
 * 人设占位符(位置由 env 标注加载):${MEMORY} → 主记忆文件,${MEMORY_DIR} → 记忆细节目录,
 * ${FRIEND} → 朋友记忆文件,${SUMMARY} → 总结归档目录。
 * 摘要与运行时状态(游标等)不进上下文;消息以"朋友发来消息"的口吻注入,不用 <data> 标签。
 *
 * 压缩(compactIfNeeded):对话轮数超过 RECENT_TURNS + COMPACT_MIN_BATCH 时,
 * 旧事件归档到 SUMMARY_DIR/<时间>.json(原始记录)+ <时间>.md(LLM 摘要),
 * transcript 截断只留最近 RECENT_TURNS 轮(seq 重编号)。
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { writeFile } from "node:fs/promises";
import { envInt } from "./env.ts";
import {
  FRIEND_FILE,
  MEMORY_DIR,
  MEMORY_FILE,
  PATHS,
  SUMMARY_DIR,
  appendJsonl,
  atomicWriteJsonl,
  readPersona,
  readTranscript,
  type TranscriptEvent,
} from "./io.ts";

export type { TranscriptEvent };
export type Wake = "inbox" | "self";

const SELF_WAKE_NOTE =
  "[self] 这一轮没有朋友的消息,你是自己醒来的。若有想主动告诉朋友的事(任务进展、异常、提醒)," +
  "用 send_user 或者朋友偏好的方式;若无话可说,你可以做些自己的事情。";

export const RECENT_TURNS = envInt("AGENT_RECENT_TURNS", 1); // 历史保留的最近对话轮数
export const COMPACT_MIN_BATCH = envInt("AGENT_COMPACT_MIN_BATCH", 1); // 窗口外攒够这么多轮对话才触发一次压缩

/** 摘要函数由 agent 注入;context 层不调用 LLM */
export type SummarizeFn = (conversationLines: string) => Promise<string>;

let summarizeFn: SummarizeFn | null = null;

export function setSummarizeFn(fn: SummarizeFn): void {
  summarizeFn = fn;
}

// ---------- system prompt ----------

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function systemPromptFor(persona: string): string {
  return [
    persona,
    "",
    "# 一条系统提醒",
    `.env(密钥)与人设文件(${PATHS.persona})不接受任何工具的读写改删——身份由朋友维护,这是为了保护你,请不要尝试。`,
  ].join("\n");
}

// ---------- 构建 ----------

export interface InboxMessage {
  ts: number;
  text: string;
  wakeId?: string;
}

export interface BuiltContext {
  systemPrompt: string;
  /** 稳定前缀(历史) + 本轮新消息,agentLoopContinue 会在此基础上追加 */
  messages: AgentMessage[];
  /** 进入 loop 前的消息总数:loop 之后 slice(initialLength) 即得本轮新消息 */
  initialLength: number;
}

/**
 * 每次醒来调用一次:从磁盘重读人设/transcript(反射),组装成 {systemPrompt, messages}。
 */
export async function buildContext(inbox: InboxMessage[], wake: Wake): Promise<BuiltContext> {
  const persona =
    ((await readPersona())
      ?.replaceAll("${MEMORY_DIR}", MEMORY_DIR)
      .replaceAll("${MEMORY}", MEMORY_FILE)
      .replaceAll("${FRIEND}", FRIEND_FILE)
      .replaceAll("${SUMMARY}", SUMMARY_DIR)
      .trim()) ||
    "(暂无人设)";
  const history = historyMessages(await readTranscript());
  const messages: AgentMessage[] = [...history, friendMessage(inbox, wake === "self" ? SELF_WAKE_NOTE : undefined)];
  return {
    systemPrompt: systemPromptFor(persona),
    messages,
    initialLength: messages.length,
  };
}

/** 只取 user(inbox 来源)/assistant 的文本轮;自醒注记与 tool 事件不进历史 */
export function historyMessages(events: TranscriptEvent[], k = RECENT_TURNS): AgentMessage[] {
  const conv = events.filter(isConvEvent);
  return conv.slice(-k).map((e) =>
    e.role === "user"
      ? { role: "user" as const, content: e.text as string, timestamp: e.ts }
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: e.text as string }],
          api: "none" as const,
          provider: "history",
          model: "history",
          usage: ZERO_USAGE,
          stopReason: "stop" as const,
          timestamp: e.ts,
        },
  );
}

/** 本轮新消息:自醒注记 + 朋友发来的消息 */
export function friendMessage(inbox: InboxMessage[], note?: string): AgentMessage {
  const lines: string[] = [];
  if (note) lines.push(note);
  for (const m of inbox) {
    lines.push(`朋友通过 send 工具给你发来消息(ts=${m.ts}):「${m.text}」`);
  }
  return { role: "user", content: lines.join("\n"), timestamp: Date.now() };
}

/** steering:loop 工具轮之间注入,提示新消息优先于手头的事 */
export function steeringMessage(inbox: InboxMessage[]): AgentMessage {
  const lines = ["你正忙着的时候,朋友又通过 send 工具发来新消息:"];
  for (const m of inbox) {
    lines.push(`(ts=${m.ts})「${m.text}」`);
  }
  return { role: "user", content: lines.join("\n"), timestamp: Date.now() };
}

/** 本轮产生的最后一段助手文本,供发送策略使用 */
export function lastAssistantText(messages: AgentMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return last && Array.isArray(last.content)
    ? last.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("")
        .trim()
    : "";
}

/** 本轮上下文落盘:inbox 消息、自醒注记、助手消息与工具结果 */
export async function recordTurn(inbox: InboxMessage[], wake: Wake, newMsgs: AgentMessage[]): Promise<void> {
  const hasActivity = newMsgs.some(
    (m) => m.role === "toolResult" || (m.role === "assistant" && lastAssistantText([m]) !== ""),
  );
  let tseq = (await readTranscript()).length;
  for (const m of inbox) {
    await appendJsonl(PATHS.transcript, {
      seq: tseq++,
      ts: m.ts,
      role: "user",
      text: m.text,
      meta: { source: "inbox", wakeId: m.wakeId },
    });
  }
  if (wake === "self" && hasActivity) {
    await appendJsonl(PATHS.transcript, { seq: tseq++, ts: Date.now(), role: "user", text: SELF_WAKE_NOTE, meta: { source: "self" } });
  }
  for (const m of newMsgs) {
    if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      const text = parts.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
      const called = parts.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name);
      if (!text.trim() && !called.length) continue;
      await appendJsonl(PATHS.transcript, { seq: tseq++, ts: m.timestamp ?? Date.now(), role: "assistant", text, meta: { tools: called } });
    } else if (m.role === "toolResult") {
      const snippet = JSON.stringify(m.content).slice(0, 500);
      await appendJsonl(PATHS.transcript, { seq: tseq++, ts: m.timestamp ?? Date.now(), role: "tool", text: `${m.toolName}: ${snippet}`, meta: {} });
    }
  }
}

// ---------- 压缩(归档式,不进上下文) ----------

/** 与历史窗口同一口径:inbox 来源的 user 轮 + 非空 assistant 轮 */
function isConvEvent(e: TranscriptEvent): boolean {
  return (
    typeof e.text === "string" &&
    e.text.trim() !== "" &&
    (e.role === "assistant" ||
      (e.role === "user" && ((e.meta?.source as string | undefined) ?? "inbox") === "inbox"))
  );
}

/**
 * 对话轮数超过窗口 + 最小批量时触发:
 * 旧事件(seq < 保留窗口首条)整体搬进 SUMMARY_DIR/<时间>.json,
 * LLM 摘要写 <时间>.md,transcript 原子重写为剩余事件(seq 重编号)。
 */
export async function compactIfNeeded(): Promise<boolean> {
  const events = await readTranscript();
  const conv = events.filter(isConvEvent);
  if (conv.length < RECENT_TURNS + COMPACT_MIN_BATCH) return false;

  const cut = conv[conv.length - RECENT_TURNS]; // 保留窗口的第一条
  const archived = events.filter((e) => e.seq < cut.seq);
  const kept = events.filter((e) => e.seq >= cut.seq).map((e, i) => ({ ...e, seq: i }));

  const lines = archived
    .filter(isConvEvent)
    .map((e) => `${e.role}: ${(e.text ?? "").slice(0, 300)}`)
    .join("\n");
  if (!summarizeFn) throw new Error("未注入摘要函数");
  const summary = await summarizeFn(lines);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(`${SUMMARY_DIR}/${stamp}.md`, summary.trim() + "\n");
  await writeFile(`${SUMMARY_DIR}/${stamp}.json`, JSON.stringify(archived, null, 2) + "\n");
  await atomicWriteJsonl(PATHS.transcript, kept);
  console.log(`[compact] 归档 ${archived.length} 条 → ${SUMMARY_DIR}/${stamp}.{md,json},transcript 留 ${kept.length} 条`);
  return true;
}
