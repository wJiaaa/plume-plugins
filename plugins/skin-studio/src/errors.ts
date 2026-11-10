import type { Locale } from "@plume/contract";
import { ERROR_MESSAGES } from "./messages.ts";

export function errorText(error: unknown, locale: Locale): string {
	const message = error instanceof Error ? error.message : String(error);
	const messages = ERROR_MESSAGES[locale];
	return Object.hasOwn(messages, message) ? messages[message as keyof typeof messages] : message;
}
