/**
 * 驻留循环智能体(SPEC v1.1)。
 *
 * 形态:单 daemon 进程 = 一个循环。用户消息写入 run/inbox.jsonl;
 * 外部工具与 send 都通过 run/wake.json 唤醒;回复写 run/outbox.jsonl。
 * 全量事件流 run/transcript.jsonl;状态 run/state.json(原子写)。
 * 上下文由 context.ts 每次醒来从磁盘反射重建;工具在 tools/ 注册;磁盘只经 io.ts。
 *
 * 用法:
 *   node agent.ts                 # 启动循环(需 API key,.env 见 .env.example)
 *   node agent.ts send <文本>      # 向 inbox 投递一条消息(可与 daemon 并发)
 */
import { agentLoopContinue, type AgentContext, type AgentMessage } from "@mariozechner/pi-agent-core";
import { completeSimple, getModel, getEnvApiKey, getModels, type Message } from "@mariozechner/pi-ai";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { stdout } from "node:process";
import { envNum, envInt, envRequired } from "./env.ts";
import {
  PATHS,
  type State,
  type WakeSignal,
  ensureRuntime,
  appendJsonl,
  readJsonlFrom,
  readWakeSignal,
  saveState,
  loadState,
  signalWake,
} from "./io.ts";
import {
  buildContext,
  compactIfNeeded,
  lastAssistantText,
  recordTurn,
  setSummarizeFn,
  steeringMessage,
  type InboxMessage,
  type Wake,
} from "./context.ts";
import { tools } from "./tools/index.ts";

// env.ts 在 import 链最前,加载时已自动读 .env

// ---------- 模型(env 配置;截图/图片以 image part 注入) ----------
const provider = envRequired("AGENT_MODEL_PROVIDER");
const modelId = envRequired("AGENT_MODEL_ID");

/** 自定义 OpenAI 兼容模型,默认带视觉 */
function customModel(baseUrl: string): ReturnType<typeof getModel> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: envInt("AGENT_MODEL_CONTEXT_WINDOW", 1),
    maxTokens: envInt("AGENT_MODEL_MAX_TOKENS", 1),
    ...(provider === "deepseek"
      ? { compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" } }
      : {}),
  } as unknown as ReturnType<typeof getModel>;
}

// 模型选择优先级:
// 1. 设了 AGENT_MODEL_BASE_URL → 一律自定义 OpenAI 兼容模型(不查注册表)
// 2. 否则查 pi-ai 内置注册表
// 3. 注册表查不到且 provider=deepseek → 用 deepseek 官方地址兑底自定义
const baseFromEnv = process.env.AGENT_MODEL_BASE_URL;
const model = baseFromEnv
  ? customModel(baseFromEnv)
  : ((getModel as (p: string, m: string) => ReturnType<typeof getModel>)(provider, modelId) ??
      (provider === "deepseek" ? customModel("https://api.deepseek.com") : null));
if (!model) {
  const known = (getModels as (p: string) => { id: string }[])(provider)
    .map((m) => m.id)
    .join(", ");
  console.error(
    `✗ 未知模型 ${provider}/${modelId}:注册表没有,请设 AGENT_MODEL_BASE_URL 走自定义 OpenAI 兼容模型` +
      (known ? `\n  ${provider} 已注册: ${known}` : `\n  provider "${provider}" 不存在或无已知模型`),
  );
  process.exit(1);
}


// ---------- 自醒与循环 ----------
const SELF_WAKE_MIN = envNum("AGENT_HEARTBEAT_MIN", 0);
if (SELF_WAKE_MIN <= 0) {
  console.error("✗ AGENT_HEARTBEAT_MIN 必须大于 0");
  process.exit(1);
}
const SELF_WAKE_MS = SELF_WAKE_MIN * 60_000;
const BOOT_TS = Date.now(); // 冷启动基准:lastTs 为空时从这里起算闲置
const POLL_MS = envInt("AGENT_POLL_MS", 1); // 主循环检查 inbox/自醒条件的间隔
const RETRY_MS = envInt("AGENT_RETRY_MS", 1); // 醒来失败后的重试间隔

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- run/llm.jsonl:模型原始返回日志 ----------
// assistant 消息全量(文本/toolCall+参数/stopReason/usage/errorMessage)、
// 工具调用与结果全量;image part 的 base64 换成尺寸占位
async function logLlm(obj: Record<string, unknown>): Promise<void> {
  await appendJsonl(PATHS.llm, { ts: Date.now(), ...obj });
}

