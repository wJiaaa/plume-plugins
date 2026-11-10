# Memory

官方实现。存的是实体和它们之间的关系——「这个服务依赖那个队列」「这个人负责这块」——而不是一段流水账，所以取的时候能顺着关系找过去。

适合放长期成立的事实：架构里的固定关系、团队的约定、踩过并且确认过的坑。不适合放这次对话的上下文，那些下次就不成立了。

## 来源

上游主页：<https://github.com/modelcontextprotocol/servers/tree/main/src/memory>
