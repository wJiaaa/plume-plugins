import type { Preview, PreviewTheme } from "./types.ts";

export interface PreviewApi {
	open(sessionId: string, id: string): Promise<{ preview: Preview; url: string; state: unknown }>;
	state(sessionId: string, id: string, value: unknown): Promise<void>;
	appearance(theme: PreviewTheme): Promise<void>;
}
