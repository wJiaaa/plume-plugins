import type { CallContext } from "@plume/contract";
import type { StudioView } from "./types.ts";

export interface SkinStudioApi {
	view(): Promise<StudioView>;
	watch(call: CallContext): AsyncGenerator<StudioView, void>;
	apply(id: string | null): Promise<StudioView>;
	/** 保存为新皮肤，绝不覆盖同名的旧作品。 */
	save(value: unknown, apply: boolean): Promise<StudioView>;
	saveCurrent(name: string): Promise<StudioView>;
	remove(id: string): Promise<StudioView>;
}
