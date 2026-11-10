import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { ModelContext, PluginContext, ToolDefinition, ToolRun } from "@plume/contract";
import { COMPONENTS } from "../src/catalog.ts";
import plugin from "../src/index.ts";
import { prepareBlock } from "../src/language.ts";
import { NATIVE_UI_HINT, uiReference } from "../src/prompt.ts";

test("不依赖技能插件即可发现完整语法，提示和校验共享组件表", async () => {
	let tool: ToolDefinition | undefined;
	let context: ((input: ModelContext, next: (input: ModelContext) => Promise<ModelContext>) => Promise<ModelContext>) | undefined;
	await plugin.apply({
		hook(name: string, layer: typeof context) {
			if (name === "model.context") context = layer;
		},
		tools: {
			register(value: ToolDefinition) {
				tool = value;
			},
		},
	} as unknown as PluginContext);
	assert.equal(plugin.name, "plume.native-ui");
	assert.equal(tool?.name, "ui_help");
	assert.equal(tool?.mutating, false);
	const input = { sections: [{ id: "identity", text: "Host prompt" }], messages: [], tools: [] } as unknown as ModelContext;
	const result = await context!(input, async (value) => value);
	assert.equal(result.sections.at(-1)!.text, NATIVE_UI_HINT);
	assert.equal(result.sections[0]!.text, "Host prompt");
	assert.ok(tool);
	assert.equal((await tool.execute({}, {} as ToolRun)).output, uiReference());
	assert.equal((await tool.execute({ unknown: true }, {} as ToolRun)).isError, true);
	const help = uiReference();
	assert.equal([...help.matchAll(/```ui\n/g)].length, 2);
	for (const [name, spec] of Object.entries(COMPONENTS)) {
		assert.ok(help.includes(`${name}(`), name);
		for (const prop of Object.keys(spec.props)) assert.ok(help.includes(`${prop}${spec.props[prop]!.required ? "*" : ""}:`), `${name}.${prop}`);
	}
	for (const match of help.matchAll(/```ui\n([\s\S]*?)\n```/g)) {
		const parsed = prepareBlock(match[1]!, true);
		assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	}
	assert.ok(help.includes("not full compatibility"));
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const examples = [...readme.matchAll(/```ui\n([\s\S]*?)\n```/g)];
	assert.equal(examples.length, 1);
	for (const example of examples) {
		const parsed = prepareBlock(example[1]!, true);
		assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	}
});
