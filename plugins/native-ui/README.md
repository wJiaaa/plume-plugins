# 原生界面块

`plume.native-ui` 把回复正文里的 `ui` 围栏声明画成 Plume 的卡片、表格、图表和表单。安装并启用后立即生效，不需要技能插件。

模型每次请求都会收到简短的 `model.context` 提示，先调用只读工具 `ui_help({})` 获取完整语法。帮助由与校验共用的组件目录生成，不要求模型读取文件或应用内部地址。

## 支持范围

这是一套明确的 JSX 风格声明子集，不是 HTML、React 或任意 JavaScript，也不宣称完整兼容其他界面块实现。

| 用途 | 组件与属性 |
| --- | --- |
| 布局 | `Card(title, subtitle)`、`Stack(gap)`、`Row(gap, align)`、`Grid(cols, gap)`、`Tabs(name?, value?)` / `Tab(title)`、`Each(of, as?, index?)`、`Divider` |
| 文字与读数 | `Text(tone, size)`、`Heading(level)`、`Stat(label, value, delta, hint)`、`Badge(tone)`、`Callout(tone, title)`、`Progress(value, max, label, tone)` |
| 表格 | `Table(columns, rows)` 或 `Table(data, columns?)` |
| 图表 | `Chart(kind, data, x, y, unit, size)`，`kind` 为 `bar/line/area/pie` |
| 输入与选择 | `Input(name, label, placeholder, type, value)`、`Select(name, label, options, value)`、`Choice(name, label, options, value, multiple)`、`Toggle(name, label, value)`、`Slider(name, label, min, max, step, value, unit)` |
| 动作 | `Button(send, set, primary, disabled)`，必须有可见文字 |

属性值用引号或 `{表达式}`，所有组件都接受 `when={表达式}`。`gap` 为 `sm/md/lg`，`align` 为 `start/center/end/between`，`cols` 为 1–6 的最大列数，窄区域自动减少列数。`Heading.level` 为 1–3。`Text.size` 为 `sm/md/lg`，`tone` 为 `muted/strong/accent/info/ok/warning/danger`。文字不解析 Markdown。

表达式支持数字、字符串、布尔值、空值、数组和对象，算术、严格比较、逻辑运算、空值合并、三元选择、成员读取和数组索引。只允许调用 `round/floor/ceil/abs/min/max/sum/avg/len/fixed/fmt/join`。没有 `eval`、动态函数、赋值、方法调用、全局对象或原型访问。完整操作符与函数参数见 `ui_help`。

每个输入的 `name` 必须是唯一的 ASCII 标识符字面量，不能使用原型键、`true/false/null/undefined` 或内置函数名。输入的 `value` 是初始值，不是受控表达式；`value/options/type/multiple/min/max/step` 必须是常量表达式，其他文字和属性可以动态读取状态。单选默认第一个选项，多选默认空数组，开关默认关闭。数字输入在可转换时保留数字，否则保留用户的草稿字符串。滑杆默认 0–100、步长 1、初值为 min；范围、正步长和落在步点上的值都要合法。

`Tabs` 只能直接包含标题不重名的 `Tab`。命名页签把当前标题作为字段状态，标题须为常量；未命名页签只保存浏览位置，不随消息发送。默认打开第一个页签。`Each` 的 `of` 为数组，`as` 默认为 `item`，可用 `index` 声明从零开始的下标。局部名必须是标识符字面量，不能覆盖字段或外层局部名；重复项中的按钮可以读取该项，输入仍按字面量名字共享状态。每次最多 200 项，整块展开最多 4000 节点，超限退回源码，不截断。

表格支持数组行与对象行。数组行必须与列数一致，对象行必须具有相同的键，显式列必须覆盖所有键。单元格只能是字符串、有限数字、布尔值或空值。最多 500 行、30 列，不会静默截断数据。

