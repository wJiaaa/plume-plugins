import { useEffect, useSyncExternalStore } from "react";
import { Text } from "@plume/ui";
import type { Api } from "./store";
import { readCache, writeCache } from "./cache";
import { useServices } from "./context";

type Person = { accountId: string; login: string; url?: string | null };
const keyFor = (person: Person) => JSON.stringify([person.accountId, person.login, person.url ?? null]);
export function createAvatarStore(api: Api) {
	const stored = readCache("avatars");
	const faces = new Map<string, string>(
		Array.isArray(stored)
			? stored.filter(
					(entry): entry is [string, string] =>
						Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].startsWith("data:image/"),
				)
			: [],
	);
	const asked = new Map<string, number>();
	const queued = new Map<string, Person>();
	const listeners = new Set<() => void>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	async function flush() {
		timer = undefined;
		const batch = [...queued.values()];
		queued.clear();
		// 同名用户按账号分批，返回的登录名不会覆盖另一个平台的头像。
		const accounts = new Set(batch.map((person) => person.accountId));
		await Promise.all(
			[...accounts].map(async (accountId) => {
				const people = batch.filter((person) => person.accountId === accountId);
				try {
					const answer = await api.avatars(people);
					let changed = false;
					for (const person of people) {
						const value = answer[person.login];
						if (typeof value === "string" && value.startsWith("data:image/")) {
							faces.set(keyFor(person), value);
							changed = true;
						}
					}
					if (changed) {
						while (faces.size > 80) faces.delete(faces.keys().next().value!);
						writeCache("avatars", [...faces]);
						for (const listener of listeners) listener();
					}
				} catch {
					/* 失败只留下重试时间，下次列表刷新仍会补图。 */
				}
			}),
		);
	}
	const want = (person: Person) => {
		const key = keyFor(person);
		if (!person.login || faces.has(key) || Date.now() - (asked.get(key) ?? 0) < 60_000) return;
		asked.set(key, Date.now());
		queued.set(key, person);
		timer ??= setTimeout(() => void flush(), 16);
	};
	return {
		want,
		get: (person: Person) => faces.get(keyFor(person)) ?? null,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
export type AvatarStore = ReturnType<typeof createAvatarStore>;
export function Avatar({ accountId, login, url, size = 18 }: Person & { size?: number }) {
	const { avatars } = useServices();
	const person = { accountId, login, url };
	const src = useSyncExternalStore(avatars.subscribe, () => avatars.get(person));
	useEffect(() => {
		avatars.want({ accountId, login, url });
	}, [avatars, accountId, login, url]);
	return (
		<span aria-hidden className="plume-pr-avatar" style={{ width: size, height: size }}>
			{src ? (
				<img src={src} alt="" width={size} height={size} draggable={false} />
			) : (
				<Text size="caption" tone="faint">
					{(login[0] ?? "?").toUpperCase()}
				</Text>
			)}
		</span>
	);
}