function sanitizeToolResult(result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result ?? null;
  return {
    ...(result as Record<string, unknown>),
    content: content.map((c) => {
      const part = c as { type?: string; data?: string; mimeType?: string };
      return part?.type === "image"
        ? { type: "image", mimeType: part.mimeType, bytes: (part.data ?? "").length }
        : c;
    }),
  };
}

// ---------- 一次醒来:drain inbox → 反射构建上下文 → 跑一轮 loop → 落盘 ----------
async function runWake(
  state: State,
  apiKey: string,
  items: Record<string, unknown>[],
  offset: number,
  wake: Wake,
  signalId: string | null,
): Promise<State> {
  const t0 = Date.now();
  const inbox: InboxMessage[] = items.map((i) => ({
    ts: Number(i.ts) || Date.now(),
    text: String(i.text ?? ""),
    wakeId: typeof i.wakeId === "string" ? i.wakeId : undefined,
  }));
  console.log(`[wake=${wake}] inbox +${inbox.length}`);

  // steering:loop 的每个工具轮之间重读 inbox,新消息以 steeringMessage 注入;
  // cursor 只在整轮成功后保存;失败重试为至少一次投递
  let cursor = offset;
  let handledSignalId = [...inbox].reverse().find((m) => m.wakeId)?.wakeId ?? signalId;
  const drained: InboxMessage[] = [...inbox];
  const steer = async (): Promise<AgentMessage[]> => {
    try {
      const r = await readJsonlFrom(PATHS.inbox, cursor);
      if (!r.items.length) return [];
      cursor = r.offset;
      const msgs: InboxMessage[] = r.items.map((i) => ({
        ts: Number(i.ts) || Date.now(),
        text: String(i.text ?? ""),
        wakeId: typeof i.wakeId === "string" ? i.wakeId : undefined,
      }));
      drained.push(...msgs);
      // 只确认本批消息携带的 wake ID,之后到达的信号留给下一轮
      handledSignalId = [...msgs].reverse().find((m) => m.wakeId)?.wakeId ?? handledSignalId;
      console.log(`[steer] +${msgs.length}`);
      return [steeringMessage(msgs)];
    } catch {
      return []; // getSteeringMessages 约定不可抛错:读失败视为无新消息
    }
  };


  const toolNames: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let hasUsage = false;

  // 每次醒来反射重建:人设/transcript 都从磁盘新读(context.ts)
  const built = await buildContext(inbox, wake);
  const context: AgentContext = {
    systemPrompt: built.systemPrompt,
    messages: built.messages,
    tools,
  };
  for await (const event of agentLoopContinue(context, {
    model,
    apiKey,
    getSteeringMessages: steer,
    convertToLlm: (msgs) =>
      msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)) as Message[],
  })) {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      toolNames.push(event.toolName);
      await logLlm({ type: "tool_call", tool: event.toolName, args: event.args });
    }
    if (event.type === "tool_execution_end") {
      await logLlm({
        type: "tool_result",
        tool: event.toolName,
        isError: event.isError,
        result: sanitizeToolResult(event.result),
      });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const currentUsage = event.message.usage;
      if (currentUsage) {
        hasUsage = true;
        usage.input += currentUsage.input;
        usage.output += currentUsage.output;
        usage.cacheRead += currentUsage.cacheRead;
      }
      await logLlm({ type: "assistant", message: event.message });
      if (event.message.stopReason === "error") {
        throw new Error(`模型调用失败: ${event.message.errorMessage ?? "未知错误"}`);
      }
    }
  }
  stdout.write("\n");
  const newMsgs = context.messages.slice(built.initialLength);

  // self 自醒期间收到朋友消息后,本轮按 inbox 处理回复与落盘
  wake = drained.length > 0 ? "inbox" : wake;
  await recordTurn(drained, wake, newMsgs);

  // 回复规则:inbox 唤醒且最终文本非空 → 自动送达
  const replyText = lastAssistantText(newMsgs);
  if (wake === "inbox" && replyText) {
    await appendJsonl(PATHS.outbox, { ts: Date.now(), text: replyText, via: "reply" });
    console.log(`agent> ${replyText}`);
  }

  state = {
    ...state,
    cursors: { inbox: cursor },
    lastTs: Date.now(),
    wakeId: handledSignalId ?? state.wakeId,
  };
  await saveState(state);
  try {
    await appendJsonl(PATHS.metrics, {
      ts: Date.now(),
      wake,
      inbox: drained.length,
      latencyMs: Date.now() - t0,
      tools: toolNames,
      usage: hasUsage ? { in: usage.input, out: usage.output, cacheRead: usage.cacheRead } : null,
    });
  } catch (err) {
    console.error("[metrics] 写入失败:", err);
  }
  return state;
}

