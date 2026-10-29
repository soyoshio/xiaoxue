/**
 * bash:通用 shell 执行(带超时,DISPLAY 已注入)。
 * 读文本/列目录/等待(sleep)/后台启动 GUI(cmd &)都走它。
 */
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { tool } from "../lib/define.ts";
import { DISPLAY } from "../lib/xdo.ts";
import { envInt } from "../env.ts";
import { HOME_DIR, RUN_DIR } from "../io.ts";

const DEFAULT_TIMEOUT_MS = envInt("AGENT_BASH_DEFAULT_TIMEOUT_MS", 1);
const MAX_TIMEOUT_MS = envInt("AGENT_BASH_MAX_TIMEOUT_MS", 1);
const MAX_OUTPUT = envInt("AGENT_BASH_MAX_OUTPUT", 1);

// 禁区文本护栏(命令文本命中即拒,不替代系统权限或沙箱):
// 1. .env —— 任何读/写/删/移动
// 2. persona —— 子串匹配(不分大小写,.env.example、含 persona 的无关词同样被拒)
// 3. 运行时目录 —— inbox/outbox/transcript/state/wake 由系统维护
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\.env/, why: ".env(密钥文件)禁止任何操作" },
  { re: /persona/i, why: "人设文件禁止任何操作" },
  { re: new RegExp(escapeRegExp(RUN_DIR)), why: "运行时目录禁止任何操作" },
];

// 不把 daemon 的密钥和文件位置配置传给 shell
const TOOL_ENV = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: HOME_DIR,
  DISPLAY,
  LANG: process.env.LANG ?? "C.UTF-8",
  ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
};

function checkForbidden(command: string): string | null {
  for (const f of FORBIDDEN) {
    if (f.re.test(command)) return f.why;
  }
  return null;
}

export const bash = tool({
  name: "bash",
  label: "Bash",
  description:
    `执行 shell 命令(/bin/sh,cwd=${HOME_DIR},DISPLAY 已注入)。默认 ${DEFAULT_TIMEOUT_MS / 1000}s 超时,超时会杀掉命令。` +
    "读文件用 cat/head,列目录用 ls,等待用 sleep 1,启动 GUI 在命令末尾加 & 后台运行。" +
    "禁区:.env、人设文件与运行时目录的任何操作会被直接拒绝",
  parameters: Type.Object({
    command: Type.String({ description: "要执行的 shell 命令" }),
    timeout_ms: Type.Optional(Type.Number({ description: `超时毫秒,默认 ${DEFAULT_TIMEOUT_MS},上限 ${MAX_TIMEOUT_MS}` })),
  }),
  execute: async (_toolCallId, params) => {
    const denied = checkForbidden(params.command);
    if (denied) throw new Error(`拒绝执行: ${denied}`);
    if (/&\s*$/.test(params.command)) {
      const child = spawn("/bin/sh", ["-c", params.command], {
        env: TOOL_ENV,
        cwd: HOME_DIR,
        detached: true,
        stdio: "ignore",
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", reject);
        });
      } catch (err) {
        throw new Error(`后台启动失败: ${err instanceof Error ? err.message : err}`);
      }
      child.unref();
      return { content: [{ type: "text", text: "exit=0\n已后台启动" }], details: {} };
    }
    const timeout = Math.max(1, Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      const r = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", params.command], {
          env: TOOL_ENV,
          cwd: HOME_DIR,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let errOut = "";
        let timedOut = false;
        let forceKill: NodeJS.Timeout | null = null;
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          if (out.length < 8 * 1024 * 1024) out += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          if (errOut.length < 8 * 1024 * 1024) errOut += chunk;
        });
        const killGroup = (signal: NodeJS.Signals) => {
          try {
            if (child.pid) process.kill(-child.pid, signal);
          } catch {
            // 进程组已经退出
          }
        };
        const timeoutKill = setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          forceKill = setTimeout(() => killGroup("SIGKILL"), 1000);
        }, timeout);
        const clearTimers = () => {
          clearTimeout(timeoutKill);
          if (forceKill) clearTimeout(forceKill);
        };
        child.on("close", (code) => {
          clearTimers();
          resolve({
            stdout: out,
            stderr: timedOut ? errOut + `\n(超时 ${timeout}ms,进程组已终止)` : errOut,
            code: timedOut ? -1 : (code ?? -1),
          });
        });
        child.on("error", (err) => {
          clearTimers();
          reject(err);
        });
      });
      stdout = r.stdout;
      stderr = r.stderr;
      code = r.code;
    } catch (err) {
      throw new Error(`执行失败: ${err instanceof Error ? err.message : err}`);
    }
    const clip = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n...(截断,共 ${s.length} 字符)` : s);
    const text = [
      `exit=${code}`,
      stdout.trim() ? `--- stdout ---\n${clip(stdout).trim()}` : "",
      stderr.trim() ? `--- stderr ---\n${clip(stderr).trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { content: [{ type: "text", text }], details: {} };
  },
});
