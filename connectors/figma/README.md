# Figma

社区项目 Framelink，不是 Figma 官方出的。两个工具：get_figma_data 按文件或节点的链接取回设计数据，download_figma_images 把稿子里的图片和图标下载到本地。

它不是把截图丢给模型，而是通过 Figma API 取回结构化的设计数据，把布局、间距、颜色、字体、组件层级精简成模型读得动的格式。精确的数值比看图猜像素靠谱。

只需要一个个人访问令牌，不用开着 Figma 桌面端。用法是把某个画板或组件的链接直接贴给 agent。

## 需要填写

- `FIGMA_API_KEY`：Figma 个人访问令牌，在 Figma 的设置 → 安全 → 个人访问令牌里生成，给文件内容读权限即可。获取地址：<https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens>

## 来源

上游主页：<https://github.com/GLips/Figma-Context-MCP>
