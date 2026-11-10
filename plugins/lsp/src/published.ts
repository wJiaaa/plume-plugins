/**
 * 推送式诊断：服务器分析完自己发 `publishDiagnostics`，客户端只能等。
 *
 * 等的方式是这个文件存在的理由。诊断常常分几批到（gopls 先推语法、再推类型），拿第一批就走会
 * 漏掉后面的，所以第一批到了之后再等一小段没有新的，才算齐。监听要在推送新内容**之前**挂上：
 * 服务器可能在 `didChange` 发出后几毫秒就推回来，晚挂一步就错过、白等满上限。
 */

/** 等第一批到的上限；和请求超时同一个量级，理由也一样：一次工具调用最多卡这么久。 */
const WAIT_MS = 8000;
/** 到了之后再等多久没有新的就算齐。 */
const SETTLE_MS = 400;

export class PublishedDiagnostics {
	private readonly latest = new Map<string, unknown[]>();
	private readonly listeners = new Set<(uri: string) => void>();

	record(uri: string, items: unknown[]): void {
		this.latest.set(uri, items);
		for (const listener of this.listeners) listener(uri);
	}

	clear(): void {
		this.latest.clear();
	}

	/**
	 * 挂上监听、推送内容（`sync` 返回这次有没有推新的），然后等这个 URI 的诊断。
	 * 内容没变、手里已有一份时直接用那份——服务器不会为没变的文件再推一次。
	 */
	async collect(uri: string, sync: () => Promise<boolean>, server: string): Promise<unknown[]> {
		let arrived = false;
		let settle = () => {};
		let quiet: NodeJS.Timeout | undefined;
		const done = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const listener = (from: string) => {
			if (from !== uri) return;
			arrived = true;
			clearTimeout(quiet);
			quiet = setTimeout(settle, SETTLE_MS);
		};
		this.listeners.add(listener);
		const deadline = setTimeout(settle, WAIT_MS);
		try {
			const changed = await sync();
			if (!changed && this.latest.has(uri)) return this.latest.get(uri) ?? [];
			await done;
			// i18n-exempt：交给模型的话（工具结果、错误）。
			if (!arrived) throw new Error(`${server} 在 ${WAIT_MS}ms 内没有给出诊断。`);
			return this.latest.get(uri) ?? [];
		} finally {
			clearTimeout(deadline);
			clearTimeout(quiet);
			this.listeners.delete(listener);
		}
	}
}
