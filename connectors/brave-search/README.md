# Brave Search

Brave 官方维护。背后是 Brave 自己爬取和维护的搜索索引，不是转卖别家的结果。八个工具：网页、新闻、图片、视频搜索，本地商户和地点搜索，把结果压成摘要的 summarizer，以及专门给模型整理上下文的 llm_context。

需要 Brave Search API 的密钥，没有密钥时服务直接退出。有些能力跟套餐走：完整的本地商户搜索要 Pro 套餐，否则退回普通网页搜索；摘要属于另一类 Answers 套餐。

和 DuckDuckGo 那条比：这里是正式 API，稳定、有额度保证、结果类型多；那条免费免注册，但会被限速。

## 需要填写

- `BRAVE_API_KEY`：Brave Search API 的密钥，注册 API 账号、选好套餐后在控制台生成。获取地址：<https://brave.com/search/api/>

## 来源

上游主页：<https://github.com/brave/brave-search-mcp-server>
