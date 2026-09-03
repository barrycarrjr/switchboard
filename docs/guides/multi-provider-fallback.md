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
2. **Claude to Claude keeps the conversation.** Claude Code stores each session as a file inside whichever account folder it ran in, and that file works just as well in another one. So when the failover is between two Claude accounts, Switchboard copies the session across and resumes it there: the incoming account sees everything the spent account had worked out and carries on mid-task. No summary is produced and nothing is sent anywhere, because this is a file copy. The spent account keeps its own copy, and a session the incoming account already has is never overwritten.

   For this to be reliable Switchboard names the session itself, by adding `--session-id` to the command line on a Claude lane. Picking whichever file changed most recently instead would grab the wrong conversation whenever two agents are working in the same directory. If your own command line already steers the session (`--resume`, `--continue`, `--fork-session`, or your own `--session-id`) Switchboard adds nothing and carries nothing, on the grounds that the session is yours to manage.

3. **The Markdown Handoff, for every other hop.** A Claude session file means nothing to Codex, and a Codex session has not been shown to move between accounts at all, so those cases cannot be a copy. Switchboard writes a handoff document instead, and it does not need a summarising model to do it: an agent narrates its own work as it goes, so the text of its turns already contains the objective it was set, what it finished, and the decisions it took. Switchboard lifts that out of the spent session's transcript and writes it to `%APPDATA%\Switchboard\handoffs`, not into your workspace, under a name derived from the working directory. The new session is then told to read that file and continue from its next actions.

   **Claude and Codex can each hand to the other, and to a second account of their own.** The two are located differently, and the difference matters. Switchboard names a Claude session with `--session-id`, so it knows exactly which file belongs to the run. Codex has no such flag, so its session is recognised afterwards by two things together: the working directory it recorded in its own `session_meta`, and having been written during this run. That second half is what stops a rollout left over from earlier work in the same directory being handed over as though it were the current task. Gemini and Qwen are not readable yet, so a hop involving either still starts fresh; adding one means a table entry in `core/transcripts.js` plus a session layout somebody has actually verified.

   Because this is extraction rather than summarisation, nothing in the path can invent a decision that was never made. In the run this was proven on, a 400 KB transcript came down to under 900 bytes that still carried both the structure the first agent chose and its warning about the one case that would not fit that structure, and the receiving agent acted on both.

   **A handoff you wrote yourself always wins.** If a document already exists for that working directory, Switchboard uses it untouched rather than generating over it. If there is nothing to write from either, because the spent lane was not a Claude session or it died before saying anything, Switchboard says the handoff is missing rather than inventing one.

   The document keeps the protections it always had, in `core/handoff.js`: a fixed set of headings (objective, constraints, decisions, repository state, next actions, verification already run, blockers), a 4 KB ceiling, an atomic write, and redaction of common API-key shapes. The ceiling means a long run is recorded from its most recent work backwards, since that is the part describing where things actually stand, and the run tells you when it had to do that.

## Metered vs Subscription Lanes

When adding an account to your Lanes pool, you must specify its billing type:
- **Subscription:** Monthly flat-rate accounts (e.g., Claude Pro). These are used freely until they hit a hard rate limit.
- **Metered (API):** Pay-as-you-go API keys (e.g., OpenRouter). **By design, Metered lanes are Blocked by default.** Switchboard will never silently fall back to a metered lane unless you explicitly click "Set Budget" on the lane and assign it a dollar amount. This guarantees that an overnight script failure won't accidentally drain your API budget without your consent.
