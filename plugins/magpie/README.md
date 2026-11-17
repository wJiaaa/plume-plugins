# Magpie

把 [Magpie](https://usemagpie.ai) 交给 Plume 的模型网关、全局指令和 MCP 服务交给 Plume。

## 它做了什么

Magpie 那边用的是 Plume 仓库里的 Agent 插件 `integrations/magpie`，它把东西写进这个插件的数据目录 `~/.plume/plugin-data/plume.magpie/`：

- **模型**：在 Magpie 的 Agent 页给 Plume 选一个模型，Magpie 把网关（地址、key、模型目录）和选中的模型写进 `credentials.json`。网关成为设置 › 模型里的「Magpie」供应商，排在你自己的后面，标着由这个插件提供：能重命名、启停、改连接和密钥、增删改模型、测试、设默认，也能删除，改动都写回这份文件，不进 Plume 自己的 `settings.json`、不进导出的供应商文件。Magpie 再次同步时覆盖连接、密钥和模型列表。
  - **默认模型**：Magpie 选了模型就设成 Plume 的默认模型，并记下原来的那个（`default-model.json`）；在 Magpie 里选回原来的模型或关掉开关时，Plume 的默认模型还是 Magpie 设的那个，就换回原来的，你在 Plume 里另选过就不动。Plume 关着时 Magpie 改的，下次启动跟上。
  - **花销**：Magpie 带的价格不是 Plume 认的形状，Plume 按自己模型目录里同名模型的参考价记花销。
  - **key**：`credentials.json` 里是网关的明文 key。插件启用时先建好只给本人读写（0600）的空文件，Magpie 原地改、不改权限；Plume 替模型读这个文件、或跑读它的命令前先问你。
- **全局指令**：Magpie 写进 `AGENTS.md`。每次调模型前现读，作为单独一段放进系统提示词，排在项目指令前面：项目自己的规矩优先，和设置里写的全局指令一样。最多放 100 KiB，超过的只放开头。
- **MCP 服务**：Magpie 写进 `mcp.json`（Claude 格式的 `mcpServers`）。这个插件把它们登记给 Plume 自带的 MCP 插件，出现在「插件市场 › 连接器」里，标着「由 Magpie 管理」：名称、开关、启动方式、变量和删除都锁住，在 Magpie 里改；连接状态、工具列表、重连和 OAuth 登录照常。
- **当场生效**：插件盯着数据目录，Magpie 改了网关、默认模型或 MCP 服务，下一轮就用上，设置页和模型列表当场跟着变，MCP 服务当场重连。
- **不留副本**：都不抄进 Plume 自己的设置。在 Magpie 里撤回，或在插件市场停用、卸载这个插件，它们就没了；默认模型指着 Magpie 的模型时，按 Plume 的规则落到第一个可用的。
- **出错时**：文件读不了、格式不对时只记一句诊断（不转述文件内容，里面有 key 和令牌），保留上一次读到的；某一条 MCP 服务格式不对或和已有的服务重名时跳过它，保留已有的；网关的 id `magpie` 和你自己的供应商重名时保留你自己的。

技能不经过这个插件：Magpie 直接写进 `~/.plume/skills/`，由 Plume 自带的技能插件发现。

## 用法

1. 在 Plume 的插件市场装上这个插件：装上才有它的数据目录，Magpie 才会列出 Plume。
2. 在 Magpie 里添加 Plume 仓库的 `integrations/magpie`（`magpie plugin add <路径>`，或在 Magpie 的「设置 → 插件」里添加），在 Agent 页给 Plume 选模型，在资源库里选择 Plume 分发指令和 MCP 服务。

使用自定义 `PLUME_HOME` 时，把 Magpie 那边 Agent 插件的 `dir`、`config` 和 `library` 路径一起改成 `<PLUME_HOME>/plugin-data/plume.magpie/` 下对应的绝对路径。
