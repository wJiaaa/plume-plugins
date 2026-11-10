# Slack

社区项目，不是 Slack 官方出的。能读频道和私信的历史、展开讨论串、搜索消息、列频道、查用户和用户组、看未读和「稍后处理」列表。

发消息、加表情、标记已读默认都是关的，要用得自己打开：发消息设 SLACK_MCP_ADD_MESSAGE_TOOL，可以只对指定的几个频道开放。这是有意为之——让 agent 替你在工作群里说话之前，最好想清楚。

令牌用 xoxp- 开头的用户令牌，它启动时会拿令牌去 Slack 验证，令牌不对就直接退出。README 里还有一种从浏览器里取会话令牌（xoxc/xoxd）的办法，可能违反你所在工作区的规定，这里不推荐。

## 需要填写

- `SLACK_MCP_XOXP_TOKEN`：Slack 用户 OAuth 令牌（xoxp- 开头）：建一个 Slack App，按文档加好用户权限后装到工作区即可拿到。获取地址：<https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md>
- `SLACK_MCP_ADD_MESSAGE_TOOL`（可选）：允许发消息：填 true 对所有频道开放，或填逗号分隔的频道 ID 只对这些频道开放；不填就不能发消息

## 来源

上游主页：<https://github.com/korotovsky/slack-mcp-server>
