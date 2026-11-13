# 钩子

在会话开始、提交消息、调用工具前后、要你审批时、回答结束或失败时、会话结束时运行你写的命令：拦下危险的调用、替你答审批、给 agent 补充上下文、回答结束前再检查一遍。写法和 Claude Code 的钩子一样，那边的配置和大多数脚本搬过来就能用，对不上的地方见[和 Claude Code 的差别](#和-claude-code-的差别)。

## 它做了什么

- **九个事件**：
  - `SessionStart`：会话开始。
  - `UserPromptSubmit`：提交消息。
  - `PreToolUse`：调用工具之前。
  - `PermissionRequest`：要弹审批卡问你之前。权限模式已经放行的调用不会走到这里。
  - `PostToolUse`：工具调用之后。
  - `PostToolUseFailure`：工具调用失败之后。
  - `Stop`：回答结束。
  - `StopFailure`：这一轮没正常完成——出错、被停下、用满步数、原地打转、退出应用时被打断。
  - `SessionEnd`：会话结束——删除、归档、换到别的项目、退出应用。只对这次运行里开过口的会话跑一次。
- **用户钩子和项目钩子**：用户钩子对所有项目生效；项目钩子写在项目的 `.plume/config.json` 里，跟着仓库走，要先信任才会运行。
- **设置页「钩子」**：左上角切换看用户的还是某个项目的，可以开关、新建、编辑、删除、信任。
- **运行记录**：每次运行都记下来。哪一轮有钩子被拦下、失败或超时，那条回复底下的操作排里多一个「钩子」按钮，点开看每条怎么收场、为什么。
- **待审核提示**：会话所在的目录里有没信任的项目钩子时，输入框上方提示一行，「去审核」直接打开这个项目的钩子设置。

## 钩子能做什么

钩子从 stdin 读一段 JSON，里面有事件名、会话、目录，还有工具名、参数、结果等这个事件特有的字段。字段同时给出 camelCase 和 Claude Code 的 snake_case 两种写法：camelCase 的是 Plume 的叫法，snake_case 的照 Claude Code，工具名、参数名可能不同，见[和 Claude Code 的差别](#和-claude-code-的差别)。

钩子的退出码决定结果：

- **退出码 0**：读 stdout 上的 JSON。
- **退出码 2**：拦下，原因取 stderr。`PermissionRequest` 例外：退出码 2 不改变审批，照常弹卡问你，stderr 不用。
- **其他退出码**：算这条钩子运行失败，记进运行记录，这一步照常往下走。

stdout 上的 JSON 能表达这些：

- `PreToolUse` 可以用 `hookSpecificOutput.permissionDecision` 说「拦（deny）/ 问（ask）/ 放（allow）」，也可以用 `updatedInput` 改参数。
  - 几条钩子说法不一时，取最严的。
  - `defer`（挂起这次调用、交给外面答）只在 Claude Code 的 `claude -p` 里有用，Plume 照它交互模式的做法忽略，连同这条钩子的 `updatedInput`、`additionalContext`。
  - 「放」会跳过审批卡，但沙箱外运行（提权）仍然要你点头。
- `PermissionRequest` 可以用 `hookSpecificOutput.decision.behavior` 说 `allow` 或 `deny`；要拒绝只能这样说，退出码 2 不算拒绝。
  - 拒绝就不弹卡、直接拒绝；放行只放这一次。
  - 放行时用 `updatedInput` 改了参数的，Plume 换不了审批里的参数，不算放行，照常弹卡问你；原样交回的照样放行。
  - `updatedPermissions`（记一条规则、换权限模式、加目录）不支持，不理它，只放这一次。
  - 申请沙箱外运行（提权）只能由你在卡上批，钩子的放行 Plume 不认，拒绝照样算。
  - 提问、批准计划这些只能由你答的卡，不问钩子。
- `StopFailure` 和 `SessionEnd` 只是通知：这一轮或会话已经结束了，它们的输出不读。
- `UserPromptSubmit` 拦下时，这条消息不发给 agent，原因弹成提示条。
- `Stop` 用 `decision: "block"` 加 `reason` 让 agent 接着干。每轮最多续三次。
- 各事件的 `additionalContext` 会交给 agent 看。
  - `SessionStart`、`UserPromptSubmit`、`Stop` 的附在消息后面。
  - 工具前后的接在工具结果后面。

## 用法

1. 在「扩展」里装上。
2. 打开设置 →「钩子」，点「新建」。
3. 选事件，再选运行方式。
   - 「进程」直接启动一个程序，参数每行一个。
   - 「Shell 命令」交给 shell 跑一整行。
4. 有些事件可以填匹配器，用 `|` 分隔多个，也可以写正则：
   - 工具类事件（`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`）按工具名匹配，`Bash` 和 `bash` 都认，比如 `Write|Edit|Bash`。
   - `SessionStart` 按会话怎么开始的匹配：`startup` 或 `resume`。
   - `StopFailure` 按这一轮怎么结束的匹配：`error`、`aborted`、`max_turns`、`stalled`、`interrupted`。
   - `SessionEnd` 按会话为什么结束匹配：`deleted`、`archived`、`moved`、`quit`。
5. 需要时展开「高级」，设超时（默认 60 秒）和状态消息。

命令里可以用 `${CLAUDE_PROJECT_DIR}`（或 `${PLUME_PROJECT_DIR}`）、`${CLAUDE_SESSION_ID}`，子进程环境里也有它们。钩子在当前项目目录里运行，环境变量和你的终端一样，包括 `PATH`。勾了「后台运行」的钩子不等它跑完，它的输出也不影响这一步。

用户钩子存在本机这个插件的数据目录里（`hooks.json`），项目钩子存在项目的 `.plume/config.json` 的 `hooks` 键里（写法和 `hooks.json` 一样），改完下一次触发就生效。

## 和 Claude Code 的差别

匹配器、stdin 的字段名、退出码和输出的 JSON 都照 Claude Code 的约定，下面这些对不上：

- **工具名**：匹配器认 Claude Code 的 `Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`WebFetch`、`WebSearch`，也认旧配置里的 `MultiEdit`（`Edit` 和 `MultiEdit` 都对到 `edit`）。别的名字（`Agent`、`NotebookEdit`、`mcp__…` 这类）不翻译，按 Plume 的工具名写；Claude Code 已经没有 `LS`，Plume 的 `ls` 按 `ls` 写。
- **`tool_name` 和 `toolName`**：stdin 里的 `tool_name` 是 Claude Code 的名字，照 Claude Code 文档写的 `tool_name == "Edit"` 比得上；没有对照的工具是 Plume 的名字。Plume 的名字在 `toolName` 里（`bash`、`edit`），按 Plume 名字比的脚本读 `toolName`。`edit` 的 `tool_name` 是 `Edit`，不会是 `MultiEdit`。
- **`tool_input`**：是 Plume 工具的原参数，再补上 Claude Code 叫法的字段，两种写法的脚本都读得到：
  - `read`、`write`、`edit` 补 `file_path`，和 Claude Code 一样是展开后的绝对路径、用本机的分隔符：Plume 的 `path` 可以是相对项目目录的，或 `~/` 开头；Windows 上还认 `~\`、Git Bash 的 `/c/…`、`/cygdrive/c/…`、`/tmp/…`，换算成工具实际读写的 `C:\…`。`scratch://` 这类地址原样给。
  - `grep` 补 `-i`（Plume 的 `case_insensitive`）和 `-C`（`context`；Claude Code 也认 `context` 这个名字，两个都有）。
  - 名字本来就一样的不用补：`command`、`description`、`timeout`（都是毫秒）、`run_in_background`，`content`、`old_string`、`new_string`、`replace_all`、`offset`、`limit`，`pattern`、`path`、`glob`，`url`、`query`。
- **Plume 没有的参数**：`Grep` 的 `output_mode`（Plume 用 `files_only` 二选一，没有计数）、`head_limit`（Plume 的 `limit` 数的是匹配数）、`offset`、`-A`、`-B`、`-n`、`-o`、`type`、`multiline`，`WebFetch` 的 `prompt`、`offset`，`WebSearch` 的 `allowed_domains`、`blocked_domains`，`Read` 的 `pages`、`allow_large`，`Bash` 的 `dangerouslyDisableSandbox`，旧版 `MultiEdit` 的 `edits`（Plume 的 `edit` 一次改一处，读 `file_path`、`old_string`、`new_string` 就行）。读它们的脚本拿到空值。
- **`updatedInput`**：照 Claude Code 写法改了 `file_path`、`-i`、`-C` 的，翻回 Plume 的参数名再交给工具；只改了 Plume 名字的也认。
- **`tool_response`**：是 Plume 的 `{ output, details }`，不是 Claude Code 各工具自己的结构。

## 项目钩子的信任

项目钩子跟着仓库走：克隆别人的仓库，里面写的命令就会在你的机器上、以你的身份、在沙箱外运行。所以项目钩子要先在设置页逐条点「信任」才会运行；没信任的跑到时只记一笔「已阻止」。

- 信任按内容记：命令、参数、匹配器改了，要再信任一次。开关不算改动。
- 信任记录存在本机（插件数据目录的 `hook-trust.json`），不进仓库。
- 在设置页里亲手新建、编辑的项目钩子直接算信任过。
- 钩子以你的身份在本机运行，只添加、只信任你看过的命令。
