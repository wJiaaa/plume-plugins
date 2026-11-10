# Filesystem

MCP 官方的文件系统服务。关键不在于它能读写文件——那件事很多东西都能做——而在于它只能在启动时传给它的那几个目录里读写，越界的路径会被拒绝。

装上后填 FILESYSTEM_DIR，指向你真正想让 agent 碰的那个目录；不填不启动。

## 需要填写

- `FILESYSTEM_DIR`：允许它读写的目录（绝对路径），比如 /Users/you/Documents

## 来源

上游主页：<https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem>
