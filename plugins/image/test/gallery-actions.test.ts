import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionDraft, UiContext } from "@plume/contract/ui";
import { editInConversation } from "../src/gallery/actions.ts";
import { GALLERY_MESSAGES } from "../src/messages.ts";

const media = `${"a".repeat(40)}.png`;
const picture = { sessionId: "picture-session", media };
const marked = "data:image/png;base64,cGljdHVyZQ==";
const messages = GALLERY_MESSAGES["zh-CN"];

function fakeUi() {
	const drafts: { sessionId: string | undefined; draft: SessionDraft }[] = [];
	const notices: string[] = [];
	const ui: Pick<UiContext, "mediaUrl" | "draftInSession" | "notify"> = {
		mediaUrl: () => "",
		draftInSession: async (sessionId, draft) => {
			drafts.push({ sessionId, draft });
		},
		notify: (message) => notices.push(message),
	};
	return { ui, drafts, notices };
}

test("标注改图回到图所在会话，带原图来源，发送由宿主保护已有草稿", async () => {
	const { ui, drafts, notices } = fakeUi();
	assert.equal(await editInConversation(ui, messages, picture, "  加一顶帽子  ", marked), true);
	assert.deepEqual(drafts, [
		{ sessionId: picture.sessionId, draft: { text: "加一顶帽子", images: [{ data: "cGljdHVyZQ==", mimeType: "image/png", from: media }], send: true } },
	]);
	assert.deepEqual(notices, []);
});

test("只有标注时放进所属会话的草稿，不启动一轮", async () => {
	const { ui, drafts } = fakeUi();
	assert.equal(await editInConversation(ui, messages, picture, "  ", marked), true);
	assert.equal(drafts[0]?.draft.send, false);
	assert.equal(drafts[0]?.draft.text, "");
});

test("图片读不到或类型不支持时不发送；会话删除时返回失败保留输入", async () => {
	const { ui, drafts, notices } = fakeUi();
	assert.equal(await editInConversation(ui, messages, picture, "改图"), false);
	assert.equal(await editInConversation(ui, messages, picture, "改图", "data:text/plain;base64,eA=="), false);
	assert.equal(drafts.length, 0);
	assert.deepEqual(notices, [messages.unreadable, messages.unreadable]);
	ui.draftInSession = async () => {
		throw new Error("gone");
	};
	assert.equal(await editInConversation(ui, messages, picture, "改图", marked), false);
	assert.equal(notices.at(-1), messages.conversationGone);
});
