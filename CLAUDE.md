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
