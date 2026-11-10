# Supabase

Supabase 官方托管的服务。这里的地址带了 read_only=true：SQL 用只读的数据库角色执行，建项目、跑迁移、部署 Edge Function 这类写操作都不开放。能做的有：列组织和项目，看表、扩展和迁移记录，执行 SQL，查日志，看安全和性能建议（比如哪张表没开 RLS），取项目地址和公开密钥，生成 TypeScript 类型，看 Edge Function 和分支，以及搜 Supabase 文档。

用个人访问令牌认证，它能碰到你账号下的所有项目。只想让它碰一个项目，在地址后面加 &project_ref=<项目 ID>；要开写操作，去掉 read_only=true。

Supabase 自己的建议是：只有任务确实需要生产数据时才连生产项目，并且限定到那一个项目、保持只读。

## 需要填写

- `SUPABASE_ACCESS_TOKEN`：Supabase 个人访问令牌（PAT），在账户设置的 Access Tokens 里生成。获取地址：<https://supabase.com/dashboard/account/tokens>

## 来源

上游主页：<https://github.com/supabase/mcp>
