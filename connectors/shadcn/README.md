# shadcn/ui

shadcn 官方 CLI 自带的 MCP 服务。七个工具：读出项目配置了哪些注册表，列出、搜索、查看组件（含源码），找组件的用法示例，生成对应的 shadcn add 安装命令，以及一份写完界面后的自查清单。

注册表写在项目的 components.json 里，除了官方的 shadcn/ui，也能接公司内部或第三方的注册表。所以它要在已经用 shadcn 初始化过的前端项目里才派得上用场——没有 components.json 时大部分工具会直接报错。

它自己不改代码：查到组件、给出命令，由 agent 去执行安装。

## 来源

上游主页：<https://ui.shadcn.com/docs/mcp>
