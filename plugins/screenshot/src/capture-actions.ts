/** 异步的活属于发起它的那一次截图：浮层窗口是复用的，上一次的定时器和下载不能落到这一次头上。 */
export function createCaptureActions() {
	let session: number | undefined;
	let downloading: number | undefined;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	return {
		reset(next?: number): void {
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			session = next;
			downloading = undefined;
		},
		isCurrent(capture: number): boolean {
			return session === capture;
		},
		startDownload(capture: number): boolean {
			if (session !== capture || downloading !== undefined) return false;
			downloading = capture;
			return true;
		},
		finishDownload(capture: number): void {
			if (downloading === capture) downloading = undefined;
		},
		after(delay: number, action: () => void): void {
			const capture = session;
			const timer = setTimeout(() => {
				timers.delete(timer);
				if (session === capture) action();
			}, delay);
			timers.add(timer);
		},
	};
}
