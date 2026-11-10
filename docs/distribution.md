# 市场怎么发出去

Plume 的插件市场是一个静态目录：这个仓库的 CI（`.github/workflows/publish.yml`）把插件构建好、按平台打包，发到 GitHub Pages。应用从 `https://wjiaaa.github.io/plume-plugins/marketplace.json` 读市场，装插件时下载这台机器的那份包，核对后解进 `~/.plume/plugins/<名字>/`。

## 源头：根目录的 marketplace.json

收录清单，每条一个插件：

```json
{ "name": "terminal", "source": "./plugins/terminal" }
```

- `name` 是插件目录名（也是安装目录名、`plume-plugin://` 的主机名），只用小写字母、数字和连字符。
- `source` 固定是 `./plugins/<name>`。`plugins/` 下的每个目录都要登记，登记的都要在。

市场里显示的说明不写在这里，读自插件自己的 `package.json`：`version`、`description`、`plume.displayName`、`plume.category`、`plume.defaultPrompt`（「试试这样问」）、`keywords`、`author`、`homepage`、`license`；图标是插件目录里的 `icon.png`（正方形 PNG，不超过 256 KiB），介绍是 `README.md`，介绍里引用的图放在 `images/` 下。

`pnpm validate` 查这些（`pnpm check` 包含它）。

## 发出去的目录

`pnpm build:dist`（`scripts/build-dist.mjs`）打到 `dist/`：

```
marketplace.json                            收录的插件、说明和每个平台的包
assets/<name>/icon.png                      图标
assets/<name>/README.md、images/            介绍和它引用的图
plugins/<name>/<version>/<平台>-<架构>.tgz   装下的文件
.nojekyll                                   让 Pages 不按 Jekyll 处理
```

平台是 Plume 发安装包的那几个：`darwin-arm64`、`darwin-x64`、`win32-arm64`、`win32-x64`。插件构建时带上了各平台的原生模块（node-pty、koffi 等），打包时每个平台只留自己那份。包里是插件目录下的 `package.json`、`README.md`、`images/`、`icon.png`、`dist/`、`skills/`；源码和 `node_modules` 不发，符号链接不发。

`marketplace.json` 里一条：

```json
{
  "name": "terminal",
  "displayName": "终端",
  "description": "…",
  "version": "0.1.0",
  "category": "工具",
  "icon": "assets/terminal/icon.png",
  "readme": "assets/terminal/README.md",
  "builds": {
    "darwin-arm64": { "path": "plugins/terminal/0.1.0/darwin-arm64.tgz", "sha256": "…", "size": 2712345, "fingerprint": "…" }
  }
}
```

路径都相对 `marketplace.json`。应用下载包后核对 `size` 和 `sha256`，对不上不装；`fingerprint` 是包里文件的路径和内容算出的指纹，只给发布时比对用。

## 版本和更新

- 应用按版本号判断有没有更新：目录里的版本比装着的新，就是有更新（自动更新开着时直接换上）。
- **发出去的版本不可变。** 改了插件的内容（包括本体的插件 SDK 变了、构建出来的东西跟着变）要升 `package.json` 的 `version`。CI 打包时拿线上的 `marketplace.json` 比：版本号没变而指纹变了就失败，不发布。否则装过这个版本的人永远拿不到改动。
- 每次发布都是整站替换，`dist/` 里是所有插件的当前版本；旧版本的包不留。打包是全量的（几秒），但应用只下载升了版本的插件。

## 本机试

本体仓库的 `pnpm dev`、`pnpm smoke` 会调用这里的 `build-dist.mjs`，只打本机平台，在本机起一个服务，经 `PLUME_MARKET_URL` 让应用从它装插件，和装线上的走同一条路（`plume/scripts/market-serve.mjs`）。要连线上的市场开发，启动前设 `PLUME_MARKET_URL=https://wjiaaa.github.io/plume-plugins/marketplace.json`。应用只接受 https 和本机（127.0.0.1、localhost）的 http 地址。

## 新增一个插件

1. `pnpm plugin init plugins/<目录名>`，写好、`pnpm install`、`pnpm build:plugins`。
2. 在 `marketplace.json` 里登记，写好 `version`、`description`、`plume.displayName`，放上 `icon.png` 和 `README.md`。
3. `pnpm check`，提交，合进 main 后 CI 发布。
