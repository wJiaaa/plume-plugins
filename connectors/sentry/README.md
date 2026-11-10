# Sentry

Sentry 官方托管的服务。能列组织和项目，用自然语言或 Sentry 的查询语法搜 issue 和事件，按链接取回 issue、事件、Trace 的详情和完整堆栈，调 Sentry 自己的 Seer 分析根因并给出修复建议，以及把 issue 标成已解决、忽略或指派给人。不常用的操作不直接摆出来，而是先用 search_sentry_tools 查、再用 execute_sentry_tool 调，省上下文。

这里用显式令牌：请求头写的是 Sentry-Bearer 而不是 Bearer，这是 Sentry 的约定，改了就连不上。

自建的 Sentry 连不了这个托管地址，要改用 npm 包 @sentry/mcp-server 在本机跑，并传 --host。它的许可证是 FSL，源码公开，但不是 OSI 意义上的开源。

## 需要填写

- `SENTRY_ACCESS_TOKEN`：Sentry 用户令牌，需要 org:read、project:read、project:write、team:read、team:write、event:write 权限。获取地址：<https://sentry.io/settings/account/api/auth-tokens/>

## 来源

上游主页：<https://github.com/getsentry/sentry-mcp>
