# GitHub

GitHub 官方托管的服务，连的是 api.githubcopilot.com，本机不用跑任何东西。默认工具集是仓库与文件、issue、PR 与评审、用户和当前上下文；Actions、代码扫描、Discussions、Projects、通知这些是另外的工具集，要用得自己开：填 GITHUB_TOOLSETS，比如 default,actions。

用个人访问令牌认证，令牌能做什么它就能做什么。建议用 fine-grained 令牌，只给需要的仓库和权限；只想让它读、不让它写，GITHUB_READ_ONLY 填 true。组织的仓库还可能受组织的 MCP 策略限制。

和 Git 那条的分工：Git 管本机仓库里的提交和分支；这条管 GitHub 上的东西——别人的仓库、issue、PR 评审。

## 需要填写

- `GITHUB_PERSONAL_ACCESS_TOKEN`：GitHub 个人访问令牌，建议用 fine-grained 令牌，只勾需要的仓库和权限。获取地址：<https://github.com/settings/personal-access-tokens/new>
- `GITHUB_TOOLSETS`（可选）：开哪些工具集，逗号分隔，比如 default,actions；不填是默认那几组
- `GITHUB_READ_ONLY`（可选）：填 true 只留读的工具

## 来源

上游主页：<https://github.com/github/github-mcp-server>
