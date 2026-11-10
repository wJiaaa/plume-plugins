/**
 * 逻辑入口经 ctx.serve 开给界面的接口和两边共用的数据形状。SSH 连接、凭据和传输都在 agent 进程里，界面只拿到
 * 去掉密码的视图：主机只知道「存没存密码」，连接只知道账号、地址和指纹。
 */

import type { CallContext, SessionMessage } from "@plume/contract";

/** 一台主机。密码不出逻辑入口。 */
export interface HostProfile {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	hasPassword: boolean;
	groupId: string | null;
	tags: string[];
	favorite: boolean;
	/** ISO 时间；没连过为空。 */
	lastConnectedAt: string | null;
}

export interface HostGroup {
	id: string;
	name: string;
}

/** 新建或编辑主机。编辑时 `password` 不给就留着原来的。 */
export interface HostInput {
	id?: string;
	name: string;
	host: string;
	port: number;
	username: string;
	password?: string;
	groupId?: string | null;
	tags?: string[];
	favorite?: boolean;
}

/** 资源占用的一次读数；读不到的项为空。 */
export interface ResourceStats {
	cpu: number | null;
	memory: number | null;
	disk: number | null;
	rxRate: number | null;
	txRate: number | null;
	at: string;
	/** 这一次没读成。 */
	failed?: boolean;
}

/**
 * 面板一个标签的那条连接。
 *
 * - connecting：在握手、登录
 * - hostkey：第一次连这台机器，等人核对指纹（`fingerprint`）
 * - connected：终端开着
 * - closed：断了（`error` 说为什么），终端里的字留着看
 */
type ConnectionState = "connecting" | "hostkey" | "connected" | "closed";

export interface ConnectionView {
	/** 主机页终端标签的 id，一个标签一条连接。 */
	tab: string;
	/** 这一次连接的 id：重新连接换一个新的，运维助手的命令和终端都按它认。 */
	id: string;
	serverId: string;
	label: string;
	host: string;
	port: number;
	username: string;
	state: ConnectionState;
	/** 主机指纹：hostkey 时是待核对的那个，connected 时是核对过的那个。 */
	fingerprint?: string;
	error?: string;
	/** 资源占用开着时的最近一次读数。 */
	stats?: ResourceStats;
}

export interface RemoteEntry {
	name: string;
	path: string;
	kind: "file" | "directory" | "link" | "other";
	size: number;
	modifiedAt: string | null;
	permissions: string;
}

export interface DirectoryListing {
	path: string;
	entries: RemoteEntry[];
	/** 只列了前 2000 项。 */
	truncated: boolean;
}

export interface Transfer {
	id: string;
	/** 连接 id。 */
	connection: string;
	direction: "upload" | "download";
	name: string;
	remotePath: string;
	localPath: string;
	bytes: number;
	total: number;
	status: "running" | "done" | "failed" | "cancelled";
	error?: string;
	startedAt: string;
	finishedAt?: string;
}

/** 批量命令的一个目标：发起时冻结的连接身份，执行前逐项再核对一遍。 */
export interface BatchTarget {
	connection: string;
	serverId: string;
	label: string;
	host: string;
	port: number;
	username: string;
	fingerprint: string;
}

type BatchTargetStatus = "queued" | "running" | "succeeded" | "failed" | "unknown" | "blocked" | "cancelled";

export interface BatchResult extends BatchTarget {
	status: BatchTargetStatus;
	stdout: string;
	stderr: string;
	code: number | null;
	/** 输出被截掉了。 */
	truncated: boolean;
	/** 不是退出码能说清的情况：没派发、派发后结果未知。 */
	note?: "identity" | "disconnected" | "notDispatched" | "unknown" | "outputLimit";
	startedAt?: string;
	finishedAt?: string;
}

export interface BatchInput {
	connections: string[];
	command: string;
	concurrency: number;
	timeoutSeconds: number;
}

export interface BatchRun {
	id: string;
	command: string;
	concurrency: number;
	timeoutSeconds: number;
	status: "running" | "stopping" | "completed" | "cancelled";
	createdAt: string;
	finishedAt?: string;
	targets: BatchResult[];
}

export interface ImportRow {
	id: string;
	sheet: string;
	row: number;
	name: string;
	host: string;
	port: number | null;
	username: string;
	groupName: string;
	status: "ready" | "duplicate" | "invalid" | "formula";
}

export interface ImportPreview {
	id: string;
	fileName: string;
	rows: ImportRow[];
	warnings: ImportWarning[];
}

/** 解析时跳过了什么，界面按语言说。 */
export type ImportWarning = { kind: "hiddenSheet" | "noHeader" | "duplicateHeader" | "farColumns"; sheet: number } | { kind: "numericPassword" };

export interface ImportInput {
	previewId: string;
	rowIds: string[];
	groupId: string | null;
	useSheetGroups: boolean;
}

