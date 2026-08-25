# Evanline — working notes for Claude

## Multi-agent workflows: tier the models (cost control)

When running `Workflow(...)` fan-outs in this project, **do not let every subagent inherit the premium orchestrator model** — that is where cost leaks. Agent Mission Control flagged that reliable roles here (e.g. `evanline-accuracy-review`, `evanline-toe-geometric-wizard`) ran only on premium models while rarely failing, wasting ~$70 in a single sweep.

Set the model per `agent()` call by the work it does:

- **Orchestrator / final synthesis / adversarial verdict** → premium (Opus 5), or Fable 5 only for the hardest long-horizon planning.
- **Review / research / accuracy-check workers** (the reliable, well-scoped roles) → `{ model: 'claude-sonnet-5' }`. These have a high success rate and do not need premium.
- **Pure fetch / grep / read / summarize helpers** → `{ model: 'claude-haiku-4-5' }`.

Example:
```js
agent(d.prompt, { label: `find:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: 'claude-sonnet-5' })
```

Reserve premium tokens for planning and the final judgment gate. Report a per-tier cost breakdown when a workflow finishes so the savings are visible.

<!-- mission-control:directive:tiering -->
## 🛰 Standing order: tier your models — set them explicitly, never inherit

_Planted by Agent Mission Control. Retire it from the dashboard rather than hand-editing this block._

**Set `model` explicitly on EVERY agent call. Never let a subagent inherit the orchestrator's model.** Omitting `model:` is silent, and it is where cost actually leaks — not in how many agents you spawn.

Measured on this fleet: an 18-agent session put **97% of ~$1,155 on the flagship tier** purely because `model:` was left off the agent calls. The three agents that *were* set explicitly cost **$3.70 combined**.

Tier by the work being done, not by who spawned it:

- **Orchestrator, final synthesis, adversarial verdict, security-sensitive implementation** → premium (Opus 5). Flagship (Fable 5) only for the hardest long-horizon planning.
- **Review, research, drafting, analysis workers** → `claude-sonnet-5`.
- **Pure fetch / grep / read / summarize helpers** → `claude-haiku-4-5`.

Delegation only saves money when the workers run a **cheaper tier than the orchestrator**. Fanning out to same-tier subagents saves nothing — it just spends faster.

When a workflow finishes, report a per-tier cost breakdown from the models that **actually ran**, not the ones intended. Configured and actual are different things; only the second one is billed. Check before claiming a tiering strategy worked.
<!-- /mission-control:directive:tiering -->
