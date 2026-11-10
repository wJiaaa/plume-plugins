# MarkItDown

微软出的，只有一个工具 convert_to_markdown：给它一个 file:、http(s): 或 data: 开头的地址，它把内容转成 Markdown。支持 PDF、Word、Excel、PowerPoint、HTML、CSV、JSON、XML、EPUB、ZIP 包，还能取 YouTube 视频的字幕。

转出来的 Markdown 保留了标题、列表和表格，比把 PDF 抽成纯文本好读得多。它能读这台机器上当前用户能读的任何文件。音频文件会被送到 Google 的在线语音识别去转写，处理敏感录音前留意这一点。

依赖很多，第一次启用要下载七十多个包，在我们的实测里用了两分多钟，多半会超过连接超时——失败了等一会儿再开一次，之后启动只要两三秒。

## 来源

上游主页：<https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp>
