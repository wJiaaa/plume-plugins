# Kubernetes

社区项目。它连的是本机 kubectl 当前的上下文，用的是你 kubeconfig 里的身份，你在终端里能对集群做什么，它就能做什么。23 个工具：get、describe、logs、apply、create、patch、scale、rollout、切换上下文、查资源文档，Helm 的安装升级卸载，节点的 cordon 和 drain，端口转发，在 Pod 里执行命令，以及一个能跑任意 kubectl 命令的 kubectl_generic。

前提是本机装了 kubectl（用 Helm 相关工具还要装 helm），并且 kubectl get pods 能正常出结果。

ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS=true 会去掉删除、清理、drain、卸载 Helm 和 kubectl_generic 这 5 个工具，但 apply、patch、scale、在 Pod 里执行命令还在——它不等于只读。连生产集群，最稳妥的是给它单独一份只读权限的 kubeconfig。

## 需要填写

- `ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS`（可选）：填 true 去掉删除资源、清理、驱逐节点、卸载 Helm 和执行任意 kubectl 命令这几类工具

## 来源

上游主页：<https://github.com/Flux159/mcp-server-kubernetes>
