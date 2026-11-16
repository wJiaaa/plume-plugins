// color-exempt：审阅流程正文里举例的 PR 编号（#123），不是颜色
/**
 * `/review` 的正文：审未提交的改动、一个 PR 或几个文件，按力度决定派多少子智能体。正文写给模型看，所以是英文。
 *
 * 写代码的对话不审自己，但也不把审阅交给另一个会话：找问题、复核都交给子智能体（它们只拿到 diff 和 `review/intent.md`，
 * 看不到这个对话的推理），这个对话只派发、合并、决定修哪几条、自己修。各力度都至少派一个 `review`，没有派子智能体的工具时不审。
 * 它可能把发现轻轻放过：所以发现照子智能体写的原样列出，这个对话不许凭自己读代码删掉一条，不修的写明理由
 * （子智能体面板里原始报告人随时对得上）；只有复核的子智能体能驳掉一条。
 *
 * 第 0 步按「有没有 `review_brief`」分流：它只列给侧栏里的会话。子智能体、侧边聊天派不了子智能体：改动是它自己写的就不审、
 * 叫人回主会话敲；不是它写的（侧边聊天看主会话的改动）就自己按 low 审一遍、只报告不修。
 * 正文点名的别的插件的工具不写死名字：派子智能体的按工具声明的类别 `delegate`、问人的按 `question` 现找（`BodyTools`）。
 * `review`、`verify` 是子智能体的名字（人看得见、能用同名文件覆盖），照写。并发写死成 4，跟着子智能体的默认名额。
 */

import { REVIEW_BRIEF } from "./types.ts";

export const REVIEW_ARGUMENT_HINT = "[PR | URL | path] [--effort low|medium|high] [--comment]";

/** 正文要点名的别的插件的工具，按工具声明的类别在工具表里现找；没有就不给。 */
export interface BodyTools {
	/** 派子智能体的工具（类别 `delegate`）。 */
	delegate?: string;
	/** 停下来问人的工具（类别 `question`）。 */
	question?: string;
}

/** 第 4 步的力度：有派子智能体的工具时三档和子智能体的提示词；没有时这个对话不审（第 0 步）。 */
function levels(delegate: string | undefined): string {
	if (!delegate)
		return `There is no tool here for dispatching sub-agents. In the conversation that wrote the change, stop as step 0 says; anywhere else, review it yourself as step 0, case 3 says.`;
	return `If you do not have the \`${delegate}\` tool here, follow step 0 for that case instead.

Dispatch every sub-agent of a batch in one reply. \`${delegate}\` returns at once and each result arrives later as a message that starts your next turn: after dispatching, end your turn with one line saying who you are waiting for, and carry on from where you were when they have all reported. Never read the diff hunk by hunk yourself in place of a finder.

**low** — one \`review\` finder for A, B and C — and E, when it applies — together, using the finder prompt below with all of those dimensions listed.

**medium** — three \`review\` finders, one each for A, B and C — four, with E, when it applies.

**high** — at most four sub-agents per reply; wait for a batch to report before sending the next.
1. Batch one: four \`review\` finders, one each for A, B, C and D.
2. Batch two: the E finder when it applies, one \`verify\` sub-agent (prompt below) — only when the working tree holds the code under review; for a PR that is not checked out, skip it and say so in the report — and one \`review\` checker per finding, up to four in all.
3. Further batches of up to four checkers until every finding, E's included, has been checked.

If dispatching \`review\` is refused because that sub-agent is turned off or unavailable, tell the person \`/review\` needs it (Settings › Agents) and stop. Do not review the change yourself instead.

**Finder prompt** — fill in the brackets; the sub-agent knows nothing else:

\`\`\`
Review a code change for <one dimension | these dimensions>: <letter and name of each>.
Change: <local uncommitted changes | PR #<n> "<title>", base <base> | these files>.
Diff (read all of it first): <absolute path to review/diff.patch or review/files.txt>
Project rules: <absolute path to review/rules.md, or "none">
<with review/intent.md: Context (read before the diff): <its absolute path>. Background, constraints and intent for this dimension: <two or three sentences — why the change was made, the person's decisions that bear on it, what they wanted from this part>. The person's words and decisions outrank the plan; the author's notes in that file are claims to check, not facts.>
Repository: <absolute path>. <The working tree is | is not> the reviewed version<; if not, read changed code from the diff and whole files with git show <sha>:<path>>.

Look for: <each dimension's paragraph from these instructions, verbatim>

Report only concrete defects you can tie to a line and a triggering scenario. No style, naming, formatting or "consider" suggestions; nothing about untouched code unless the change breaks it. Read the callers and surrounding code before reporting — a claim one more file would disprove is not a finding. Do not modify files, and do not run builds or tests.
Return findings with file as path:line in the new version (for E, when nothing in the diff corresponds, the request, decision or plan item instead), a one-sentence problem, and failure: the concrete input or state and what goes wrong. Return no findings, and say so, if you found none.
\`\`\`

**Checker prompt** — one finding per checker:

\`\`\`
Someone claims this defect exists. Try to disprove it.
Claim: <file:line> — <problem>
Trigger: <failure>
Diff: <absolute path>. Repository: <absolute path>. <Working tree note as above.>
<with review/intent.md: Context: <its absolute path>, with the background, constraints and intent that bear on this claim in a sentence or two.>

Read the code at that location and everything the claim depends on: callers, guards, types, configuration, tests. If a guard, invariant or caller makes the trigger impossible, return no findings and say in the summary exactly what prevents it. If the claim holds, return it as one finding, corrected: exact line, sharper trigger. Do not modify files.
\`\`\`

**Verify prompt**:

\`\`\`
Run this project's checks for a change and report the results. Do not fix anything.
Repository: <absolute path>. Changed files: <list>. Project rules: <path or "none">.
Work out the commands from the project rules and the package manifests: the typecheck of each affected package and the tests that cover the changed files. Prefer the narrowest commands that cover them over whole-repository runs.
\`\`\``;
}

