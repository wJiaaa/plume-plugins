import type { PreviewTheme } from "./types.ts";

/** 在真实元素上解析 token，连同皮肤的 color-mix 一起交给独立页面。 */
export function previewTheme(): PreviewTheme {
	const root = getComputedStyle(document.documentElement);
	const probe = document.createElement("span");
	document.body.append(probe);
	const color = (token: string) => {
		probe.style.color = `var(--plume-${token})`;
		return getComputedStyle(probe).color;
	};
	try {
		return {
			scheme: root.colorScheme === "dark" || (root.colorScheme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light",
			vars: {
				"--background": color("shell"),
				"--foreground": color("ink"),
				"--muted": color("card"),
				"--muted-foreground": color("ink-muted"),
				"--card": color("card"),
				"--border": color("line"),
				"--primary": color("accent"),
				"--primary-foreground": color("on-accent"),
				"--success": color("ok"),
				"--warning": color("warning"),
				"--danger": color("danger"),
				"--code-background": color("code-bg"),
				"--code-foreground": color("code-fg"),
				"--chart-1": color("accent"),
				...Object.fromEntries([2, 3, 4, 5, 6].map((index) => [`--chart-${index}`, color(`chart-${index}`)])),
				"--radius": root.getPropertyValue("--plume-radius-field"),
				"--font-sans": getComputedStyle(document.body).fontFamily,
				"--font-mono": root.getPropertyValue("--plume-font-mono"),
				"--font-size": root.getPropertyValue("--plume-ui-size"),
			},
		};
	} finally {
		probe.remove();
	}
}
