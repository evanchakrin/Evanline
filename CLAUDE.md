# Evanline — working notes for Claude

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
