# Ruflo × Bima — Integration Plan

**Status:** Setup complete (init + memory + swarm), runtime ready.

## What ruflo is

[Ruflo](https://github.com/ruvnet/ruflo) is a multi-agent orchestration
platform that adds a "nervous system" to Claude Code. After
`npx ruflo init`, this project has:

- `.mcp.json` — registers ruflo as an MCP server for Claude Code
- `.claude/` (gitignored) — local agents, commands, hooks, settings
- `CLAUDE.md` — swarm guidance auto-loaded by Claude Code
- `.claude-flow/` (gitignored) — runtime data, logs, sessions
- `.swarm/` (gitignored) — active swarm state
- `ruvector.db` (gitignored) — vector memory database

## How Bima will use it — 3 phases

### Phase A — Dev-time only (NOW)

Ruflo speeds up developing Bima itself. Claude Code (me) can spawn
specialist sub-agents in coordinated swarms instead of doing
everything in one context.

Use it for:
- **Multi-file refactors** — architect → coder → tester → reviewer pipeline
- **Security audits** — security-architect + auditor swarm before release
- **Performance work** — perf-engineer + coder
- **Big feature builds** — fan-out subagents (as we've been doing
  for daemon, web panel, etc — now coordinated via SendMessage
  instead of ad-hoc)

Trigger from Claude Code:
```
"Use ruflo to do X" — I'll spawn the named-agent pipeline.
```

No code changes needed in Bima for Phase A.

### Phase B — Bima-runtime tools (NEXT)

Expose ruflo capabilities to Bima users (not just devs):

1. **New agent tool `delegate_swarm(task)`** — Bima's main AI agent
   can offload complex multi-step tasks to a ruflo swarm. Useful when
   user asks "buatkan fitur X di workflow saya yang ada" — instead of
   the single-agent doing the whole thing, dispatch to architect →
   coder → tester.

2. **New workflow node `swarm.run`** — workflow can call a swarm
   pipeline for a step. e.g. user uploads a contract PDF → `swarm.run`
   with task "legal-review" → fan out to legal-architect +
   compliance-auditor + summarizer → return summary back into
   workflow.

3. **MCP tool bridging** — Bima's runAgent gets `memory_search` and
   `memory_store` from ruflo's MCP server, so long-term memory across
   tenants is hardened (sub-millisecond retrieval vs current JSON
   files).

### Phase C — Swarm-of-swarms (LATER)

Each Bima tenant gets its own ruflo swarm with isolated memory. When
a tenant's bot answers a question, it can:
- Consult tenant-specific memory (RAG)
- Spawn specialists if the question is complex
- Hand off to human via WhatsApp escalation if confidence low

Premature until user base bigger.

## Quick verification

```bash
# Memory search
npx ruflo memory search --query "bima workflow" --namespace patterns

# Swarm status
npx ruflo swarm status

# List agents available
npx ruflo agent list

# Health check
npx ruflo doctor --fix
```

## Phase A → B transition trigger

Start Phase B when ANY of:
- 50+ workflows installed across tenants (current swarm-less approach
  bottlenecks)
- User asks for "AI yang bisa bagi tugas otomatis"
- We add multi-tenant SaaS mode

Until then: keep ruflo as dev-time only. Don't burden Bima runtime
with extra MCP plumbing yet.
