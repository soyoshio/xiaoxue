/**
 * 环境变量(第 2 点):零依赖 .env 加载 + 类型化读取。
 * 只填补缺失的 key,不覆盖已有环境变量(shell 优先于 .env)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PROJECT_DIR = fileURLToPath(new URL(".", import.meta.url));

export function loadDotEnv(path = `${PROJECT_DIR}/.env`): void {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return; // 没有 .env 就跳过
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (key in process.env) continue;
    // 去掉成对引号;非引号值剔除行内/行首 # 注释再 trim
    let val = raw.trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    else val = raw.replace(/(^|\s+)#.*$/, "").trim();
    process.env[key] = val;
  }
}

export function envNum(name: string, min = -Infinity, max = Infinity): number {
  const raw = envRequired(name);
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    console.error(`✗ ${name} 必须是 [${min}, ${max}] 范围内的数字,当前为 ${raw}`);
    process.exit(1);
  }
  return v;
}

export function envInt(name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = envRequired(name);
  const v = envNum(name, min, max);
  if (!Number.isInteger(v)) {
    console.error(`✗ ${name} 必须是整数,当前为 ${raw}`);
    process.exit(1);
  }
  return v;
}

/** 必填配置(无默认值):缺失/空白直接拒绝启动 */
export function envRequired(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    console.error(`✗ 缺少必填环境变量 ${name}(无默认值):请在 .env 中标注,见 .env.example`);
    process.exit(1);
  }
  return v.trim();
}

// 自动加载:本模块在 agent.ts 的 import 链最前面(tools/xdo.ts 等在 import 时读 DISPLAY)
loadDotEnv();
