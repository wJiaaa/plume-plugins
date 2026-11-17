# Magpie

把 [Magpie](https://usemagpie.ai) 资源库分发给 Plume 的全局指令和 MCP 服务交给 Plume。

## 它做了什么

- **全局指令**：Magpie 写进 `~/.plume/plugin-data/plume.magpie/AGENTS.md`。每次调模型前现读，作为单独一段放进系统提示词，排在项目指令前面：项目自己的规矩优先，和设置里写的全局指令一样。最多放 100 KiB，超过的只放开头。
- **MCP 服务**：Magpie 写进同一个目录的 `mcp.json`（Claude 格式的 `mcpServers`）。这个插件把它们登记给 Plume 自带的 MCP 插件，出现在「插件市场 › 连接器」里，标着「由 Magpie 管理」：名称、开关、启动方式、变量和删除都锁住，在 Magpie 里改；连接状态、工具列表、重连和 OAuth 登录照常。Magpie 改了文件当场重连，不用重启。
- **不留副本**：指令和服务都不抄进 Plume 自己的设置。在 Magpie 里撤回，或在插件市场停用、卸载这个插件，它们就没了。
- **出错时**：`mcp.json` 读不了、格式不对时只记一句诊断（不转述文件内容，里面可能有令牌），已经连上的服务保持原样；某一条服务格式不对或和已有的服务重名时跳过它，保留已有的。

技能不经过这个插件：Magpie 直接写进 `~/.plume/skills/`，由 Plume 自带的技能插件发现。

## 用法

1. 在 Plume 的插件市场装上这个插件。
2. 在 Magpie 的资源库里选择 Plume，分发要用的指令和 MCP 服务。Magpie 用的是 Plume 仓库里的 Agent 插件 `integrations/magpie`，它已经指向这个插件的数据目录。

使用自定义 `PLUME_HOME` 时，把 Magpie 那边 Agent 插件的路径一起改成 `<PLUME_HOME>/plugin-data/plume.magpie/` 下对应的绝对路径。
