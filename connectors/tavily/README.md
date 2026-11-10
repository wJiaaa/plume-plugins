# Tavily

Tavily 官方维护。五个工具：tavily_search 搜索，tavily_extract 从给定网址抽正文，tavily_crawl 从一个起点顺着链接爬一片页面，tavily_map 只列出站点的页面结构、不取内容，tavily_research 做多步调研并给出带来源的结论。

搜索结果直接带着抽好的正文，模型不用再逐个打开链接。crawl 和 map 适合「把这个文档站整个读一遍」这类任务，只会搜索的工具做不到。

需要 Tavily 的 API 密钥。不填密钥服务也能启动，但每次调用都会失败。

## 需要填写

- `TAVILY_API_KEY`：Tavily 的 API 密钥，注册后在控制台里拿。获取地址：<https://app.tavily.com>

## 来源

上游主页：<https://github.com/tavily-ai/tavily-mcp>
