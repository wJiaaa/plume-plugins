import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message, ModelImageRequest, ModelImageResult, PluginContext, PromptSection, ToolRun } from "@plume/contract";
import { imageCanvasState } from "../src/image-state.ts";
import { drawingsIn } from "../src/lineage.ts";
import { conversationPictures } from "../src/pictures.ts";
import { ESTIMATE_CEILING, expectedMs, progressAt, stageAt } from "../src/progress.ts";
import { imageTool, withImageGuidelines } from "../src/tool.ts";
import { IMAGE_TOOL, lastProgress, readDetails } from "../src/types.ts";

test("图片加载失败离开 pending，成功加载才进入 done", () => {
	assert.equal(imageCanvasState(false, false), "pending");
	assert.equal(imageCanvasState(false, true), "error");
	assert.equal(imageCanvasState(true, false), "done");
});

/** 1×1 的 PNG。 */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const media = (n: number) => `${String(n).repeat(40).slice(0, 40)}.png`;
const MODEL = { id: "p/gpt-image-1", name: "GPT Image", modelId: "gpt-image-1", provider: "p" };

interface Fake {
	ctx: PluginContext;
	requests: ModelImageRequest[];
	saved: string[];
	found: [string | undefined, string | undefined][];
}

function fakeContext(options: { messages?: Message[]; result?: ModelImageResult; noModel?: boolean } = {}): Fake {
	const requests: ModelImageRequest[] = [];
	const saved: string[] = [];
	const found: Fake["found"] = [];
	const store = new Map<string, string>([[media(1), PNG]]);
	const ctx = {
		locale: () => "zh-CN",
		model: {
			findImageModel: async (name?: string, sessionId?: string) => {
				found.push([name, sessionId]);
				return options.noModel ? { reason: "none", candidates: [] } : { model: MODEL };
			},
			image: async (request: ModelImageRequest) => {
				requests.push(request);
				return options.result ?? { ok: true, images: [{ data: PNG, mimeType: "image/png", width: 1, height: 1 }], route: "images" };
			},
		},
		media: {
			save: async (image: { data: string }) => {
				const name = media(2 + saved.length);
				saved.push(name);
				store.set(name, image.data);
				return { name, path: `/data/session-media/${name}` };
			},
			read: async (name: string) => (store.has(name) ? { data: store.get(name) as string, mimeType: "image/png" } : null),
			nameOf: (path: string) => (path.startsWith("/data/session-media/") ? path.slice("/data/session-media/".length) : null),
		},
		sessions: { messages: async () => options.messages ?? [] },
	} as unknown as PluginContext;
	return { ctx, requests, saved, found };
}

function fakeRun(cwd: string, decision: "approve" | "reject" = "approve"): ToolRun & { progressed: string[]; asked: number } {
	const run = {
		sessionId: "s1",
		cwd,
		signal: new AbortController().signal,
		progressed: [] as string[],
		asked: 0,
		progress(chunk: string) {
			run.progressed.push(chunk);
		},
		async ask() {
			run.asked++;
			return decision;
		},
		permissionMode: async () => "default",
		tools: () => [],
		calls: [],
	};
	return run as unknown as ToolRun & { progressed: string[]; asked: number };
}

test("导出 Markdown 时写成「Generate image」加提示词第一行的前 80 个字", () => {
	const describe = imageTool(fakeContext().ctx).describe!;
	assert.equal(describe({ prompt: `  ${"狐".repeat(90)}\nin snow` }), `Generate image ${"狐".repeat(80)}`);
	assert.equal(describe({ prompt: "a red fox\nin snow" }), "Generate image a red fox");
	assert.equal(describe({ prompt: "  " }), "Generate image");
	assert.equal(describe({}), "Generate image");
});

test("没有生图模型时交回一句给模型的话，不调接口", async () => {
	const fake = fakeContext({ noModel: true });
	const out = await imageTool(fake.ctx).execute({ prompt: "a cat" }, fakeRun("/work"));
	assert.equal(out.isError, true);
	assert.match(out.output, /No image model is configured/);
	assert.equal(fake.requests.length, 0);
});

test("画成：图存进媒体目录，details 记下名字和宽高，进度先报形状和模型", async () => {
	const fake = fakeContext();
	const run = fakeRun("/work");
	const out = await imageTool(fake.ctx).execute({ prompt: "a cat", aspect_ratio: "16:9", count: 1 }, run);
	assert.equal(out.isError, undefined);
	const details = readDetails(out.details);
	assert.ok(details);
	assert.deepEqual(details.images, [{ media: fake.saved[0], mimeType: "image/png", width: 1, height: 1 }]);
	assert.equal(details.aspectRatio, "16:9");
	assert.equal(fake.requests[0]?.aspectRatio, "16:9");
	// 默认生图模型按这次调用所在的会话取，项目配置才能生效。
	assert.deepEqual(fake.found, [[undefined, "s1"]]);
	assert.equal(out.images?.length, 1);
	const first = lastProgress(run.progressed.join(""));
	assert.equal(first?.model, MODEL.id);
	assert.equal(first?.images, undefined);
});

