# 语言服务

给 agent 一个 `lsp` 工具，经语言服务器回答四件事：

- `references`：一个符号的全部引用，包括 grep 看不到的别名导入（`import { a as b }` 之后写的是 `b`）和重导出链。改签名、改名之前用它找调用方。
- `definition`：它是从哪儿来的，穿过重导出。
- `diagnostics`：一个文件的类型错误，不用跑一次构建。
- `rename`：项目范围的重命名要改哪些地方（只列出来，改还是 agent 用 edit 逐个改）。

另外，agent 的一次调用改了文件之后（edit、write，或者改了文件的命令，以 Plume 记下的改动为准），语言服务器在这些文件里报的错误会附在结果后面：只附错误（不附警告）、只看这次改了的文件、一共最多 10 条，文件没有错误就一个字不加。一次改了超过 5 个语言服务器认的文件（格式化、生成代码这类批量命令）就不看，这时该跑整个项目的检查。

## 怎么用

装上就生效，不用配置。

## 哪些语言

| 语言 | 语言服务器 | 从哪儿来 |
| --- | --- | --- |
| TypeScript / JavaScript | tsserver（TypeScript 6） | 随插件带 |
| Python | basedpyright 或 pyright | 本机装：`pip install basedpyright` 或 `npm i -g pyright` |
| Go | gopls | 本机装：`go install golang.org/x/tools/gopls@latest` |
| Rust | rust-analyzer | 本机装：`rustup component add rust-analyzer` |
| C / C++ | clangd | 本机装：macOS 装 Xcode 命令行工具即带 |

除了 TypeScript，别的服务器都用本机 PATH（登录 shell 里配的那份）上找得到的，装上以后下一次提问就能用，不用重启。找不到时 `references` 退回同语言文件的文本搜索，并告诉 agent 这是文本搜索、缺的是哪台服务器；`rename` 没有服务器时拒绝，不做文本替换。

## 资源

每台服务器第一次被问时才起，起得慢（大项目上的 tsserver 要好几秒）时这一次先给文本搜索的答案；空闲十分钟停掉，下次再问重新起。同一个目录的会话和子会话共用一套，worktree 里的会话各用各的；最后一个用它的会话结束（删掉、归档、换项目、子会话跑完一段）时就停掉，不等空闲。clangd 会在项目里写 `.cache/clangd/index`，这是它自己的行为。

当前项目的其他源文件夹也能查询；项目外的文件和密钥与 read 共用读取授权，符号链接按实际目标判断。语言服务器仍以会话工作目录启动，项目能分析到哪些文件由语言服务器和项目配置决定；`rename` 只返回编辑建议，不改变写入权限或工作树边界。