// ---------- 自醒 ----------
function isSelfWakeDue(state: State): boolean {
  return Date.now() - (state.lastTs ?? BOOT_TS) >= SELF_WAKE_MS;
}

async function daemon(): Promise<void> {
  const apiKey = process.env.LLM_API_KEY || getEnvApiKey(model.provider);
  if (!apiKey) {
    console.error(`✗ 请设置 ${String(model.provider).toUpperCase()}_API_KEY 或 LLM_API_KEY(见 .env.example)`);
    process.exit(1);
  }
  if (!(model.input ?? []).includes("image")) {
    console.warn(`⚠ 模型 ${model.id} 无图像输入,截图/图片注入将被 provider 拒绝或忽略;请在 .env 配置视觉模型`);
  }
  await ensureRuntime();
  // 压缩用的摘要器:一次性 LLM 调用,把被归档的旧对话蒸馏成中文备忘(不进上下文,只落盘)
  setSummarizeFn(async (lines) => {
    const res = await completeSimple(
      model,
      {
        systemPrompt:
          "你是对话归档员。把下面这段智能体与朋友的旧对话蒸馏成简洁的中文备忘,保留:重要事实、约定、她做过的决定、情绪基调、未完成的事。直接输出备忘正文,不要客套。",
        messages: [{ role: "user", content: lines } as Message],
      },
      { apiKey },
    );
    if (res.stopReason === "error") {
      throw new Error(`摘要失败: ${res.errorMessage ?? "未知错误"}`);
    }
    const text = (Array.isArray(res.content) ? res.content : [])
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("")
      .trim();
    return text || "(摘要为空)";
  });
  let state = await loadState();
  let wakeId = state.wakeId;
  let startupPending = true;
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));
  console.log(`loop agent up (${model.id}), Ctrl-C 停止`);
  while (running) {
    const { items, offset } = await readJsonlFrom(PATHS.inbox, state.cursors.inbox);
    let signal: WakeSignal | null = null;
    try {
      signal = await readWakeSignal();
    } catch (err) {
      console.error("[wake] 信号读取失败,保留上次 ID:", err);
    }
    const externalWake = signal !== null && signal.id !== wakeId;
    const shouldWake = externalWake || isSelfWakeDue(state) || (startupPending && items.length > 0);
    const wake: Wake | null = shouldWake ? (items.length ? "inbox" : "self") : null;
    if (wake) {
      try {
        state = await runWake(state, apiKey, items, offset, wake, signal?.id ?? null);
        wakeId = state.wakeId;
        startupPending = false;
        // 每次醒来后尝试归档压缩:旧对话搬进 SUMMARY_DIR,transcript 只留最近窗口
        try {
          await compactIfNeeded();
        } catch (err) {
          console.error(`[compact] 失败(下次重试):`, err);
        }
      } catch (err) {
        console.error(`[wake=${wake}] 失败,${RETRY_MS}ms 后重试:`, err);
        await sleep(RETRY_MS);
      }
    }
    if (!wake) startupPending = false;
    await sleep(POLL_MS); // 空闲退避
  }
  console.log("stopped");
}


async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "send") {
    const text = process.argv.slice(3).join(" ");
    if (!text) {
      console.error("用法: node agent.ts send <文本>");
      process.exit(1);
    }
    await ensureRuntime();
    const wakeId = randomUUID();
    await appendJsonl(PATHS.inbox, { ts: Date.now(), text, wakeId });
    await signalWake("send", wakeId);
    console.log("✓ 已入队 inbox");
    return;
  }

  await daemon();
}

if (process.argv[1] && basename(process.argv[1]) === "agent.ts") {
  await main();
}
