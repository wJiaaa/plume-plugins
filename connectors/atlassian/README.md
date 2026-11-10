# Atlassian

社区项目，不是 Atlassian 官方出的，云版和自建的 Server/Data Center 都支持。Jira 这边能用 JQL 搜索、看和建和改 issue、流转状态、记工时、管 Sprint 和看板、处理 Service Desk 请求；Confluence 这边能用 CQL 搜索、读写页面、评论、附件、标签和页面历史。

配了哪个产品就出现哪个产品的工具，什么都不配时它能启动但一个工具都没有。两个都配齐是 98 个工具，只配 Jira 是 63 个，非常占上下文。建议设 TOOLSETS=default，再加 READ_ONLY_MODE=true，实测只剩 16 个核心的读工具。自建版用个人令牌（JIRA_PERSONAL_TOKEN、CONFLUENCE_PERSONAL_TOKEN）代替用户名加 API 令牌。

Atlassian 官方也有远程 MCP 服务，但只能走 OAuth 登录；这个社区版用 API 令牌就能连。

## 需要填写

- `JIRA_URL`（可选）：Jira 地址，比如 https://your-company.atlassian.net；Jira 和 Confluence 至少配一个
- `JIRA_USERNAME`（可选）：Jira 登录邮箱（云版）
- `JIRA_API_TOKEN`（可选）：Atlassian API 令牌（云版）。获取地址：<https://id.atlassian.com/manage-profile/security/api-tokens>
- `JIRA_PERSONAL_TOKEN`（可选）：自建版（Server/Data Center）的个人访问令牌，代替用户名加 API 令牌
- `CONFLUENCE_URL`（可选）：Confluence 地址，云版一般是 https://your-company.atlassian.net/wiki
- `CONFLUENCE_USERNAME`（可选）：Confluence 登录邮箱（云版）
- `CONFLUENCE_API_TOKEN`（可选）：Atlassian API 令牌，和 Jira 的可以是同一个。获取地址：<https://id.atlassian.com/manage-profile/security/api-tokens>
- `CONFLUENCE_PERSONAL_TOKEN`（可选）：自建版的个人访问令牌，代替用户名加 API 令牌
- `TOOLSETS`（可选）：填 default 只开核心工具；不填开全部
- `READ_ONLY_MODE`（可选）：填 true 关掉所有创建、修改、删除的工具

## 来源

上游主页：<https://github.com/sooperset/mcp-atlassian>
