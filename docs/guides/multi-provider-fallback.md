# Multi-Provider Fallback and Lanes

Switchboard uses **Execution Lanes** to route tasks to the healthiest available AI account. Because different workflows run differently, Switchboard implements fallback in two distinct layers that work seamlessly side by side.

## Layer 1: The Router (Native Ambient Fallback)

Most AI tools and IDE plugins (like VS Code extensions or background scripts) run natively and rely on Windows environment variables (e.g., `CLAUDE_CONFIG_DIR`). They don't know that Switchboard exists.

To protect these native tools, Switchboard runs a **Quota Watcher** in the background:
1. **Intra-Provider ONLY:** Windows environment variables are locked to a specific tool. If Claude runs out of quota, Switchboard cannot magically force a native VS Code extension to use Codex instead. It can only swap one Claude account for another Claude account.
2. **Lane Enforcement:** If you have the Quota Watcher set to "Auto", it constantly checks your Lanes tab. It finds the highest-priority healthy lane for *each* provider (e.g., your best Claude lane, your best Codex lane) and makes those the default Windows environment variables.
3. **Spend-Down Exception:** One thing outranks lane priority. A subscription's weekly quota is use-it-or-lose-it, so when any subscription lane's weekly window resets within the next 24 hours and still has room, the Watcher parks the default on *that* lane (soonest reset first) to burn the quota before it is forfeited. Once the reset passes, ordinary lane priority resumes and the default returns to your top lane on its own. Metered lanes never trigger this, because pay-as-you-go quota does not expire.
4. **Manual Control:** If you manually click "Make Default" on an account the Watcher would not have picked, the system lets you. However, 5 minutes later, the background Watcher will wake up, realize your manual choice doesn't match its own pick (your Lanes priority, or an active spend-down), and switch it back. If you want to stop this overriding behavior, turn the Quota Watcher to "Off" or "Notify" in the tray menu.

## Layer 2: The Rescuer (`switchboard run`)

For heavy, long-running agent tasks where you might run out of quota *mid-flight*, prefix your normal commands with `switchboard run` (e.g., `switchboard run claude my task`).

1. **Cross-Provider:** Because `switchboard run` controls the actual execution on the command line, it can do *cross-provider* switching. If Claude hits a rate limit mid-task, Switchboard recognizes the limit error, drops that lane, and can launch `codex` instead. Crossing to a different tool asks you first and defaults to no, so an unattended run needs `--yes` to go ahead. An ordinary non-zero exit is reported and left alone: only a limit error moves the work.
2. **The Markdown Handoff:** When switching providers, the session memory is lost, and Switchboard does not recover it. It never captures, stores or replays your conversation, so a retry is always a fresh start rather than a resumption. What it can do is point the new tool at a handoff document that already exists for the working directory you are in. That file lives under `%APPDATA%\Switchboard\handoffs`, not in your workspace, under a name derived from the directory's path. If one is there, the new session is told to read it and continue from its next actions. If there is none, Switchboard says so rather than pretending the task carried over.

   **Nothing in Switchboard writes that file yet.** The pieces exist in `core/handoff.js`: a fixed set of headings (objective, constraints, decisions, repository state, next actions, verification already run, blockers), a 4 KB ceiling, an atomic write, and redaction of common API-key shapes so a handoff cannot leak a secret. But no part of a run fills any of it in, so today the document exists only if you or your own tooling put it there. Keeping it current while work happens is Phase 3 of [the design note](../design/PROVIDER-FAILOVER-HANDOFF.md) and is not built.

## Metered vs Subscription Lanes

When adding an account to your Lanes pool, you must specify its billing type:
- **Subscription:** Monthly flat-rate accounts (e.g., Claude Pro). These are used freely until they hit a hard rate limit.
- **Metered (API):** Pay-as-you-go API keys (e.g., OpenRouter). **By design, Metered lanes are Blocked by default.** Switchboard will never silently fall back to a metered lane unless you explicitly click "Set Budget" on the lane and assign it a dollar amount. This guarantees that an overnight script failure won't accidentally drain your API budget without your consent.
