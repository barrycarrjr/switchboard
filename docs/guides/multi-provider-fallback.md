# Multi-Provider Fallback and Lanes

Switchboard uses **Execution Lanes** to route tasks to the healthiest available AI account. Because different workflows run differently, Switchboard implements fallback in two distinct layers that work seamlessly side by side.

## Layer 1: The Router (Native Ambient Fallback)

Most AI tools and IDE plugins (like VS Code extensions or background scripts) run natively and rely on Windows environment variables (e.g., `CLAUDE_CONFIG_DIR`). They don't know that Switchboard exists.

To protect these native tools, Switchboard runs a **Quota Watcher** in the background:
1. **Intra-Provider ONLY:** Windows environment variables are locked to a specific tool. If Claude runs out of quota, Switchboard cannot magically force a native VS Code extension to use Codex instead. It can only swap one Claude account for another Claude account.
2. **Lane Enforcement:** If you have the Quota Watcher set to "Auto", it constantly checks your Lanes tab. It finds the highest-priority healthy lane for *each* provider (e.g., your best Claude lane, your best Codex lane) and makes those the default Windows environment variables. 
3. **Manual Control:** If you manually click "Make Default" on a lower-priority account in the UI, the system lets you. However, 5 minutes later, the background Watcher will wake up, realize your manual choice doesn't match your Lanes priority, and switch it back to the top healthy lane. If you want to stop this overriding behavior, turn the Quota Watcher to "Off" or "Notify" in the tray menu.

## Layer 2: The Rescuer (`switchboard run`)

For heavy, long-running agent tasks where you might run out of quota *mid-flight*, prefix your normal commands with `switchboard run` (e.g., `switchboard run claude my task`).

1. **Cross-Provider:** Because `switchboard run` controls the actual execution on the command line, it can absolutely do *cross-provider* switching. If Claude hits a rate limit mid-task, Switchboard intercepts the limit error, stops the task, and can safely launch `codex` instead.
2. **The Markdown Handoff:** When switching providers, the session memory is lost. Switchboard securely dumps a compact `<4KB` Markdown file into your workspace containing the task's context, constraints, and progress. It passes this Markdown file to the new provider so the agent can pick up exactly where the last one left off without leaking API keys or secrets.

## Metered vs Subscription Lanes

When adding an account to your Lanes pool, you must specify its billing type:
- **Subscription:** Monthly flat-rate accounts (e.g., Claude Pro). These are used freely until they hit a hard rate limit.
- **Metered (API):** Pay-as-you-go API keys (e.g., OpenRouter). **By design, Metered lanes are Blocked by default.** Switchboard will never silently fall back to a metered lane unless you explicitly click "Set Budget" on the lane and assign it a dollar amount. This guarantees that an overnight script failure won't accidentally drain your API budget without your consent.
