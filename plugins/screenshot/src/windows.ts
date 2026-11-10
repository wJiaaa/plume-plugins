/**
 * 屏幕上的窗口在哪，好让截图时一点就框住整个窗口。
 *
 * 指哪个窗口就截哪个窗口，是大家对截图工具的默认期待，而它要的东西 Electron 不给：`desktopCapturer` 给得出窗口的画面，
 * 但从不说它在哪。macOS 知道——`CGWindowListCopyWindowInfo` 就是窗口服务器自己记的那张表——问题只是从这里怎么问。
 *
 * 用 `osascript -l JavaScript`，经 ObjC 桥直接调 CoreGraphics。别的路都更差：原生扩展是为一个函数搭一套编译和构建矩阵；
 * System Events 那条 AppleScript 的老路要辅助功能权限，为一件屏幕录制权限已经覆盖了的事多弹一个吓人的对话框。
 *
 * 截图开始时读一次，不轮询。浮层盖着的时候桌面不会重排：它是那一刻的定格画面，同一刻的窗口列表才对得上它。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowRect } from "./api.ts";

const execFileAsync = promisify(execFile);

/**
 * `kCGWindowLayer === 0` 是普通窗口那一层。
 *
 * 别的都是桌面上的家具——菜单栏、Dock、通知横幅、壁纸——把「Dock」当一个文档窗口提供出来没有用。尺寸下限去掉了好几个程序
 * 常留着的一像素辅助窗口，不然它们会成为看起来像样、一高亮却什么都框不住的目标。
 *
 * `ObjC["import"]` 就是 `ObjC.import`，写成方括号是让 `pnpm check:plugins` 不把脚本里的这两句当成本文件的模块引用。
 */
const SCRIPT = `
ObjC["import"]("CoreGraphics");
ObjC["import"]("Foundation");
const ref = $.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
  $.kCGNullWindowID,
);
const all = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
JSON.stringify(
  all
    .filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 60 && w.kCGWindowBounds.Height > 60)
    .map((w) => ({
      x: w.kCGWindowBounds.X,
      y: w.kCGWindowBounds.Y,
      width: w.kCGWindowBounds.Width,
      height: w.kCGWindowBounds.Height,
      app: String(w.kCGWindowOwnerName || ""),
    })),
);
`;

/**
 * 屏幕上的窗口，从前到后，坐标换成这块屏幕自己的。
 *
 * 从前到后是窗口服务器给的顺序，也是要紧的顺序：指针底下的窗口是表里第一个包含它的，和点击时的判定一样。
 *
 * 不抛错。读不到窗口列表的截图只是少了「点一下截整个窗口」的便利，不是坏了——失败时返回空，浮层照样能手动框选。
 */
export async function listWindows(display: { x: number; y: number; width: number; height: number }): Promise<WindowRect[]> {
	if (process.platform !== "darwin") return [];
	try {
		const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", SCRIPT], {
			timeout: 2000,
			maxBuffer: 4 * 1024 * 1024,
		});
		const raw = JSON.parse(stdout.trim() || "[]") as WindowRect[];
		return (
			raw
				// 换进浮层自己的坐标：它只盖一块屏幕，那块屏幕的原点不一定是整个桌面的原点。
				.map((w) => ({ ...w, x: w.x - display.x, y: w.y - display.y }))
				// 整个在这块屏幕外面的属于别的屏幕，在这里指不到。
				.filter((w) => w.x < display.width && w.y < display.height && w.x + w.width > 0 && w.y + w.height > 0)
		);
	} catch (err) {
		// i18n-exempt：日志。
		console.error("[screenshot] 读取窗口列表失败，将只能手动框选:", err);
		return [];
	}
}
