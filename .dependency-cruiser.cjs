/**
 * 依赖方向（`pnpm arch`，`pnpm check` 的一部分），取本体仓库 .dependency-cruiser.cjs 里管得到插件的两条：值之间不循环、
 * 没有没人引的模块。插件只引用公开接口由 `pnpm check:host`（本体的 scripts/check-plugins.mjs）查，这里不重复。
 *
 * 已有的违规登记在 `.dependency-cruiser-known-violations.json`，照常通过；新加的违规直接失败。基线只能
 * 有意地重新生成（`pnpm arch:baseline`），变小是清理，变大要说得出理由。
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			comment:
				"值之间的循环会让一个模块在运行时只初始化了一半：其中一个拿到的是 undefined，报错说的是属性而不是循环。" +
				"只有类型的循环不算：编译后就没了，为了它压平类型没有意义。",
			severity: "error",
			from: {},
			to: { circular: true, dependencyTypesNot: ["type-only"] },
		},

		{
			name: "no-orphans",
			comment: "没人引的模块，要么已经死了，要么本该接上却没接。",
			severity: "warn",
			from: {
				orphan: true,
				pathNot: ["\\.d\\.ts$", "(^|/)(index|ui)\\.tsx?$", "(^|/)(test|scripts)/", "\\.(config|conf)\\.(ts|js|cjs|mjs)$"],
			},
			to: {},
		},
	],

	options: {
		doNotFollow: { path: "node_modules" },
		// 用 swc 解析：理由同本体仓库的 .dependency-cruiser.cjs（TypeScript 7 没有 dependency-cruiser 要的 JS API）。
		parser: "swc",
		tsPreCompilationDeps: "specify",
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "default", "types"],
			extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
			mainFields: ["module", "main", "types"],
		},
		exclude: { path: "node_modules|\\.d\\.ts$|/dist/" },
	},
};
