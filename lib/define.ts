/**
 * 工具定义助手(第 3 点):每个工具独立一个 ts,经此 helper 用泛型保住 params 的 Static<T> 类型。
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";

export const tool = <T extends TSchema>(t: AgentTool<T>): AgentTool<T> => t;
