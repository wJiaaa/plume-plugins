# MongoDB

MongoDB 官方维护。这里默认带了 --readOnly，只开读的工具：列出库和集合、推断集合的 schema、看索引和存储大小、find、count、聚合、explain 执行计划、导出查询结果、看 mongod 的日志，还能查 MongoDB 官方的知识库。

要写数据（插入、更新、删除、建索引），去掉参数里的 --readOnly。要管 Atlas 本身（建集群、管用户）得另配 Atlas 的服务账号，见它的 README。它默认会向 MongoDB 发匿名使用数据，参数里加 --telemetry disabled 可以关掉。

它的依赖很多：在我们的实测里，第一次启动用了一分多钟，之后每次启动也要十几秒。第一次开启如果超时，稍等再开一次。

## 需要填写

- `MDB_MCP_CONNECTION_STRING`：MongoDB 连接串，mongodb:// 或 mongodb+srv:// 开头。获取地址：<https://www.mongodb.com/docs/manual/reference/connection-string/>

## 来源

上游主页：<https://github.com/mongodb-js/mongodb-mcp-server>
