/**
 * 逻辑入口经 `ctx.serve` 开给界面入口的接口，两边共用的类型。
 */

import type { DrawnPicture, GivenPicture } from "./lineage.ts";

export interface GalleryPicture extends DrawnPicture {
	sessionId: string;
}

export interface GalleryInput extends GivenPicture {
	sessionId: string;
}

export interface GallerySession {
	id: string;
	title: string;
	/** 项目 id；界面按它找项目的名字。 */
	project?: string;
	archived: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface Gallery {
	/** 最早的在前。分叉复制过去的图只列一次，记在画它的那个会话名下。 */
	pictures: GalleryPicture[];
	/** 输进生图、但不是画出来的图：附件、截图。 */
	inputs: GalleryInput[];
	/** 上面两份指向的会话。 */
	sessions: GallerySession[];
}

export interface ImageApi {
	gallery(): Promise<Gallery>;
}
