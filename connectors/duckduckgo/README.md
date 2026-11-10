# DuckDuckGo

社区实现，不是 DuckDuckGo 官方出的。三个工具：search 搜索，fetch_content 把网页正文抽出来，expand_link 把结果里缩短的链接还原成完整地址。

它的好处是零配置，装上就能搜。代价是它抓的是 DuckDuckGo 的网页结果而不是正式 API：自带限速（默认每分钟 30 次搜索、20 次抓取），被风控时会失败，结果的质量和数量也比不上付费的搜索 API。

想要稳定的额度和更多结果类型，用 Brave Search 或 Tavily。

## 需要填写

- `DDG_REGION`（可选）：默认搜索区域，比如 cn-zh、us-en；不填按 DuckDuckGo 的默认

## 来源

上游主页：<https://github.com/nickclyde/duckduckgo-mcp-server>
