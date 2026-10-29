/**
 * 虚拟桌面共享助手:xdotool 封装,DISPLAY 取自 env。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { envRequired } from "../env.ts";

const execFileP = promisify(execFile);

export const DISPLAY = envRequired("DISPLAY");

export async function xdo(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileP("xdotool", args, {
    env: { ...process.env, DISPLAY },
  });
  return (stdout + stderr).trim();
}
