# DBHub

Bytebase 出的通用数据库服务。默认只有两个工具：execute_sql 执行 SQL，search_objects 按需逐层查看库、表、列、索引和存储过程——不会一上来就把整个 schema 塞进上下文，库再大也只取需要的那部分。

连接串填在 DSN 里，协议头决定数据库类型，还能经 SSH 跳板机连接，见它的命令行文档。它默认可以写：连重要的库之前，要么用只读账号，要么写一份 dbhub.toml，把工具设成 readonly、限定最大返回行数，再用 --config 启动。

它依赖 Node 22.5 以上自带的 SQLite 模块，Node 版本低了起不来。依赖里带着各家数据库的驱动，第一次启用要下载一阵，在我们的实测里用了五十多秒。

## 需要填写

- `DSN`：数据库连接串，协议头决定类型：postgres://、mysql://、mariadb://、sqlserver://、oracle://；SQLite 写成 sqlite:///Users/me/app.db 这样。获取地址：<https://dbhub.ai/config/command-line>

## 来源

上游主页：<https://github.com/bytebase/dbhub>
