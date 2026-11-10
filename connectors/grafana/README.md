# Grafana

Grafana 官方维护，PyPI 上的包里装的是它的 Go 二进制。工具按类别分：搜索和读写仪表盘、查数据源、跑 PromQL 和 LogQL、看 Tempo 链路和 Pyroscope 性能剖析、管理告警规则和静默、处理事故和值班排班、渲染面板截图、找日志里的错误模式和慢请求。

默认开着 81 个工具，非常占上下文。用不到的类别可以在参数里关掉，比如 --disable-oncall、--disable-incident、--disable-sift；只想读就加 --disable-write，实测剩 65 个。

第一次启用要下载几十兆的二进制，在我们的实测里用了一分钟左右。当前版本不上报使用统计；作者说之后的版本会改成默认上报，到时可以用 --usage-stats disabled 关掉。

## 需要填写

- `GRAFANA_URL`：Grafana 地址，比如 http://localhost:3000 或 https://你的实例.grafana.net
- `GRAFANA_SERVICE_ACCOUNT_TOKEN`：Grafana 服务账号令牌，在 管理 → 用户和访问 → 服务账号 里创建；只读场景给 Viewer 角色即可。获取地址：<https://grafana.com/docs/grafana/latest/administration/service-accounts/>

## 来源

上游主页：<https://github.com/grafana/mcp-grafana>
