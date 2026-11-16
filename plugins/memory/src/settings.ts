/**
 * 插件的设置（`ctx.settings`）：三个开关和后台总结用的模型。用户记忆和项目记忆默认开（只在本机读写），后台总结默认关
 * （要把会话发给模型）。模型在设置 › 智能体里选，没选就用新会话的默认模型。
 */

import type { MemorySettings } from "./api.ts";

export const DEFAULT_SETTINGS: MemorySettings = { user: true, project: true, extraction: false, model: undefined };

/** 存下的、界面改的都过一遍：开关只认布尔值，模型只认非空字符串，别的按默认。 */
export function normalizeSettings(saved: Record<string, unknown>): MemorySettings {
	const flag = (key: "user" | "project" | "extraction") => (typeof saved[key] === "boolean" ? saved[key] : DEFAULT_SETTINGS[key]);
	return {
		user: flag("user"),
		project: flag("project"),
		extraction: flag("extraction"),
		model: typeof saved.model === "string" && saved.model ? saved.model : undefined,
	};
}
