/**
 * 标准 LSP 的传输层：`Content-Length` 分帧的 JSON-RPC，走子进程的 stdin/stdout。
 *
 * 和 tsserver 那条私有协议分开写，因为两者的分帧根本不同：tsserver 是一行一个 JSON，这里按字节
 * 数切——服务器的消息里常有换行，按行切会把一条消息切成两半。字节而不是字符：`Content-Length`
 * 数的是 UTF-8 字节，源码里有中文时两者不等。
 */

import type { Readable, Writable } from "node:stream";

/** 一条消息的上限。服务器写坏了分帧时，不让缓冲区无限涨。 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const SEPARATOR = "\r\n\r\n";

export function encodeMessage(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** 从缓冲区里切出所有完整的消息，返回剩下的半截。头坏了就抛——流位置已经对不上，只能整个断开。 */
export function decodeMessages(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
	const messages: unknown[] = [];
	let rest = buffer;
	for (;;) {
		const end = rest.indexOf(SEPARATOR);
		if (end < 0) break;
		const header = rest.toString("ascii", 0, end);
		const match = /content-length:\s*(\d+)/i.exec(header);
		// i18n-exempt：交给模型的话（工具结果、错误）。
		if (!match) throw new Error(`语言服务器的消息头里没有 Content-Length：${JSON.stringify(header.slice(0, 200))}`);
		const length = Number(match[1]);
		if (length > MAX_MESSAGE_BYTES) throw new Error(`语言服务器的一条消息有 ${length} 字节，超过上限。`);
		const start = end + SEPARATOR.length;
		if (rest.length < start + length) break;
		messages.push(JSON.parse(rest.toString("utf8", start, start + length)));
		rest = rest.subarray(start + length);
	}
	return { messages, rest };
}

interface Handlers {
	/** 服务器反过来问客户端的请求。抛出的错误作为错误响应回给它。 */
	request(method: string, params: unknown): unknown;
	notification(method: string, params: unknown): void;
}

interface Waiter {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class LspConnection {
	private readonly input: Writable;
	private readonly handlers: Handlers;
	private readonly pending = new Map<number, Waiter>();
	private buffer: Buffer = Buffer.alloc(0);
	private seq = 1;
	private failure: Error | null = null;

	constructor(input: Writable, output: Readable, handlers: Handlers) {
		this.input = input;
		this.handlers = handlers;
		output.on("data", (chunk: Buffer) => this.consume(chunk));
		// 服务器先退出时写 stdin 会报 EPIPE；不接住就是一个未处理的 error 事件，整个宿主进程跟着倒。
		input.on("error", (error: Error) => this.close(error));
	}

	get closed(): boolean {
		return this.failure !== null;
	}

	request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		const id = this.seq++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				// 告诉服务器别算了；它不理也没关系，迟到的响应找不到等它的人，会被丢掉。
				this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
				// i18n-exempt：交给模型的话（工具结果、错误）。
				reject(new Error(`语言服务器在 ${timeoutMs}ms 内没有回应 ${method}。`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.failure) this.write({ jsonrpc: "2.0", method, params });
	}

	/** 断开：所有还在等的请求立刻失败，而不是各自等满超时。 */
	close(error: Error): void {
		this.failure ??= error;
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}

	private write(message: unknown): void {
		if (this.input.writable) this.input.write(encodeMessage(message));
	}

	private consume(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		let decoded: ReturnType<typeof decodeMessages>;
		try {
			decoded = decodeMessages(this.buffer);
		} catch (error) {
			this.buffer = Buffer.alloc(0);
			this.close(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		this.buffer = decoded.rest;
		for (const message of decoded.messages) this.dispatch(message);
	}

	private dispatch(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const frame = message as { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
		if (typeof frame.method === "string") {
			if (frame.id === undefined) {
				this.handlers.notification(frame.method, frame.params);
				return;
			}
			const id = frame.id;
			try {
				this.write({ jsonrpc: "2.0", id, result: this.handlers.request(frame.method, frame.params) ?? null });
			} catch (error) {
				this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } });
			}
			return;
		}
		if (typeof frame.id !== "number") return;
		const waiter = this.pending.get(frame.id);
		if (!waiter) return;
		this.pending.delete(frame.id);
		clearTimeout(waiter.timer);
		// i18n-exempt：交给模型的话（工具结果、错误）。
		if (frame.error) waiter.reject(new Error(frame.error.message ?? "语言服务器拒绝了这个请求。"));
		else waiter.resolve(frame.result);
	}
}
