# Obsidian

社区项目。它不直接碰笔记文件，而是通过 Obsidian 的社区插件 Local REST API 操作，所以 Obsidian 要开着，并且装好、启用这个插件，端口保持插件默认的 27124。插件设置页里的 API key 填到 OBSIDIAN_API_KEY。

15 个工具：列目录、读单篇和批量读、全文搜索和用 JsonLogic 写复杂条件、按标签找、读 frontmatter、看最近改过的文件、取日记周记这类周期笔记，以及写入。写入分三种：在某个标题、块或 frontmatter 字段处插入，追加到末尾，整篇覆盖。

能按标题定位插入，是它比直接改 Markdown 文件好用的地方。它也能整篇覆盖和删除文件，放手让它改之前先确认仓库有备份。

## 需要填写

- `OBSIDIAN_API_KEY`：Obsidian 社区插件 Local REST API 的密钥，在插件设置页里复制。获取地址：<https://github.com/coddingtonbear/obsidian-local-rest-api>

## 来源

上游主页：<https://github.com/MarkusPfundstein/mcp-obsidian>
