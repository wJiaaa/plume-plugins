# Playwright

微软官方出的 Playwright MCP。它给模型的是页面的无障碍树——元素、角色、可见文本——而不是一张要去认的图。

这意味着两件事：不需要视觉模型也能精确点到第五行第二列那个按钮，以及同一段脚本在不同分辨率下行为一致。

浏览器是它自己起的干净实例，没有你的登录态。要操作需要登录的页面，用 Agent Browser。

## 来源

上游主页：<https://github.com/microsoft/playwright-mcp>
