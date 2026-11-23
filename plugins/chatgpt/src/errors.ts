import type { ErrorCode } from "./api.ts";

/** 带原因的错误：`code` 给界面挑说法，`message` 只进日志（英文，不含令牌和回调参数的原值）。 */
export class ChatGptError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string = code) {
		super(message);
		this.name = "ChatGptError";
		this.code = code;
	}
}

export const codeOf = (error: unknown): ErrorCode => (error instanceof ChatGptError ? error.code : "network");

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
