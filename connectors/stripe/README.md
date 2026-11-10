# Stripe

Stripe 官方托管的服务。核心是两个通用工具：stripe_api_read 调 Stripe API 的读接口，stripe_api_write 调写接口——只限 Stripe 文档里列出的那一百多个方法，包括建客户、建价格和支付链接、开和作废发票、改和取消订阅、退款。配合 stripe_api_search 和 stripe_api_details 先查方法和参数。另有账户信息、余额汇总、数据分析、文档搜索和集成方案规划。

它动的是真实的钱：退款、改订阅、发发票都会真的发生。先在沙盒里用，密钥只开需要的权限。

Stripe 要求这里用带 Agent 标记的 Agent API key：从 2026 年 10 月 31 日起，完整权限的 secret key 和不带 Agent 标记的受限密钥都会被拒绝。npm 上的 @stripe/mcp 只是这个远程服务的本地转发，所以这里直接连远程。

## 需要填写

- `STRIPE_AGENT_API_KEY`：Stripe 后台创建的 Agent API key（带 Agent 标记），先在沙盒里用，只给需要的权限。获取地址：<https://docs.stripe.com/keys#agent-keys>

## 来源

上游主页：<https://docs.stripe.com/mcp>
