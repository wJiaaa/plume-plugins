# 网页预览

把 HTML 小工具、游戏和演示直接放进回复。页面跟随应用主题，按内容调整高度；长页面可展开，也能移到面板中操作。

安装后，Agent 可使用 `preview`：

- 传 `html`、`files` 或本地 `.html` 的 `path`。只保存提供的文件快照，不开放项目目录；修改源文件后需重新调用。
- 传 `check: true` 先检查，返回截图、脚本异常、控制台错误和高度。`width` 可检查窄屏；长页用返回的 `id` 加 `check: true, from` 检查下一段。
- 确认后只传 `id` 发布；抛出异常或检查未完成的页面不会发布。
- 页面使用 `plume.state` / `plume.setState(value)` 保存最多 16 KB JSON。重新运行、切换会话或重启后恢复，改动在下一条人工消息中作为页面数据交给 Agent。

页面运行在独立沙箱中，没有 Node、应用接口或磁盘访问能力。CSS、JavaScript 和图片应内联、随 `files` 提供，或使用 HTTPS 地址。页内按钮可以通过受用户点击约束的 `plume.send` 发送选择。

停用后卡片回到工具结果，重新启用恢复预览；删除会话时一并删除页面及状态。检查需要桌面应用提供的隐藏页面检查能力。

## 草稿与设计旋钮

模型先写样式、正文，最后写脚本。参数生成时显示不执行脚本、不加载远程资源的静态草稿；检查到同轮发布之间保留原位置，失败或未发布结束后收起。

页面通过 `plume.tweak` 绑定设置对象，控件在页面下方显示。拖动即时改变当前页面，只有点击「发送修改」才调用模型；支持复位与对照原版。

```js
const settings = { size: 24, color: "#339cff", enabled: true, layout: "grid" };
plume.tweak({ label: "布局", onChange: draw })
  .slider(settings, "size", { label: "字号", min: 12, max: 48, step: 1, unit: "px" })
  .color(settings, "color", { label: "颜色" })
  .toggle(settings, "enabled", { label: "显示说明" })
  .select(settings, "layout", { label: "排列", options: ["grid", "list"] });
```

每页至多 12 组、每组 12 个控件、每个下拉 12 个选项。重新运行恢复初始旋钮，页面需要持久化的交互仍使用 `plume.setState`。

## 页内发送与整页复制

`plume.send(text)` 在真实点击或表单提交处理器里同步调用，最多 2000 字符。按钮须说明要发送什么。加载、计时器、程序点击及侧边面板中返回 `false`，只读会话不能发送；宿主另校验 iframe 来源、用户激活和重复事件。

```js
button.onclick = () => plume.send("按当前选择继续生成。");
```

「复制整页」把当前交互后的页面分片拼成 PNG，保留页面状态，恢复原来的显示高度；不会重新加载页面。复制时保持页面可见，超过 Chromium 画布高度上限（32767 图像像素）会明确报错。