test("#1 是对话里最新的那张图：按媒体名读回来，记作来源", async () => {
	const messages = [{ role: "user", content: [{ type: "image", media: media(1), mimeType: "image/png" }], timestamp: 1 }] as unknown as Message[];
	const fake = fakeContext({ messages });
	const out = await imageTool(fake.ctx).execute({ prompt: "add a hat", images: ["#1"] }, fakeRun("/work"));
	assert.deepEqual(readDetails(out.details)?.sources, [media(1)]);
	assert.equal(fake.requests[0]?.images?.[0]?.data, PNG);
	assert.equal(readDetails(out.details)?.edit, true);

	const missing = await imageTool(fake.ctx).execute({ prompt: "add a hat", images: ["#3"] }, fakeRun("/work"));
	assert.match(missing.output, /out of range/);
});

test("项目外的文件先问人；人拒绝时不读也不画", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-image-"));
	try {
		const file = join(dir, "pic.png");
		await writeFile(file, Buffer.from(PNG, "base64"));
		const fake = fakeContext();
		const run = fakeRun(join(dir, "project"), "reject");
		const out = await imageTool(fake.ctx).execute({ prompt: "x", images: [file] }, run);
		assert.equal(run.asked, 1);
		assert.match(out.output, /declined/);
		assert.equal(fake.requests.length, 0);

		const inside = fakeRun(dir);
		const drawn = await imageTool(fake.ctx).execute({ prompt: "x", images: ["pic.png"] }, inside);
		assert.equal(inside.asked, 0);
		assert.equal(readDetails(drawn.details)?.sources?.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("没画成：结果是错误，details 带着给卡片的原因", async () => {
	const fake = fakeContext({ result: { ok: false, failure: { summary: "quota", hint: "check-billing", retryAfterMs: 60_000 } } });
	const out = await imageTool(fake.ctx).execute({ prompt: "x" }, fakeRun("/work"));
	assert.equal(out.isError, true);
	assert.match(out.output, /no quota left/);
	assert.equal(readDetails(out.details)?.error?.hint, "check-billing");
});

test("改图链：从附件改出来的图记着来源，附件列为输入；对话里的图按新到旧数、同一张只数一次", () => {
	const drawn = (id: string, index: number, image: string, sources: string[]) => [
		{ role: "assistant", content: [{ type: "toolCall", id, name: IMAGE_TOOL, arguments: { prompt: `p${index}` } }], timestamp: index },
		{
			role: "toolResult",
			toolCallId: id,
			toolName: IMAGE_TOOL,
			content: [{ type: "image", media: image, mimeType: "image/png" }],
			details: { kind: IMAGE_TOOL, count: 1, sources, images: [{ media: image, mimeType: "image/png" }] },
			isError: false,
			timestamp: index + 1,
		},
	];
	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: "画只狗" },
				{ type: "image", media: media(1), mimeType: "image/png" },
			],
			timestamp: 0,
		},
		...drawn("a", 1, media(2), [media(1)]),
		...drawn("b", 3, media(3), [media(2)]),
	] as unknown as Message[];
	const { drawn: pictures, given } = drawingsIn(messages);
	assert.deepEqual(
		pictures.map((picture) => [picture.media, picture.sources, picture.ask?.text]),
		[
			[media(2), [media(1)], "画只狗"],
			[media(3), [media(2)], "画只狗"],
		],
	);
	assert.deepEqual(
		given.map((picture) => picture.media),
		[media(1)],
	);
	assert.deepEqual(
		conversationPictures(messages).map((picture) => picture.media),
		[media(3), media(2), media(1)],
	);
});

test("进度估计：先快后慢，到不了头；阶段跟着走", () => {
	const expected = expectedMs("gpt-image-1", "high", 2, true);
	assert.ok(expected > expectedMs("gemini-flash-image"));
	assert.equal(progressAt(0, expected), 0);
	assert.ok(progressAt(expected, expected) > 0.8);
	assert.ok(progressAt(expected * 100, expected) <= ESTIMATE_CEILING);
	assert.equal(stageAt(0), "brief");
	assert.equal(stageAt(0.5), "scene");
	assert.equal(stageAt(0.99), "finish");
});

test("用法接在准则那段（按 category 找）后面，别的段原样", () => {
	const sections: PromptSection[] = [
		{ id: "identity", text: "身份", category: "identity" },
		{ id: "rules", text: "Guidelines:\n- 一条", category: "guidelines" },
		{ id: "workspace", text: "工作目录" },
	];
	const [identity, rules, workspace] = withImageGuidelines(sections);
	assert.deepEqual([identity, workspace], [sections[0], sections[2]]);
	assert.match(rules!.text, /^Guidelines:\n- 一条\n- When the user asks for a picture .+ better done with code\.\n- The picture is shown/);
});
