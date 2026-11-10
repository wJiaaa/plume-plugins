# Exa

Exa 官方托管的服务，直接连，本机不用跑任何东西。默认两个工具：web_search_exa 搜索并返回清理过的正文，web_fetch_exa 读指定网址的全文。

它按语义匹配：「讲 CRDT 在协同编辑器里怎么落地的工程博客」这种描述性的问题，它比关键词搜索找得准。结果本身就带着正文，模型不用再一个个点开。

不填密钥也能用，有速率限制；填了 EXA_API_KEY 额度更高。按域名、日期过滤的高级搜索和多步调研不在默认工具里，要在地址后面加 ?tools= 参数打开，见它的 README。

## 需要填写

- `EXA_API_KEY`（可选）：Exa 的 API 密钥；不填也能用，只是有速率限制。获取地址：<https://dashboard.exa.ai/api-keys>

## 来源

上游主页：<https://github.com/exa-labs/exa-mcp-server>
