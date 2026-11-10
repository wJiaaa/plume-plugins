# Notion

Notion 官方的本地版，工具是照着 Notion API 生成的，24 个：按标题搜索，读写页面和块，按 Markdown 整页读取和更新，查询和更新数据库，读写评论，移动页面。

要先在 Notion 里建一个内部集成拿到令牌，再把需要的页面或数据库分享给这个集成——没分享的页面它看不见，这也是控制它能碰什么的办法。

说在前面：Notion 官方现在主推需要浏览器 OAuth 登录的远程版，这个本地版的仓库写明不再积极维护、将来可能下线。它的搜索也只按标题匹配，不是全文。

## 需要填写

- `NOTION_TOKEN`：Notion 内部集成的令牌（ntn_ 开头）；建好集成后还要把页面分享给它，它才看得见。获取地址：<https://www.notion.so/profile/integrations>

## 来源

上游主页：<https://github.com/makenotion/notion-mcp-server>