/** 插件的整体状态：主机、分组、连接、资源占用开关、最近一次批量命令、传输、运维助手。每变一次推一份完整的。 */
export interface SshState {
	hosts: HostProfile[];
	groups: HostGroup[];
	connections: ConnectionView[];
	monitoring: boolean;
	batch: BatchRun | null;
	transfers: Transfer[];
	/** 运维助手现在这一段的会话 id；还没说过话、刚点了「新开一段」时为空。 */
	assistant: string | null;
	/** 运维助手有一次操作在等人批准：主机页没开着时给侧栏那一行挂提醒。 */
	asking: boolean;
}

/** 运维助手说过的一段，给「历史」。 */
export interface AssistantSegment {
	id: string;
	title: string;
	updatedAt: number;
}

/** 终端的输出：先回放攒下的，`ready` 之后是新来的；连接断了以 `end` 收尾。 */
export type TerminalOutput = { type: "data"; data: string } | { type: "ready" } | { type: "end" };

/** `ssh_run` 审批卡的正文：`ApprovalRequest.detail` 是它的 JSON。 */
export interface RunRequest {
	connection: string;
	label: string;
	target: string;
	fingerprint: string;
	timeoutSeconds: number;
	reason: string;
	command: string;
}

/** `ssh_run` 结果的 details，给工具卡片。 */
export interface RunDetails {
	kind: "ssh_run";
	label: string;
	target: string;
	command: string;
	reason: string;
	/** 人在审批卡上改过命令，`command` 是改过的那条。 */
	edited: boolean;
	status: "rejected" | "succeeded" | "failed" | "unknown" | "blocked";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

export interface SshApi {
	watch(call: CallContext): AsyncGenerator<SshState, void>;

	saveHost(input: HostInput): Promise<void>;
	setFavorite(id: string, favorite: boolean): Promise<void>;
	deleteHost(id: string): Promise<void>;
	saveGroup(group: { id?: string; name: string }): Promise<void>;
	deleteGroup(id: string): Promise<void>;
	moveHosts(ids: string[], groupId: string | null): Promise<void>;

	/** 在这个标签上连这台主机；标签原来的连接先断开。 */
	connect(tab: string, serverId: string): void;
	/** 第一次连接时人对指纹的回答。 */
	trust(tab: string, accept: boolean): void;
	disconnect(tab: string): void;
	/** 关标签：断开并忘掉这条连接。 */
	close(tab: string): void;
	attach(connection: string, call: CallContext): AsyncGenerator<TerminalOutput, void>;
	write(connection: string, data: string): void;
	resize(connection: string, cols: number, rows: number): void;
	setMonitoring(enabled: boolean): void;
	/** 终端里选中的字或最近的输出要交给 Agent 前先过一遍：去掉控制序列，遮住已存的密码和常见的密钥。 */
	scrub(text: string): string;

	sftpHome(connection: string): Promise<string>;
	sftpList(connection: string, path: string): Promise<DirectoryListing>;
	sftpMkdir(connection: string, directory: string, name: string): Promise<void>;
	sftpRename(connection: string, path: string, name: string): Promise<void>;
	sftpRemove(connection: string, path: string, kind: RemoteEntry["kind"]): Promise<void>;
	/** 把本机的这几个文件传到远端目录，同名覆盖。 */
	upload(connection: string, directory: string, localPaths: string[]): Promise<void>;
	/** 下载到本机的「下载」文件夹，重名时加序号；返回本机路径。 */
	download(connection: string, remotePath: string): Promise<string>;
	cancelTransfer(id: string): void;

	/** 这几条连接现在的身份，给批量命令的确认框；连接不可用时抛错。 */
	batchTargets(connections: string[]): BatchTarget[];
	/** 按人确认过的目标执行；目标的身份变了就不派发。 */
	startBatch(input: BatchInput, confirmed: BatchTarget[]): string;
	stopBatch(id: string): void;

	previewImport(fileName: string, data: ArrayBuffer): Promise<ImportPreview>;
	commitImport(input: ImportInput): Promise<{ imported: number; skipped: number }>;
	discardImport(id: string): void;
	/** 把导入模板写进「下载」文件夹，返回路径。 */
	writeTemplate(): Promise<string>;

	/** 审批卡上人改过的命令，先交过来再 respond。 */
	editRun(toolCallId: string, command: string): void;

	/** 对运维助手说一句，等这一轮结束；还没有这一段时先开一段。 */
	ask(message: string | AssistantMessage): Promise<void>;
	stopAssistant(): void;
	/** 页面上的运维助手还没有这一段时先开一个空的，输入框才画得出模型和思考档位。 */
	prepareAssistant(): Promise<void>;
	/** 「新开一段」：开一个新的会话，这一段留在历史里；这一段还没说过话时不换。 */
	newAssistant(): Promise<void>;
	/** 说过的各段，最近的在前。 */
	history(): Promise<AssistantSegment[]>;
	/** 回到历史里的某一段。 */
	openAssistant(id: string): Promise<void>;
	deleteAssistant(id: string): Promise<void>;
}

/** 界面交给运维助手的一句：正文、气泡上的字和附件，和输入框交出来的一样。 */
export interface AssistantMessage {
	content: SessionMessage["content"];
	displayText?: string;
	attachments?: SessionMessage["attachments"];
}
