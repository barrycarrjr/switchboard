# Provider Failover Handoff

Status: design agreed, implementation not started  
Recorded: 2026-08-20  
Repository baseline: Switchboard v0.9.0

## Continue from here

Read this document, then inspect `core/watch.js`, `core/accounts.js`,
`core/terminals.js`, and the terminal IPC handlers in `src/main.js`. Do not assume
that changing an environment variable can replace the provider in a running agent.

## Goal

Let each developer use one control surface and an ordered pool of AI subscriptions.
When an account is exhausted, use another account; when every account for that
provider is exhausted, hand the task to the next provider without requiring the
developer to reconstruct the task from memory.

This must work first for native CLIs and should later integrate with T3 Code through
a supported API or an upstream T3 change.

## Current behavior

- Switchboard registers account config directories and changes the default for new
  processes. It does not own tasks or running sessions.
- The automatic quota watcher considers Claude accounts only. It can change the
  Claude default, but it cannot replace a running Claude process.
- Claude and Codex quota are both observable live from each account's own sign-in;
  Codex falls back to a timestamped session-log snapshot when that check is refused.
  Gemini and Qwen do not expose usable quota data.
- T3 Code owns its provider instances and active threads. Switchboard cannot change
  an existing T3 thread merely by changing `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
- Compatible accounts within one harness may resume native state. Different
  providers generally require a new session and an explicit context handoff.

## Agreed design

### 1. Model an execution lane

Use a lane rather than a global "active provider":

```text
lane = harness + provider + account + auth/billing mode + capabilities
```

Examples:

```text
Claude Code / Anthropic / Work A / subscription
Claude Code / Anthropic / Work B / subscription
Codex       / OpenAI    / Work   / subscription
Gemini CLI  / Google    / Work   / subscription
Claude Code / OpenRouter         / metered API fallback
```

Each developer configures an ordered pool of lanes. Selection considers known quota,
authentication health, cooldown/reset time, harness compatibility, and billing mode.

### 2. Preserve native subscription paths

Subscription lanes must launch the vendor's native harness with its own account
environment. Do not convert consumer OAuth credentials into a general-purpose API.

An API proxy is optional and only for explicit API-key lanes. Any metered lane must
be visibly labeled, opt-in, and protected by a spend policy. Never silently move a
subscription task onto pay-as-you-go billing.

### 3. Treat account failover and provider failover differently

- Same compatible harness/account family: resume when the harness proves it can.
- Different provider or incompatible home: stop at a turn boundary, create a compact
  handoff, and start a new native session in the same working directory.
- Never claim that hidden reasoning, provider-native session state, or an in-flight
  response transferred when it did not.

### 4. Keep the handoff on disk

The chat handoff should be only one sentence:

```text
Read <absolute-handoff-path> and continue from its Next actions section.
```

The handoff document is the source of truth and should remain bounded (target: under
4 KB). It contains:

```markdown
# Task handoff
Objective:
Constraints:
Decisions made:
Current repository state:
Next actions:
Verification already run:
Blockers or risks:
```

It must reference paths, commits, diffs, and test commands instead of embedding full
files, transcripts, diffs, logs, or model reasoning. The incoming agent can inspect
the shared working tree directly.

The document should be updated at meaningful milestones, not created only after a
hard limit error: an exhausted provider may no longer be able to summarize. Store
runtime handoffs under Switchboard app data, grouped by workspace, and pass the
absolute path to the next process. Do not add transient task handoffs to the user's
repository unless the user explicitly asks.

## Delivery plan

### Phase 1: lane registry and policy (no automatic execution)

- Add lane and ordered-pool configuration while preserving the existing account
  registry migration path.
- Report `available`, `exhausted`, `unknown`, `signed-out`, and `cooldown` states.
- Add a dry-run command that explains which lane would be selected and why.
- Unknown quota may be selected manually, but must not be treated as known capacity.

### Phase 2: native CLI broker

- Add `switchboard run` to select a lane and spawn its native CLI in the current
  working directory with per-process account environment variables.
- Add explicit overrides such as `--provider`, `--account`, and `--no-fallback`.
- Recognize provider limit errors conservatively. On an ambiguous failure, report it
  instead of automatically changing providers.

### Phase 3: compact task handoff

- Add a versioned handoff schema, atomic writes, size enforcement, and redaction.
- On cross-provider failover, start a new session with the handoff path and the same
  workspace. Default to confirmation until the behavior has been proven reliable.
- If no valid handoff exists, do not pretend continuation is safe; offer a fresh
  session or ask the user to provide the missing objective.
- Derive the handoff at the moment of failover, from the spent session's own transcript.

**Built, but not the way this phase originally described it.** The line that used to sit
here read "maintain the handoff during work where the harness exposes enough task
context", and both halves of that turned out to be wrong. `switchboard run` hands the
terminal straight to the vendor's CLI, so for an interactive run it never sees the output
and cannot maintain anything; and maintaining a document continuously would mean paying to
summarise throughout every run to serve an event that mostly never happens.

Deriving it once, at the failover, is strictly better, and cheaper than expected. An agent
narrates its own work, so the text turns of its transcript already contain the objective,
the progress and the decisions. Lifting them out is plain extraction with no model call,
which also means nothing in the path can invent a decision that was never made. A 400 KB
transcript reduced to under 900 bytes that still carried a design decision and a warning
about the one case that would not fit it, and a different vendor acted on both.

Claude and Codex are both readable, so either can hand to the other or to a second account
of its own, and the reader is a per-vendor table entry rather than a special case. The two
are located differently and the difference is the interesting part: Claude Code accepts
`--session-id`, so Switchboard names the session and knows the file; Codex has no such
flag, so its session is recognised after the fact by the working directory recorded in its
`session_meta` together with having been written during this run. That second condition is
load bearing. Without it a rollout left behind by earlier work in the same directory would
be handed over as the current task, which is worse than handing over nothing.

Gemini and Qwen are not readable yet, so a hop involving either still starts fresh. Adding
one needs a table entry and a session layout somebody has actually checked, not assumed.

A handoff already written for the workspace is used untouched rather than generated over.

Separately, a failover between two accounts on the SAME tool does not need a handoff at
all: a Claude transcript is portable between config folders, so the session is copied into
the incoming account and resumed there. That path carries everything rather than a summary
of it, and is what runs whenever both lanes are Claude.

### Phase 4: T3 Code integration

- Do not edit undocumented T3 internal state or automate its UI.
- Prefer a supported local API/IPC contract or contribute fallback and transcript
  handoff support upstream to T3.
- Switchboard should supply lane health and policy; T3 should remain responsible for
  thread creation, provider adapters, and showing the handoff to the user.
- Until that integration exists, Switchboard can advise which T3 provider to choose,
  but automatic failover applies only to processes launched through the CLI broker.

### Phase 5: optional API router

- Add only if API-key fallback is actually needed.
- Keep it separate from native subscription lanes.
- Require explicit provider credentials, cost visibility, retry limits, and spend
  controls. Supporting multiple wire protocols is an adapter project, not a shortcut
  for subscription portability.

## Safety and product rules

- Never expose, copy, log, or place provider tokens in a handoff.
- Never silently change billing mode.
- Never switch providers during an in-flight turn.
- Never assume quota when the vendor provides no trustworthy signal.
- Do not overwrite unrelated working-tree changes.
- Show the selected lane prominently so the developer knows which account is paying.
- Record why a failover happened and when the exhausted lane becomes eligible again.

## Initial acceptance criteria

1. A configured pool can select the next healthy account or provider deterministically.
2. `switchboard run` launches the correct native CLI and account without changing
   other running terminals.
3. A cross-provider transition creates a bounded, secret-free handoff and starts the
   next CLI in the same workspace.
4. The incoming agent can determine the objective, repository state, tests already
   run, and next action by reading only that handoff plus the working tree.
5. No API charge can begin without an explicit metered-lane policy.

## First implementation task

Write tests for the lane data model and pure selection policy before adding UI or
process launching. Keep quota collection separate from selection so unknown and stale
signals remain explicit.
