# Context Engineering

17 个讲上下文工程的技能：压缩、退化诊断、记忆、多 agent 分工、工具设计、评测。

这是一组技能（共 18 个），装上后 agent 在需要时按技能说明去做。

## 包含的技能

- **advanced-evaluation**：This skill should be used for advanced LLM evaluation: LLM-as-judge systems, direct scoring, pairwise comparison, rubric calibration, evaluator bias mitigation, confidence scoring, and automated quality assessment.
- **bdi-mental-states**：This skill should be used when modeling agent mental states with BDI concepts: beliefs, desires, intentions, RDF-to-belief transformations, rational agency traces, cognitive agents, BDI ontologies, and neuro-symbolic AI integration.
- **context-compression**：This skill should be used when long-running agent sessions need context compression, structured summarization, compaction, token-per-task optimization, or durable handoff summaries that preserve decisions, files, risks, and next actions.
- **context-degradation**：This skill should be used for diagnosing and mitigating context degradation: lost-in-middle failures, context poisoning, context clash, context confusion, attention-pattern issues, and agent performance degradation caused by accumulated or conflicting context.
- **context-fundamentals**：This skill should be used to explain or reason about the foundational concepts of context engineering: what context is, the anatomy of a context window, how att…
- **context-optimization**：This skill should be used for improving context efficiency: context budgeting, observation masking, prefix or KV-cache strategy, partitioning, token-cost reduction, retrieval scoping, and extending effective context capacity without lowering answer quality.
- **evaluation**：This skill should be used when building agent evaluation systems: deterministic checks, regression suites, multi-dimensional rubrics, quality gates, production monitoring, baseline comparison, and outcome measurement for agent pipelines.
- **filesystem-context**：This skill should be used when agent work needs file-backed context: durable scratchpads, tool-output offloading, just-in-time discovery, cross-agent handoff files, filesystem memory, or cleanup policies for context stored outside the prompt.
- **harness-engineering**：This skill should be used when designing autonomous agent harnesses: research loops, evaluation scaffolds, locked and editable surfaces, durable logs, novelty gates, pruning, rollback, PR preparation, and human approval boundaries.
- **hosted-agents**：This skill should be used when designing hosted or background agent infrastructure: sandboxed execution, remote coding environments, warm pools, session persistence, multiplayer collaboration, self-spawning agents, or Modal-style sandboxes.
- **latent-briefing**：This skill should be used when the user asks to "share memory between agents", "KV cache compaction for multi-agent", "orchestrator worker context", "latent bri…
- **long-horizon-prompting**：This skill should be used when writing, enhancing, or evaluating the launch prompt for a long-running autonomous agent or a parallel multi-agent orchestration a…
- **memory-systems**：This skill should be used for persistent semantic memory in agent systems: cross-session knowledge retention, entity tracking, temporal validity, graph or vector retrieval, memory consolidation, and memory benchmark selection.
- **multi-agent-patterns**：This skill should be used when designing multi-agent systems that need context isolation, supervisor or swarm coordination, explicit handoffs, parallel execution, or a decision on whether multiple agents are justified.
- **project-development**：This skill should be used for project-level decisions about LLM-powered systems: whether an LLM is the right primitive for the task at hand, the shape of a mult…
- **self-improvement-loops**：This skill should be used when the harness, scaffold, workflow, or optimizer itself is the optimization target: recursive self-improvement (RSI) loops, meta-har…
- **self-managed-context**：This skill should be used when a model gets read-write control over its own live context window instead of a harness-scheduled compaction policy: the context ex…
- **tool-design**：This skill should be used for the tool-interface layer of an agent system specifically: writing tool descriptions agents can route on, designing tool schemas an…

## 来源

- 上游仓库：<https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering>
- commit：[`9f87ab29617109de590fdbd16bab3d7e72723264`](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering/tree/9f87ab29617109de590fdbd16bab3d7e72723264/skills)，目录 `skills`
- 许可证：MIT
