# AGENTS.md

Plume 插件市场里的插件（`plume.` 开头的市场插件）：`plugins/` 下写代码的插件，`skills/` 下的技能合集，`connectors/` 下的连接器（MCP 服务）。三类都按插件发、按插件装，分组和格式见 [docs/distribution.md](docs/distribution.md)。Plume 本体（应用、插件宿主、内置插件、插件 SDK）在另一个仓库，这里只经 npm 上的插件 SDK 和它打交道。

市场发在这个仓库的 GitHub Pages 上，应用从网上读、下载插件；收录清单是根目录的 `marketplace.json`，打包格式、版本规则见 [docs/distribution.md](docs/distribution.md)。

## 插件 SDK

- 这个仓库和本体仓库互不引用，放在哪都行。插件只依赖 npm 上的 `@plumeai/plugin-sdk`（类型、构建、检查、模板和 skill），版本统一写在 `pnpm-workspace.yaml` 的 `catalog`，各插件写 `"catalog:"`；`pnpm install` 就能开发。SDK 的版本跟 Plume 走，要用宿主新加的接口时把 catalog 升到带它的版本。
- 写插件用 skill `plume-plugin`（`.claude/skills/plume-plugin` 链到 `node_modules/@plumeai/plugin-sdk/skill`，装好依赖才有），只靠它和公开接口（`@plume/contract` 的类型、`@plume/ui`、`@plume/styles`），不读宿主的实现。插件要的能力宿主没有，就到本体仓库提改动，不在插件里绕过。
- 和本体联调：应用只读线上市场，这个仓库只是这些插件的源码，没有别的通道。试还没发布的改动和任何插件作者一样：`pnpm plugin dev plugins/<目录名>`（就是 `plume-plugin dev`）把这一个插件装进本机，用法见 skill `plume-plugin`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | 类型检查 + lint + 格式 + 测试 + 市场校验（`pnpm validate`）+ 插件规则（`pnpm check:plugins`）+ 依赖方向（提交前必须通过；pre-push 钩子会跑） |
| `pnpm validate` | 只跑市场校验（`scripts/validate.mjs`）：`marketplace.json` 和 `plugins/`、`skills/`、`connectors/` 对得上，每个插件写了版本、名字、说明、和分组对得上的 `plume.kind`，有 README 和合规的图标；技能合集有技能、连接器的 `.mcp.json` 有服务，搬来的带 LICENSE |
| `pnpm sync-skills [<名字>...]` | 按 `skills/*/package.json` 的 `plume.upstream`（仓库、commit、子目录）从 GitHub 重新搬技能合集的 `skills/` 和 `LICENSE`；不带名字是全部。改了内容要升 `version` |
| `pnpm build:dist` | 把构建好的插件按平台打成发布的静态目录 `dist/`（`scripts/build-dist.mjs`，`--targets` 只打某几个平台，`--published <线上 marketplace.json>` 查版本号没升而内容变了的）；CI（`.github/workflows/publish.yml`）推到 main 时打包、发到 Pages |
| `pnpm check:plugins` | 只跑插件规则（`scripts/check-plugins.mjs`，规则在插件 SDK 的 `lint/`，和 `plume-plugin check` 同一份）：只引用公开接口，颜色、样式只用主题 token 和 Plume 认的 Tailwind 类，界面文字放进 `src/messages.ts`；确实要写死色值的文件（画在 canvas、终端配色这类）第一行写 `// color-exempt：<理由>` |
| `pnpm build:plugins` | 构建 `plugins/` 下的插件（`scripts/build-plugins.mjs`，SDK 的构建） |
| `pnpm knip` | 没人用的导出、依赖和文件（pre-push 钩子会跑） |
| `pnpm plugin init plugins/<目录名>` | 从插件 SDK 的模板新建一个插件（SDK 依赖写成 npm 上的版本号，改成 `"catalog:"` 和别的插件对齐），再 `pnpm install`、`pnpm build:plugins` |

## 约定

- 插件名用小写加点分段，以 `plume.` 开头；插件目录名只用小写字母、数字和连字符（它也是 `plume-plugin://` 的主机名）。
- 插件的版本归插件自己，不跟应用的版本走。发出去的版本不可变：改了插件（构建出来的东西变了）就升 `package.json` 的 `version`，否则 CI 拦下、装过的人也拿不到。
- 新插件要在 `marketplace.json` 里登记。
- 文档、注释用中文；代码标识符用英文。提交信息写成 `<type>(<scope>): <中文主题>`，空一行再写为什么；scope 写插件目录名，检查见 `scripts/check-commit-msg.mjs`。
