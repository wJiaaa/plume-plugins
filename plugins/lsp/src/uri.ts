/**
 * `file://` URI 与本地路径互转，平台作为参数。
 *
 * 不用 `url.pathToFileURL` / `fileURLToPath`，原因有两个：VS Code 一系的服务器（pyright、
 * basedpyright）把盘符写成 `file:///c%3A/...`，`fileURLToPath` 遇到它直接抛「路径必须是绝对的」；
 * 而且两者只按当前平台转，Windows 那一半在 macOS 上的单测里测不到——路径问题在 Windows 上
 * 正是会以别的方式坏掉的那一类。
 */

const isWindows = (): boolean => process.platform === "win32";

/** 每一段单独编码：空格、`#`、`%`、中文都要转义，分隔符不能被转义。 */
const encodeSegments = (segments: string[]): string => segments.map(encodeURIComponent).join("/");

export function pathToUri(path: string, windows = isWindows()): string {
	if (!windows) return `file://${encodeSegments(path.split("/"))}`;
	const slashed = path.replace(/\\/g, "/");
	if (slashed.startsWith("//")) {
		// UNC：`\\server\share\x` → `file://server/share/x`，主机名放进 authority。
		const [host, ...rest] = slashed.slice(2).split("/");
		return `file://${host}/${encodeSegments(rest)}`;
	}
	// `C:` 里的冒号原样留着：多数服务器认 `file:///C:/x`，而 `%3A` 那种写法只有一部分认。
	const [drive, ...rest] = slashed.split("/");
	return `file:///${drive}/${encodeSegments(rest)}`;
}

/** 不是 `file:` 的（`untitled:`、`jdt:` 之类服务器自己的虚拟文档）返回 null，调用方跳过。 */
export function uriToPath(uri: string, windows = isWindows()): string | null {
	if (!uri.toLowerCase().startsWith("file://")) return null;
	const rest = uri.slice("file://".length);
	const slash = rest.indexOf("/");
	const host = slash < 0 ? rest : rest.slice(0, slash);
	let decoded: string;
	try {
		decoded = decodeURIComponent(slash < 0 ? "/" : rest.slice(slash));
	} catch {
		return null;
	}
	const remote = host !== "" && host.toLowerCase() !== "localhost";
	if (!windows) return remote ? null : decoded;
	if (remote) return `\\\\${host}${decoded.replace(/\//g, "\\")}`;
	const drive = /^\/([a-zA-Z]):(?:\/|$)/.exec(decoded);
	// 盘符统一成大写：同一个文件，`c:\x` 与 `C:\x` 不该在结果里显示成两种写法。
	if (drive?.[1]) return `${drive[1].toUpperCase()}:\\${decoded.slice(4).replace(/\//g, "\\")}`;
	return decoded.replace(/\//g, "\\");
}
