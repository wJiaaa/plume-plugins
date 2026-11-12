# IM 机器人

这个插件先提供微信、飞书和 Telegram 的配置入口，为后续聊天平台接入准备安全存储。

当前版本支持：

- 微信：iLink 服务地址、Bot Type、登录令牌。
- 飞书：App ID、App Secret、服务地域。
- Telegram：Bot Token。
- 每个平台独立启用或停用配置。

当前版本**不会连接平台、收发消息，也不会创建或映射 Plume 会话**。后续平台接入可复用这里的配置。

凭据保存在插件私有数据目录的 `settings.json`，文件权限为 `0600`，凭据那几格经 Plume 给插件的密钥加密（`ctx.secrets`）加密成密文；加密用的钥匙丢失或换过、解不开时当作没填，重新填即可。设置界面不会读取或回显密钥，只显示是否已经保存；密钥不会进入渲染进程、模型上下文或日志。

## 使用

安装并启用 `plume.im` 后，在「扩展」里点开「IM 机器人」，在详情的「设置」一节填入对应平台配置。文本框失去焦点时保存新密钥，清除按钮会删除已保存的密钥。

平台侧准备：

- 微信使用 iLink Bot 的服务地址和登录令牌；后续版本会补充扫码登录。
- 飞书使用开放平台应用的 App ID、App Secret，并选择服务地域。
- Telegram 使用 BotFather 生成的 Bot Token。

## 验证

仓库内运行：

```sh
pnpm --filter @plume-plugins/im typecheck
pnpm --filter @plume-plugins/im test
```
