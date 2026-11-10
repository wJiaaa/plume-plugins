# Git

官方参考实现，12 个工具：status、三种 diff（未暂存、已暂存、任意两个分支或提交之间）、add、commit、reset、log、show、建分支、切分支、列分支。log 可以按时间范围过滤，比如「两周前」到「昨天」。

它只动本机仓库，没有 push、pull、fetch，所以不会影响远端。每次调用都要带上仓库路径；想把它限定在一个仓库里，在参数末尾加上 --repository 和那个仓库的路径。

和让 agent 直接在终端跑 git 的差别：输出是整理过的固定格式，而且能做的只有这十几件事。rebase、改历史、强推这些它一样都没有，这正是它的用处。

## 来源

上游主页：<https://github.com/modelcontextprotocol/servers/tree/main/src/git>