图表支持分组柱图、多系列折线和面积图、环形饼图、负值、单点、悬停读数、图例及可用键盘展开的原始数据表。`x` 默认首个字符串键，`y` 默认首行所有数字键，也可以显式指定键或键列表。最多 500 点、6 系列，缺数字不会当作零，未指定的对象字段不绘图。数值必须为有限数字或十进制数字字符串，数值范围还必须能形成有限的轴刻度；空数组显示空状态。`size` 为 `sm/md/lg`，图高分别为 140/200/280。面积图填充至零线；饼图按首个系列取值，负数不占扇区，零总和显示 0，整圆也能显示。原始数据表保留所有原值。

## 一段完整示例

```ui
<Card title="陶艺工作坊" subtitle="确认人数与选项后发送报名意向">
  <Row>
    <Input name="seats" label="人数" type="number" value={3}/>
    <Select name="city" label="城市" options={["京都","台南"]}/>
  </Row>
  <Choice name="extras" label="附加项目" multiple options={[{label:"茶点",value:"tea"},{label:"笔记",value:"notes"}]}/>
  <Toggle name="remote" label="远程参加"/>
  <Grid cols={2}>
    <Stat label="估算费用" value={"¥" + seats * 1200} hint="只作估算，不是付款授权"/>
    <Stat label="附加项目" value={len(extras)}/>
  </Grid>
  <Text when={remote} tone="muted">需要提供线上会议链接。</Text>
  <Table data={[{月份:"九月",成品:83},{月份:"十月",成品:100}]}/>
  <Chart kind="bar" x="月份" y="成品" data={[{月份:"九月",成品:83},{月份:"十月",成品:100}]} unit=" 件"/>
  <Chart kind="line" x="月份" y={["成品","目标"]} data={[{月份:"九月",成品:83,目标:91},{月份:"十月",成品:100,目标:94}]} unit=" 件"/>
  <Row>
    <Button send="我想在{city}报名{seats}人陶艺工作坊" primary disabled={seats < 1}>发送报名意向</Button>
    <Button set={{seats:3,city:"京都",extras:[],remote:false}}>重置</Button>
  </Row>
</Card>
```

## 发送和失败边界

- 只有整段围栏及消息成功完成后才能操作。流式阶段展示可解析部分，不能修改或提交；中断、截断、未闭合且不再流式的块退回原始源码。只读视图没有 `send`，全部输入和动作禁用，但图表数据仍可查看。
- `Button set={{name: expression}}` 仅更新已声明状态；`send="…"` 把话和全部当前字段值发到此块所属会话。两者同时存在时先计算新值，再用新值计算发送话术；成功后才提交本地变化，失败时重试仍发送相同值。
- 按钮下方逐字显示将发送的完整消息，包括 `<interface-values>{JSON值}</interface-values>`。它是用户消息的一部分，而不是隐藏数据或另一种界面输入协议。隐藏控件的值也会发送，不应把密钥等敏感数据放进表单。
- 实际发送在真实按钮点击处理器里同步调用宿主 `send(text, event)`，不经过远端工具、不自行写会话。宿主负责真实事件、完成状态和注册有效性校验。
- 发送期间同步锁定整个块。成功后原地显示已发送及实际发送文本，相同文本和值不会再次发送；最后一次成功发送的按钮与回执跨卸载恢复，改值可以产生新的提交。失败原地提示、保留输入，可以重试。
- 未知组件、未知属性、错误表达式、重复声明、数据形状错误和最终不完整声明都会返回宿主 `fallback`，不悄悄丢掉内容。用户编辑产生无法计算的派生值时也显示源码，并提供重置表单按钮恢复初始值。

## 状态、复制和诊断

表单值、命名和未命名页签、最后一次发送回执按会话和声明原文保存在本机 `localStorage`，最多保留最近 200 个块。换会话、重载插件或应用后会恢复；原文改动重新开始。存储满或不可用时当前窗口仍可操作和复制，但不能保证重启后恢复。

