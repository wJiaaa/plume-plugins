/**
 * 交给 Agent 的远端输出要先过这里：去掉终端控制序列，遮住常见的私钥、令牌和 `password=` 一类赋值。
 *
 * 只是尽力而为，证明不了一段任意文字里没有密钥；已存的主机密码另由 Vault.redact 换掉，两样都要过。
 */

const HIDDEN = "[hidden]";
const privateKey = /-----BEGIN\s+(?:[A-Z]+\s+)*PRIVATE KEY-----[\s\S]*?(?:-----END\s+(?:[A-Z]+\s+)*PRIVATE KEY-----|$)/gi;
const token =
	/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const bearer = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const assignment =
	/(["']?\b(?:[A-Za-z][A-Za-z0-9_]*_)?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n}\]]+))/gi;

export function maskSecrets(value: string): string {
	return value
		.replace(privateKey, HIDDEN)
		.replace(token, HIDDEN)
		.replace(bearer, `$1${HIDDEN}`)
		.replace(assignment, (match, prefix: string, double?: string, single?: string, bare?: string) => {
			const assigned = double ?? single ?? bare ?? "";
			// `"password": { "type": "string" }` 这样的结构定义、变量引用，没有赋上去的密钥。
			if (
				!assigned ||
				/^(?:\{|\[)/.test(assigned) ||
				/^(?:null|true|false)$/.test(assigned) ||
				/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(assigned)
			)
				return match;
			return double !== undefined ? `${prefix}"${HIDDEN}"` : single !== undefined ? `${prefix}'${HIDDEN}'` : `${prefix}${HIDDEN}`;
		});
}

/** 远端输出里可能有颜色、光标移动和双向文字覆盖符，交给模型和画进卡片前去掉。 */
export function cleanTerminalText(value: string): string {
	return (
		value
			// oxlint-disable-next-line no-control-regex -- 要去掉的正是控制字符
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			// oxlint-disable-next-line no-control-regex -- 同上
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
			// oxlint-disable-next-line no-control-regex -- 同上
			.replace(/\x1b[@-_]/g, "")
			.replace(/\r\n/g, "\n")
			// oxlint-disable-next-line no-control-regex -- 同上
			.replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "")
	);
}