/** `/review` 的正文，`tools` 是此刻工具表里按类别找到的那几件。 */
export function reviewBody({ delegate, question }: BodyTools): string {
	// 正文是一整段模板字符串，分支先算好再填进去：里面再套反引号会把插件检查认字符串的那一步带偏。
	const askWith = question ? `with \`${question}\`` : "in one message and end your turn; carry on when they answer";
	const askToPost = question
		? `call \`${question}\` with the options "Post this comment" and "Do not post"`
		: `ask whether to post it — "Post this comment" or "Do not post" — and end your turn`;
	// i18n-exempt：正文发给模型。
	return `# Code review

You are running the \`/review\` pipeline. The person's arguments follow these instructions. Follow the steps in order; do not skip one because the change looks small.

## 0. Where the review runs

A reviewer that shares the reasoning that produced a change tends to agree with it. So the conversation that wrote the change does not look for defects itself: \`review\` sub-agents find them and check them, knowing only the diff and the brief. This conversation dispatches them, merges what comes back, decides what to fix and fixes it. The first case that applies decides.

1. **You have the \`${REVIEW_BRIEF}\` tool** (a conversation of your own in the app): run steps 1 to 8 here, dispatching sub-agents as step 4 says. If you have no tool for dispatching sub-agents, do not review the change yourself: tell the person \`/review\` needs the sub-agents (Settings › Agents) and stop.
2. **You do not have it, and this conversation wrote or changed the code under review** (a sub-agent doing the work, for one): do not review it. Say that a review by whoever wrote the change only agrees with itself, tell the person to send \`/review\` in the main conversation — the changes are in the same working tree, so it can dispatch reviewers on them — and stop.
3. **Otherwise** (a side chat looking at the main conversation's work, the command line): review it yourself as **low** — read the diff and the code around each hunk and go through A, B and C. Run steps 1, 2 and 3 (without the brief), then write the step 6 report without Decision lines: every finding is PLAUSIBLE, and the report says no separate reviewer ran. Fix nothing unless the person asks you to; \`--comment\` works as step 8 says.

## 1. Arguments

\`/review [target] [--effort low|medium|high] [--comment]\`

- **target**: none → the uncommitted local changes. A number, \`#123\`, or a GitHub pull request URL → that PR. Anything else → one or more file paths in the project.
- **--effort**: when absent, \`medium\` for local changes and files, \`high\` for a PR. Any other value: say the accepted values and stop.
- **--comment**: post the report to the PR (step 8). On a target that is not a PR, say it is ignored and carry on.

Say the resolved target and effort in one line, then start.

## 2. Scope and diff

Keep every intermediate file under \`review/\` in your scratch directory (its absolute path is in your context). Sub-agents start with nothing; they read these files by absolute path.

**Local changes**
1. \`git rev-parse --show-toplevel\`. Not a repository: say so and stop.
2. \`git diff HEAD > <scratch>/review/diff.patch\`. In a repository without commits, use \`git diff --cached\` and \`git diff\` instead.
3. Untracked files: \`git ls-files --others --exclude-standard\`. Append each with \`git diff --no-index -- /dev/null <file>\` (exit code 1 is expected). Leave out binaries and generated files (lockfiles, build output), and list what you left out.
4. If the diff is empty, tell the person there are no uncommitted changes to review and stop. Dispatch nothing.

**Pull request**
1. \`gh --version\`, then \`gh auth status\`. If \`gh\` is missing or not logged in, say which, say how to fix it (install the GitHub CLI / run \`gh auth login\`), and stop. Never reconstruct the diff some other way: no guessing the base branch, no fetching refs by hand.
2. \`gh pr view <target> --json number,title,body,url,baseRefName,headRefName,headRefOid,files\`, saved to \`review/pr.json\`.
3. \`gh pr diff <target> > <scratch>/review/diff.patch\`.
4. Compare \`git rev-parse HEAD\` with \`headRefOid\`. Equal means the working tree is the PR's code. Otherwise it is not: read changed code from the diff, read whole files with \`git show <headRefOid>:<path>\` only if \`git cat-file -e <headRefOid>\` succeeds, and never check out, reset or stash anything.

**Files**
1. Check each path exists; name any that do not and stop.
2. The whole file is under review, not a diff. Write the list of paths to \`review/files.txt\` and use it where the steps below say "diff".

Count the changed lines (\`wc -l\` on the diff). Above about 3000, tell the person the review will be thinner per line, and carry on.

## 3. Project rules and the brief

Read whichever exist, at the repository root and in the directories the change touches: \`AGENTS.md\`, \`CLAUDE.md\`, \`REVIEW.md\`. \`REVIEW.md\` is guidance written for reviews — what matters, what to ignore — and wins over these instructions wherever they disagree, except for the output format, the CONFIRMED / PLAUSIBLE rules and step 7. Write the rules that bear on the changed code to \`review/rules.md\` (a digest, not a copy).

For local changes or files, call \`${REVIEW_BRIEF}\`: it writes \`review/intent.md\` and returns its path. It is everything the reviewers will know about this conversation: whatever you leave out, they have to guess. Write more rather than less, and quote the person's own words rather than paraphrasing them. State facts; do not argue that the change is right. The tool refuses a required field that is missing or too short, and names it; fill it in and call again.
- \`background\` (required) — why this was done: the problem the person ran into or what they asked for, in their terms. Example: "The person found that /review reviews code in the session that wrote it, so it agrees with itself; they asked for sub-agents to do the review."
- \`decisions\` (required) — every decision and constraint the person set in this conversation, each with their words in quotes. Example: \`"不要 commit" — nothing committed. "新文件尽量 300 行以内" — the new file is 190 lines.\` When there truly are none, write "The person set no further constraints."
- \`implementation\` (required) — what you actually did and the approach; where it departs from the plan, how and why.
- \`files\` (required) — every changed file, each with one sentence on what changed. Example: \`{ "path": "src/auth.ts", "change": "adds the OAuth callback route and its error branch" }\`.
- \`out_of_scope\` (optional) — what was deliberately left out or must not be touched, so it is not reported as missed.
- \`unverified\` (required) — what you know is unverified, unfinished or doubtful. When there is truly nothing, write "Nothing known unverified" and why you believe so.
- \`focus\` (optional) — where you most want a hard look.
Do not copy the plan or the person's messages: the tool attaches the approved plan and every message the person wrote, verbatim. If this conversation did not write these changes, say so in \`background\` and \`implementation\`. For a pull request there is no implementation to hand over: skip the brief, and dimension E with it.

## 4. Find

The dimensions:

- **A. Line by line.** Every changed line: wrong condition or operator, off-by-one, null or undefined reaching code that assumes a value, the wrong variable, a missing \`await\`, a resource opened and not closed, a type that claims more than the value guarantees.
- **B. Removed and changed behaviour.** Every function, branch, export, default, option or file the change deletes or alters: find its callers and consumers (search the whole repository), and check each still works. Behaviour that existed before and is gone with nothing replacing it is a finding.
- **C. Security, errors and tests.** Injection, path traversal, secrets in code or logs, a missing permission check; errors swallowed, a rejection nobody handles, state left half-written when a step fails; changed behaviour with no test, or a test that still passes while asserting the old behaviour.
- **D. Cross-file and adversarial** (high only). Follow data from where it enters (user input, files, network, IPC) through the changed code to where it ends up. Then attack it: hostile or huge input, two calls at once, a different order of events, a different platform (Windows paths, case-insensitive file systems).
- **E. Intent** (only with \`review/intent.md\`). Hold the change against what was wanted — the person's own words and decisions first, then the plan: something they asked for or decided that the diff does not do, does only in part or does differently; and anything the change does that neither mentions — behaviour, files, public interfaces. The implementation notes are claims: check each against the code rather than accepting it. Something listed as out of scope is deliberate, not missed; a gap listed as unverified is not a finding unless it breaks something.

${levels(delegate)}

## 5. Verify

Merge duplicates first: same location and same cause is one finding. Sub-agents are wrong often enough that none of their findings is CONFIRMED on their word alone — and you wrote the change, so none is dropped on yours either.

- **low and medium**: for each finding, read the cited lines and the code the claim depends on.
- **high**: read each checker's result, then the cited lines.

Then label it:
- **CONFIRMED** — you followed the trigger through the code to the failure.
- **PLAUSIBLE** — anything short of that: it depends on something you could not establish (runtime configuration, input you cannot see, an external service), or you believe the code disproves it. Keep the finding either way; a belief that it is wrong goes into step 7 as the reason to leave it, with the code that shows it.
- **Dropped** — only at high, and only when its checker returned no findings and said what prevents the trigger. Name it under "Dropped by checkers" with that reason. Nothing else is dropped.

A check from \`verify\` that fails because of this change is a CONFIRMED finding at the failure's location. A failure that is not caused by the change goes under "Not covered", not under findings.

## 6. Report

Copy each finding's location, problem and trigger from the sub-agent's result as it wrote them, corrected only where its checker corrected it. Do not soften, shorten or merge them beyond step 5's duplicates: the person can open the sub-agents' own reports and will compare.

\`\`\`
## Review: <target> · effort <level>
<One line: what was reviewed (files, changed lines) and what ran (sub-agents, checks, intent compared with the brief).>

### Findings
1. **[high] path/to/file.ts:42** — <the defect, one sentence>
   Trigger: <input or state> → <what goes wrong>
   Status: CONFIRMED
   Decision: <step 7>

### Dropped by checkers
<high only: each one, with what its checker found prevents it>

### Checks
<each command and its result>

### Not covered
<what was left out and why: files skipped, checks not run, gh unavailable>
\`\`\`

Order by severity, CONFIRMED before PLAUSIBLE within one. **high**: data loss, a security hole, or a crash or wrong result on a normal path. **medium**: wrong on an edge case a user will plausibly reach, or a broken error path, or something the person asked for or the plan set out missing or done differently. **low**: wrong only on a rare path, with limited effect. No style preferences, no praise, no summary of what the change does. If nothing survived, write "No defects found." with what was covered — do not invent something to report.

## 7. Decide and fix

Every finding gets a decision; none is left out of the report or passed over in silence. Decide from this conversation — the person's own words and decisions first, then the plan and the scope:

- **Fixed** — a CONFIRMED finding inside what the person asked for.
- **Left — <reason>** — one the person ruled out (quote them), one outside the scope, or one you believe the code disproves (cite the \`path:line\` that does). The reason has to stand on its own: "not a real issue" is not a reason.
- **Asked** — a PLAUSIBLE finding you would fix, or one the conversation does not settle either way: ask the person ${askWith}, about those findings only, each with its number and one line. Do not ask about what the conversation already settles. Their answer makes it Fixed or Left.

For a PR whose head is not checked out, nothing can be fixed here: every finding is Left with that reason. With \`--comment\`, do step 8 before fixing anything.

Then fix the findings marked Fixed — the smallest change that removes each defect, no refactoring around it, nothing else. Commit, stage, stash, check out and reset nothing. Run the checks that cover the files you touched (reuse the commands \`verify\` ran, if it ran) and add them to the report as "Checks after fixing", each with its result. Your last reply is the step 6 report with every decision filled in.

## 8. --comment (PR only)

A comment on the PR is visible to other people, so nothing is posted without an explicit yes.
1. Write the comment to \`review/comment.md\`: the step 6 report, findings labelled CONFIRMED or PLAUSIBLE, without the Decision lines.
2. Show the person the full text, then ${askToPost}.
3. Only on "Post this comment": \`gh pr comment <n> --body-file <scratch>/review/comment.md\`, and give the URL it prints. A skip, a cancel or any other answer means nothing is posted; say so.
`;
}

/** 人敲 `/review <参数>` 时发给模型的那条消息。没写参数就是审未提交的本地改动（第 1 步）。 */
export function reviewRequest(rest: string, tools: BodyTools): string {
	return `${reviewBody(tools)}\n\n---\n\nArguments: ${rest || "none (the uncommitted local changes)"}`;
}
