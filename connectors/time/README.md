# Time

官方参考实现，两个工具：get_current_time 取某个时区的当前时间，convert_time 把一个时间从一个时区换算到另一个。时区用 IANA 名字，比如 Asia/Shanghai、America/New_York；不指定时按本机的系统时区。

模型自己不知道现在是几点——它的「现在」停在训练截止那天。排期、算离截止还剩多久、对日志里的时间戳、约跨时区的会，都需要一个准的当前时间。

想固定用某个时区、不跟着系统走，在参数里加 --local-timezone=Asia/Shanghai。

## 来源

上游主页：<https://github.com/modelcontextprotocol/servers/tree/main/src/time>
