# AGENTS.md

Plume 插件市场里的插件（`plume.` 开头的市场插件）。Plume 本体（应用、插件宿主、内置插件、插件 SDK）在另一个仓库。

市场发在这个仓库的 GitHub Pages 上，应用从网上读、下载插件；收录清单是根目录的 `marketplace.json`，打包格式、版本规则见 [docs/distribution.md](docs/distribution.md)。

## 两个仓库并排放

```
plume-project/
├── plume/            本体仓库
└── plume-plugins/    这个仓库
```

- 插件的 `@plume/plugin-sdk`（钩子插件还有 `@plume/platform`）是 `link:` 到 `../plume` 里的目录，不经 npm；本体那边先 `pnpm install`、`pnpm --filter "@plume/plugin-sdk..." typecheck`（生成 SDK 的类型声明），这边再 `pnpm install`。
- 本体反过来从这里找市场插件：构建插件、检查都找 `../plume-plugins/plugins`（本体的 `scripts/market.mjs`）；开发模式和冒烟调用这里的 `scripts/build-dist.mjs` 打一份本机平台的市场，在本机起服务给应用（本体的 `scripts/market-serve.mjs`）。安装包不带市场插件。
- 规范、红线和开发流程都在本体仓库：先读 `../plume/spec/safety.md`，写插件用 skill `plume-plugin`（`.claude/skills/plume-plugin` 链到 `../plume/skills/plume-plugin`），只靠它和公开接口（`@plume/contract` 的类型、`@plume/ui`、`@plume/styles`），不读宿主的实现。插件要的能力宿主没有，就到本体仓库按 spec 改宿主，不在插件里绕过。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | 类型检查 + lint + 格式 + 测试 + 市场校验（`pnpm validate`）+ 本体的样式、文案、插件接口检查（`pnpm check:host`）+ 依赖方向（提交前必须通过；pre-push 钩子会跑） |
| `pnpm validate` | 只跑市场校验（`scripts/validate.mjs`）：`marketplace.json` 和 `plugins/` 对得上，每个插件写了版本、名字、说明，有 README 和合规的图标 |
| `pnpm build:dist` | 把构建好的插件按平台打成发布的静态目录 `dist/`（`scripts/build-dist.mjs`，`--targets` 只打某几个平台，`--published <线上 marketplace.json>` 查版本号没升而内容变了的）；CI（`.github/workflows/publish.yml`）推到 main 时打包、发到 Pages |
| `pnpm build:plugins` | 构建插件（转给本体的 `pnpm build:plugins`，连内置插件一起） |
| `pnpm smoke` | 转给本体的 `pnpm smoke`；改了哪个插件就跑用到它的那几段（`PLUME_SMOKE_ONLY=changed` 会算上这个仓库没提交的改动） |
| `pnpm knip` | 没人用的导出、依赖和文件（pre-push 钩子会跑） |
| `pnpm plugin init plugins/<目录名>` | 从本体仓库里插件 SDK 的模板新建一个插件（依赖写成 `link:` 指回本体的 SDK），再 `pnpm install`、`pnpm build:plugins` |

## 约定

- 插件名用小写加点分段，以 `plume.` 开头；插件目录名只用小写字母、数字和连字符（它也是 `plume-plugin://` 的主机名）。
- 插件的版本归插件自己，不跟应用的版本走。发出去的版本不可变：改了插件（构建出来的东西变了）就升 `package.json` 的 `version`，否则 CI 拦下、装过的人也拿不到。
- 新插件要在 `marketplace.json` 里登记。
- 文档、注释用中文；代码标识符用英文。提交信息的格式见本体仓库的 `spec/tech/commits.md`。
