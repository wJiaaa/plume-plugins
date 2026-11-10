# Fetch

官方参考实现，只有一个工具 fetch：给它一个 URL，它把网页的 HTML 抽成 Markdown。长页面会被截断，模型可以带着 start_index 接着往下读，直到找到需要的内容。

它不开浏览器，也不执行 JavaScript，所以又快又轻；代价是靠脚本渲染出来的页面它读不到正文，要登录的页面也拿不到——那些交给 Firecrawl、Playwright 或 Agent Browser。

默认遵守 robots.txt。它能访问本机和内网地址，官方 README 专门对此提了警告：内网里有不该让模型看到的东西时，装之前想一想。

## 来源

上游主页：<https://github.com/modelcontextprotocol/servers/tree/main/src/fetch>
