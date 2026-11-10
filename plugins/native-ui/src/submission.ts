/** 同步上锁和调用发送入口，不能在真实事件和宿主校验之间插入异步等待。 */
export function createSubmission() {
	let pending = false;
	const sent = new Set<string>();
	return {
		busy: () => pending,
		sent: (payload: string) => sent.has(payload),
		start(payload: string, send: () => Promise<void>): Promise<void> | undefined {
			if (pending || sent.has(payload)) return undefined;
			pending = true;
			let result: Promise<void>;
			try {
				result = send();
			} catch (error) {
				pending = false;
				return Promise.reject(error);
			}
			return result
				.then(() => {
					sent.add(payload);
				})
				.finally(() => {
					pending = false;
				});
		},
	};
}
