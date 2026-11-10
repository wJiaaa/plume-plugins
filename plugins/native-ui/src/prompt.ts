import { COMPONENTS } from "./catalog.ts";
import { FUNCTIONS } from "./expression.ts";

// i18n-exempt：这是模型提示词和只读帮助工具的输出，不是界面文案。
export const NATIVE_UI_HINT = `Native interface blocks are available through plume.native-ui. Use a fenced \`\`\`ui block for useful figures, tables, bar/line/area/pie charts, or a form the reader can answer. This is a restricted JSX-like declaration language, NOT HTML, React, or executable JavaScript. Before writing one, call ui_help for the exact supported components, properties, expression syntax, and examples. Other components/properties make the WHOLE completed block fall back to source. Do not rely on a skills plugin or undocumented features. Buttons may send only after the whole block and message finish successfully, and only on a real user click.`;

export function uiReference(): string {
	return `# Native UI declarations, supported subset
Use a Markdown fenced code block with language ui. Markup is JSX-like:
<Name prop="text" prop={expression} flag>children</Name>, or <Name/>.
Only quoted or braced attribute values. No HTML, imports, comments in expressions, event handlers, CSS, style, className, JavaScript execution, or template-string interpolation. HTML comments <!-- ... --> are allowed. Quoted strings do NOT process HTML entities or backslash escapes; use an expression string when escaping is needed. A literal < in content must be written as {"<"}.

Text and quoted text/value props support {expression}, including send="Choose {city}". Expressions support finite numbers, strings (single/double/backtick, no interpolation), true/false/null, arrays, objects, parentheses, unary ! + -, + - * / %, == === != !== < <= > >=, && || ??, a ? b : c, a.b, a[i]. Equality is always strict. No assignment, loops, arrow functions, method calls, prototype access, browser/Node globals. Functions: ${Object.keys(FUNCTIONS).join(", ")}.
round(value,digits=0), floor(value), ceil(value), abs(value), min/max/sum/avg(values or array), len(text/array), fixed(value,digits=0), fmt(value,digits?), join(array,separator=", "). fixed/fmt clamp digits to 0–20. Undefined or non-finite results are invalid, use ?? to provide a default. Array indexing supports negative indexes.

Each Input/Select/Choice/Slider/Toggle and named Tabs declares a unique ASCII identifier through a LITERAL name. Names cannot be prototype keys, true/false/null/undefined, or function names. The value prop is INITIAL state, not a controlled expression. value/options/type/multiple/min/max/step must be constants (expressions without state references are fine). Other props/content can read any declared state, even later fields. Input starts at "", Toggle at false, Select and single Choice at the first option, multiple Choice at [], Slider at min (default 0), named Tabs at its first title. Options must have 1–100 distinct nonempty string/number values; object options accept ONLY label and value. Input type=number stores a finite number when possible, otherwise the user's draft string. No hidden numeric coercion at submission.
Every element accepts when={expression}. False hides it but does not erase its state. Even hidden nodes must be valid. Text-only components cannot contain components; leaf components cannot contain children.

Tabs holds only Tab children with distinct nonempty titles. name is optional: unnamed tab selections are local display state and never sent. Named titles must be constant. Each repeats children for of (up to 200 items); as defaults to item, index optionally names the zero-based position. Aliases are literal identifiers, cannot shadow fields or outer aliases, and exist only inside that Each. Repeated inputs with the same literal name share that state. Nested repetition is limited by the whole-block node budget. Slider needs min < max, positive step and a value within range. Progress clamps its displayed percentage to 0–100%.

Components (* required, types explicit):
${Object.entries(COMPONENTS)
	.map(
		([name, spec]) =>
			`${name}(${Object.entries(spec.props)
				.map(([key, prop]) => `${key}${prop.required ? "*" : ""}:${typeof prop.type === "string" ? prop.type : prop.type.join("|")}`)
				.join(" ")}); children=${spec.children}${spec.note ? `; ${spec.note}` : ""}`,
	)
	.join("\n")}

Stat value and delta must be scalar (string, finite number, boolean or null). A positive numeric delta gets +; text starting with +/↑ is positive, -/−/↓ negative.\nTable cells must be string, finite number, boolean or null. rows and data are mutually exclusive. Array rows need columns with matching lengths. Object data must have identical keys and columns, if given, must cover ALL keys. Empty data/rows show an empty state. Maximum 500 rows, 30 columns. Nothing is silently clipped or dropped.
Chart kind defaults to bar. x defaults to the first string key. y defaults to all numeric keys in the first row. Every row must have each selected series and label. Values must be finite numbers or decimal numeric strings (not blank, not comma-formatted). Negative values work. Extra object fields are not plotted unless selected with y. Size sm/md/lg means height 140/200/280. Numeric ranges must admit finite axis ticks; extreme overflow/underflow falls back to source. Empty data shows an empty state. Area fills to zero. Pie is a ring using the first series, with negative values contributing zero; the data table retains original values.

Button requires visible text and send and/or set. set={{existingName: expression}} updates declared state locally. If both are present, compute set first, then evaluate send with those NEW values; commit the local update only after successful delivery, so a failed attempt can retry identical values. Sending shows the exact message and all current named values before the click, including hidden fields. The user message is the words followed by <interface-values>{...}</interface-values> containing JSON values, not a second UI input protocol. Successful identical submissions cannot be sent twice in this block, including after remounting; changing values allows a new submission. Pending submissions lock the block; failures preserve inputs and allow retry. Read-only or incomplete blocks have no usable controls. No automatic submissions.

Boundary: this is an explicit subset, not full compatibility. No arbitrary HTML, scripting, or custom styles. Values, selected tabs and the last successful submission survive unmount/reload/restart in local storage (latest 200 blocks, scoped by session and source; unavailable/full storage cannot persist). Reply copy exports readable words, current values and tables/charts as Markdown tables, includes all tabs, excludes hidden content and buttons. Invalid blocks retain source. Diagnostics are attached to the next real user message in model context only, without starting a turn or changing the transcript. Invalid syntax, unknown names/properties, bad data, and unclosed completed markup show the original source, never a partial successful-looking result. Maximum 50,000 source characters, 64 nested elements, roughly 1,000 markup steps, 4,000 expanded nodes, 4,000 characters per expression. Prefer small blocks; prose stays prose.

Example, interactive form with derived figures and a local reset:
\`\`\`ui
<Card title="Workshop booking" subtitle="Review the values before sending">
  <Row>
    <Slider name="seats" label="Seats" min={1} max={12} value={4}/>
    <Select name="city" label="City" options={["Kyoto","Tainan"]}/>
  </Row>
  <Choice name="extras" label="Extras" multiple options={[{label:"Tea",value:"tea"},{label:"Notes",value:"notes"}]}/>
  <Toggle name="remote" label="Remote attendance"/>
  <Stat label="Estimated total" value={"¥" + (seats * 1200)} hint="Estimate only"/>
  <Text when={remote} tone="muted">A meeting link will be needed.</Text>
  <Row>
    <Button send="Book {seats} seats in {city}" primary disabled={seats < 1}>Send booking request</Button>
    <Button set={{seats:4,city:"Kyoto",extras:[],remote:false}}>Reset</Button>
  </Row>
</Card>
\`\`\`

Example, tabs, repeated content and charts:
\`\`\`ui
<Tabs name="view">
<Tab title="Output">
  <Heading level={1}>Kiln output</Heading>
  <Grid cols={2}>
    <Stat label="Pieces fired" value={183} delta="+17"/>
    <Stat label="Pass rate" value="96.7%"/>
  </Grid>
  <Table data={[{month:"Sep",pieces:83},{month:"Oct",pieces:100}]}/>
  <Chart kind="area" x="month" y={["pieces","target"]} data={[{month:"Sep",pieces:83,target:91},{month:"Oct",pieces:100,target:94}]} unit=" pieces"/>
  <Progress label="Passed inspection" value={96.7}/>
</Tab>
<Tab title="Mix">
  <Chart kind="pie" x="shape" y="pieces" data={[{shape:"Cups",pieces:83},{shape:"Bowls",pieces:100}]}/>
  <Row><Each of={["Glazed","Fired"]}><Badge tone="ok">{item}</Badge></Each></Row>
  <Divider/>
  <Callout title="Next batch"><Text>Wait for the kiln to cool.</Text></Callout>
</Tab>
</Tabs>
\`\`\``;
}
