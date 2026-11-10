# Hugging Face

Hugging Face 官方托管。不登录也能用，这时有四个工具：搜索模型、数据集和 Space，看仓库详情（下载量、许可证、标签、模型卡），浏览 Hub 上的文件、论文和每日热门，以及查看当前身份。填了 HF_TOKEN 之后，还能按你在 huggingface.co/settings/mcp 里的选择开更多工具和 Space 应用。

挑模型时它比网页搜索直接：下载量、许可证、参数规模、适用任务，查的都是 Hub 上此刻的数据，而不是模型记忆里的。

令牌给只读权限就够了。

## 需要填写

- `HF_TOKEN`（可选）：Hugging Face 访问令牌，只读权限即可；不填以匿名身份使用，工具少一些。获取地址：<https://huggingface.co/settings/tokens>

## 来源

上游主页：<https://github.com/huggingface/hf-mcp-server>
