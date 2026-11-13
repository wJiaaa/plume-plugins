# 市场怎么发出去

Plume 的插件市场是一个静态目录：这个仓库的 CI（`.github/workflows/publish.yml`）把插件构建好、按平台打包，发到 GitHub Pages。应用从 `https://wjiaaa.github.io/plume-plugins/marketplace.json` 读市场，装插件时下载这台机器的那份包，核对后解进 `~/.plume/plugins/<名字>/`。

## 源头：根目录的 marketplace.json

收录清单，每条一个插件：

```json
{ "name": "terminal", "source": "./plugins/terminal" }
```

- `name` 是插件目录名（也是安装目录名、`plume-plugin://` 的主机名），只用小写字母、数字和连字符；三个分组里不能重名。
- `source` 是 `./<分组>/<name>`，分组目录下的每个目录都要登记，登记的都要在。三个分组各放一类，`package.json` 的 `plume.kind` 要和分组对得上，应用的「扩展」页按它摆进对应的一类：

| 分组 | `plume.kind` | 放什么 |
| --- | --- | --- |
| `plugins/` | `plugin`（可不写） | 写代码的插件，pnpm workspace 的包，构建出 `dist/` |
| `skills/` | `skill` | 技能合集：只有 `skills/<技能>/SKILL.md` 和它们带的文件，加上游的 `LICENSE`；`plume.upstream` 记着从哪个仓库的哪个 commit、哪个子目录搬来，`node scripts/sync-skills.mjs [<名字>...]` 按它重新搬一遍 |
| `connectors/` | `connector` | 连接器：只有一份 `.mcp.json`（Claude 格式的 `mcpServers`），要人填的值写成 `${NAME}` 空位，可选的写成 `${NAME:-}`（落空时那个环境变量或请求头整条不发），装上后在应用的连接器卡片上填；README 的「需要填写」列出每一个 |

后两组只有内容、不是 workspace 的包，不用构建；打包时替它们写一个什么都不做的逻辑入口，装上后照常当插件加载，技能插件读它的 `skills/`，MCP 插件读它的 `.mcp.json`。搬来的第三方技能不过 lint、格式和 knip。

市场里显示的说明不写在这里，读自插件自己的 `package.json`：`version`、`description`、`plume.displayName`、`plume.kind`、`plume.category`、`plume.defaultPrompt`（「试试这样问」）、`keywords`、`author`、`homepage`、`license`；图标是插件目录里的 `icon.png`（正方形 PNG，不超过 256 KiB），介绍是 `README.md`，介绍里引用的图放在 `images/` 下。怎么读、怎么校验写在插件 SDK 的 `@plumeai/plugin-sdk/manifest` 里，校验、打包和应用读的是同一份；改格式要改本体仓库里的 SDK、发新版再升这里的版本。

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

平台是 Plume 发安装包的那几个：`darwin-arm64`、`darwin-x64`、`win32-arm64`、`win32-x64`。插件构建时带上了各平台的原生模块（node-pty、koffi 等），打包时每个平台只留自己那份。包里是插件目录下的 `package.json`、`README.md`、`images/`、`icon.png`、`dist/`、`skills/`、`.mcp.json`、`LICENSE`；源码和 `node_modules` 不发，符号链接不发。macOS、Linux 的原生二进制（如 node-pty 的 `spawn-helper`）的执行位由插件 SDK 的构建补上（复制进 `dist/` 时按文件头认出 Mach-O、ELF），不取决于装依赖时跑没跑安装脚本。

`marketplace.json` 里一条：

```json
{
  "name": "terminal",
  "displayName": "终端",
  "description": "…",
  "version": "0.1.0",
  "kind": "plugin",
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
- **发出去的版本不可变。** 改了插件的内容（包括升了插件 SDK、构建出来的东西跟着变）要升 `package.json` 的 `version`。CI 打包时拿线上的 `marketplace.json` 比：版本号没变而指纹变了就失败，不发布。否则装过这个版本的人永远拿不到改动。
- **要发版时才发。** 推到 main 不发布，只校验、打包；在 main 上打一个 tag 推上去才发。tag 和 Plume 本体一样写成 `vX.Y.Z`，版本号是市场自己的、不跟本体走，每次发布在上一个 tag 上往上加（如上一次是 `v0.1.8`，这次 `git tag v0.1.9 && git push origin v0.1.9`）。tag 只标这次发布，插件各自的版本仍看各自的 `version`。
- 每次发布都是整站替换，`dist/` 里是所有插件的当前版本；旧版本的包不留。打包是全量的（几秒），但应用只下载升了版本的插件。

## 本机试

应用只读线上的市场。在本机试一个插件还没发布的改动，和任何插件作者一样用 `pnpm plugin dev plugins/<目录名>`（就是 `plume-plugin dev`），用法见 skill `plume-plugin`。

## 新增一个插件

1. `pnpm plugin init plugins/<目录名>`，写好、`pnpm install`、`pnpm build:plugins`。
2. 在 `marketplace.json` 里登记，写好 `version`、`description`、`plume.displayName`，放上 `icon.png` 和 `README.md`。
3. `pnpm check`，提交，合进 main；要发版时推 `v*` tag，CI 发布。

技能合集和连接器不用第 1 步：建好 `skills/<目录名>/` 或 `connectors/<目录名>/`，写 `package.json`（`private: true`，`plume.kind`、`plume.displayName` 等）、`README.md`、`icon.png`，放进技能（或写好 `plume.upstream` 后跑 `node scripts/sync-skills.mjs <目录名>`）或 `.mcp.json`，再登记。更新搬来的技能：改 `plume.upstream.commit`、跑同步、升 `version`。
