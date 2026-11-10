# AWS Documentation

AWS Labs 出的，不需要 AWS 账号和凭证。五个工具：search_documentation 搜索，read_documentation 把文档页转成 Markdown 分段读，read_sections 只取指定标题下的章节，search_table 在很长的文档表格里只取匹配的行，recommend 给出与某页相关的其他文档。

AWS 的服务多，配额和参数常改，模型凭记忆给的数字经常过时。先查文档再回答，至少答案有出处。search_table 对配额表、实例规格表这类几百行的表格尤其有用，不用整页读进来。

默认查全球区的文档。AWS 中国区（北京、宁夏）的服务和功能不完全一样，要查中国区，在登录 shell 里 export AWS_DOCUMENTATION_PARTITION=aws-cn 再启动。

## 来源

上游主页：<https://github.com/awslabs/mcp/tree/main/src/aws-documentation-mcp-server>
