export type ImageCanvasState = "pending" | "done" | "error";

/** 图片请求失败后也要离开 pending，否则点阵会一直像是在生成。 */
export function imageCanvasState(loaded: boolean, failed: boolean): ImageCanvasState {
	return failed ? "error" : loaded ? "done" : "pending";
}
