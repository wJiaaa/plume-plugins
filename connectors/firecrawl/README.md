# Firecrawl

Firecrawl 官方托管的服务。它会真的渲染页面、执行 JavaScript，再把正文抽成干净的 Markdown，所以靠脚本加载内容的页面也读得到——这是它和 Fetch 的主要区别。

不填密钥也能用免费层，这时只有三个工具：firecrawl_scrape 抓单页（也能截图、按给定的 schema 抽 JSON），firecrawl_search 搜索网页、新闻或图片，firecrawl_parse 把 PDF、Word 这类文档解析成 Markdown。填了 FIRECRAWL_API_KEY 之后会多出整站爬取、站点地图、结构化抽取、自主调研等工具。

工具一多会占上下文，只在真要爬整站时再填密钥也是一种用法。自建的 Firecrawl 用不了这个托管地址，要改用 npm 包 firecrawl-mcp 在本机跑。

## 需要填写

- `FIRECRAWL_API_KEY`（可选）：Firecrawl 的 API 密钥；不填只能用抓取、搜索、解析三个工具，而且有速率限制。获取地址：<https://www.firecrawl.dev/app/api-keys>

## 来源

上游主页：<https://github.com/firecrawl/firecrawl-mcp-server>
