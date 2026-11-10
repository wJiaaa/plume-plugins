# Compound Engineering

36 个工程技能：出方案、评审、调试、提交、盯 PR，并把每次学到的写回仓库。

这是一组技能（共 37 个），装上后 agent 在需要时按技能说明去做。

## 包含的技能

- **ce-babysit-pr**：Babysits an open GitHub PR until merge-ready, first judging whether an old PR still belongs.
- **ce-bakeoff**：Develop independent competing solutions to a defined brief, compare them, and synthesize a winning approach.
- **ce-brainstorm**：Explore vague or ambitious ideas into a right-sized requirements-only unified plan.
- **ce-code-review**：Review a named diff or PR for bugs, regressions, tests, and standards.
- **ce-commit**：Create a git commit with a clear, value-communicating message. Use when the user asks to commit/save staged or unstaged changes with a repo-appropriate message.
- **ce-commit-push-pr**：Commit, push, and open a PR. Use when asked to ship/open a PR, or for PR-description-only flows like writing, rewriting, or describing a PR body.
- **ce-compound**：Capture a solved problem's lesson in its cheapest durable form, a test or lint rule, a coding standard, or a repo learning, or refresh existing learnings against the codebase.
- **ce-compound-refresh**：Old name for refreshing learnings, which now lives in `ce-compound`.
- **ce-debug**：Diagnosis loop for bugs and failing behavior. Use when asked to debug or fix failing or slow behavior.
- **ce-doc-review**：Review requirements, plans, or specs with role-specific lenses. Use when the user wants to improve an existing planning document.
- **ce-dogfood**：Hands-off, diff-scoped browser QA of the active branch: maps user flows, drives a real browser, autonomously fixes small breakages with regression tests and commits, judges experience against product personas, and writes a durable dogfood report.
- **ce-explain**：Explain how and why something has its current shape, or what happened over a window of work, grounded in evidence.
- **ce-handoff**：Create a session handoff for another agent, or resume, find, and read any user-selected continuity source.
- **ce-help**：Help and orientation for Compound Engineering: place the user's work on the compounding loop and recommend the next command, without running it.
- **ce-ideate**：Generate and evaluate grounded ideas.
- **ce-noslop**：Rewrite, check, or draft prose so it carries no AI writing tells, reads plainly on the first read, and keeps every source fact.
- **ce-optimize**：Optimize a named target with a measured loop: attribute a workload's cost, or score variants and keep winners.
- **ce-plan**：Create structured plans for multi-step work, including software and non-software tasks.
- **ce-polish**：Polish a working feature through user-directed live browser feedback. Use when a functional feature needs focused UX refinement before shipping.
- **ce-pov**：Judge a supplied subject against the project's evidence and constraints.
- **ce-product-pulse**：Generate time-windowed product pulse reports from configured signals.
- **ce-promote**：Draft launch or promotion copy for a shipped feature.
- **ce-proof**：Publish, read, comment on, or edit markdown in Proof.
- **ce-prototype**：Build a throwaway prototype to answer how something should work, feel, or read.
- **ce-resolve-pr-feedback**：Judge PR feedback centrally, apply valid fixes, and complete review conversations with publication verified.
- **ce-retune**：Retune a skill corpus for a new model, measurement-first: mine the run archive for a baseline, establish a noise floor, audit the corpus adversarially, then cut in measured passes until a pre-registered bar clears.
- **ce-riffrec-feedback-analysis**：Analyze recorded product feedback into evidence for bugs and requirements.
- **ce-setup**：Check Compound Engineering's tools and repo config and fix what it finds, scaffold a Compound Pack with `pack:&lt;id&gt;`, or draft and refresh coding standards and review docs from pull request history.
- **ce-simplify-code**：Simplify code for clarity, reuse, quality, and efficiency while preserving behavior, and prune tests and comments that carry no value.
- **ce-strategy**：Create or update STRATEGY.md. Use when starting a product, adding a strategy doc, or changing direction or roadmap.
- **ce-sweep**：Sweep configured feedback sources (Slack, GitHub Issues; email experimental) for new items: acknowledge at source, analyze recordings, verify fixes merged to main, and emit an `lfg`-ready plan.
- **ce-test-browser**：Run browser tests for pages affected by the current branch or PR. Use when asked to run or check browser tests for the current change.
- **ce-test-xcode**：Test iOS apps in a simulator with XcodeBuildMCP. Use when iOS changes need simulator evidence before handoff.
- **ce-work**：Execute a plan or concrete work prompt end-to-end.
- **ce-worktree**：Set up isolated git worktrees — create a new branch for fresh work, or attach a worktree to an existing branch, PR, or commit.
- **lfg**：Take a request all the way to done, hands-off, through the right Compound Engineering skills.
- **wtf**：Explain the last message, or a supplied file, link, or passage, in plain language a person follows on the first read.

## 来源

- 上游仓库：<https://github.com/EveryInc/compound-engineering-plugin>
- commit：[`11d5751ef0bc5f915c78bd7c8d02b6ebb158f393`](https://github.com/EveryInc/compound-engineering-plugin/tree/11d5751ef0bc5f915c78bd7c8d02b6ebb158f393/skills)，目录 `skills`
- 许可证：MIT
