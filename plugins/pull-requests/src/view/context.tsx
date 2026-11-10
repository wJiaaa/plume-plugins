import type { UiContext } from "@plume/contract/ui";
import { createContext, useContext, useSyncExternalStore } from "react";
import { useI18n } from "@plume/ui";
import { MESSAGES } from "../messages";
import type { Api, Store } from "./store";
import type { AvatarStore } from "./avatars";

export interface Services {
	ui: UiContext;
	api: Api;
	store: Store;
	avatars: AvatarStore;
}
export const ServicesContext = createContext<Services | null>(null);
export function useServices(): Services {
	const value = useContext(ServicesContext);
	if (!value) throw new Error("Missing pull request services");
	return value;
}
export function useStore() {
	const { store } = useServices();
	return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
export function useMessages() {
	return MESSAGES[useI18n().resolvedLocale];
}
