# Redis

Redis 官方维护。53 个工具，几乎覆盖所有数据结构：字符串、哈希、列表、集合、有序集合、Pub/Sub、Stream、JSON，还有基于 Redis 查询引擎的向量索引与混合检索，以及 info、dbsize、扫描 key、看客户端连接这类运维查询。

Redis 没开也能启动，用到时才去连。连本机的默认实例，REDIS_URL 填 redis://127.0.0.1:6379/0 就行。

工具多意味着每轮对话都要带上这 53 个定义，比较占上下文。只是偶尔看几个 key 的话，让 agent 直接跑 redis-cli 更省。

## 需要填写

- `REDIS_URL`：Redis 连接地址。本机默认是 redis://127.0.0.1:6379/0；有密码写成 redis://:密码@主机:6379/0，要 TLS 用 rediss://

## 来源

上游主页：<https://github.com/redis/mcp-redis>
