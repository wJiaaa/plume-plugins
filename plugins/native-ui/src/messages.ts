import type { Locale } from "@plume/contract";
const zhCN = {
	help: "读取界面块语法",
	empty: "暂无数据",
	chart: "图表",
	sent: "已发送",
	failed: "发送失败，输入已保留。请重试。",
	invalid: "当前值无法用于此界面，请修改输入或重置。",
	reset: "重置表单",
};
export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		help: "Read interface block syntax",
		empty: "No data yet",
		chart: "Chart",
		sent: "Sent",
		failed: "Could not send. Your inputs are preserved. Try again.",
		invalid: "The current values cannot be used in this interface. Edit the inputs or reset them.",
		reset: "Reset form",
	},
};
