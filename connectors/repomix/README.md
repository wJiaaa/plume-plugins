# Repomix

Repomix 本身是个命令行工具，加上 --mcp 就是 MCP 服务。六个工具：pack_codebase 打包本机目录，pack_remote_repository 直接拉一个 GitHub 仓库来打包，read_repomix_output 和 grep_repomix_output 分段读、按正则搜打包结果，attach_packed_output 接上已有的打包文件，generate_skill 把一个代码库写成技能文档。

打包时按 .gitignore 过滤，报告 token 数，可以用 Tree-sitter 压成只剩签名和结构的版本，还会用 Secretlint 扫一遍，免得把密钥一起打进去。适合「先让模型把整个项目看一遍」的场合，比一个文件一个文件地读省轮次。

它能读当前用户能读的任何目录。想把它关在一个目录里，参数末尾加 --sandbox 和那个目录。需要 Node 22 以上。

## 来源

上游主页：<https://github.com/yamadashy/repomix>