回复的复制按钮在点击时读取当前值，输出文字、读数、选择标签，表格与图表转为 Markdown 表格；全部页签均纳入，`when` 隐藏内容和动作按钮不复制。无效块和停用的插件保留源码。宿主只负责按围栏语言调用可选 `copyText`，不解析声明语言。

模型写出的错误组件、属性、表达式、数据及缺围栏的声明，自动在下一条真实用户消息的模型请求副本中附上诊断，最多 8 条去重问题。不会另开一轮，不写入转录，也不改变用户消息原文。

## 主题、动效与边界

控件复用 `@plume/ui` 的 `Input/Select/Segmented/TabStrip/Slider/Toggle/Button`，卡片和文字复用共享组件，颜色、文字层级、圆角和动效只取 Plume token。网格按所在正文宽度布局。表格滚动复用共享 `Scroller`，数字列右对齐。

流式标签未完整时用点阵、扫光和四角手柄占位；完整内容到达后从上向下揭开，表格和图表先描结构轮廓，整体高度平滑增长。共享分段选择滑块、开关和柱图值变化保留过渡；打开已完成的历史块不重放生成动效。减少动态效果由产品统一设置控制。所有动效都在插件内部实现，不引入动画库；描线按实际单元格及图形边界绘制，未实现逐字描线。

不执行任意 HTML、样式属性或模型脚本。点击发送只表示向会话发一句话，不是授权模型执行其他操作。

## 验证和冒烟

本目录的 Node 纯测试覆盖表达式安全、增量解析、严格回退、表格与图表数据、初始状态、动态派生、按钮状态更新、实际消息和值、同步发送锁与失败重试、模型提示和帮助示例。运行 `pnpm --filter @plume-plugins/native-ui test`；类型、样式及接口检查由 `pnpm check` 覆盖，真实 Electron 界面验证是本体仓库的冒烟（这个仓库没有 `pnpm smoke`），在本体仓库用 `PLUME_SMOKE_ONLY=native-ui pnpm smoke` 只跑本功能链。

冒烟可直接使用上面的示例，依次填写人数、切城市、选择附加项目、切换远程，核对读数、显示条件和发送预览；同时检查两种图表和表格。点击发送后核对所属会话收到的完整值、回执和防双击。失败测试可让宿主发送入口第一次拒绝、第二次成功，确认输入不变且能重试。

稳定选择器：

- `[data-native-ui="writing"]`、`[data-native-ui="ready"]`：生成状态。
- `[data-native-ui-field="seats"] input[name="seats"]`：输入；其他字段按自己的 `name` 查找。
- `[data-native-ui-field="city"]`、`[data-native-ui-choice="mode"]`：下拉或单选区域；多选按钮有 `[data-native-ui-option="tea"]`。
- `[data-native-ui-field="remote"] [role="switch"]`：共享开关，若宿主版本使用按钮语义，可在字段内按无障碍名定位。
- `[data-native-ui-chart="bar"]`、`[data-native-ui-chart="line"]`：柱图与折线图（另有 `area`、`pie`）；各自 `details > summary` 打开数据表。
- `[data-native-ui-send="true"]`：发送按钮；`[data-native-ui-preview]`：实际发送文本预览。
- `[data-native-ui-sent]`、`[data-native-ui-receipt]`：成功状态与回执；`[data-native-ui-error]`：发送失败。

边界样例：把图表 `kind` 改成 `scatter`、给 `Text` 加未知属性、加入 `<Unknown/>`、弄错 `Table` 行宽、让表达式读未知变量、把围栏流式中断。完整失败时应显示原始代码而不是部分界面。只读／流式／正在发送时，输入和发送按钮应禁用，编程触发或保存旧按钮引用也不能绕过宿主检查。

视觉验证应覆盖浅色与深色、中文与英文、宽正文与窄列、长标签和长字段值、空表格和空图表、减少动态效果。模型提供的文字与示例数据不会被自动翻译，插件自身状态文案会跟随界面语言。
