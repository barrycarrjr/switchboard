# Customizations Hub, Runtime Boundaries, and Automations Roadmap

This document defines the architecture and phased implementation plan for evolving Switchboard from a standalone MCP server registry into a cross-provider **Customizations** and **Automations** control plane.

---

## 1. Ecosystem Separation of Concerns

Switchboard sits in a multi-layer local AI stack. Keeping clear boundaries between each layer avoids duplicate configuration, vendor lock-in, and unnecessary background daemons.

```
+-----------------------------------------------------------------------------------+
|                        Interactive Multi-Agent Workbenches                        |
|      GUI orchestrators, IDE extensions, visual diffs, browser/device previews     |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                        Switchboard (Local Control Plane)                          |
|  1. Accounts & Quotas  2. Execution Lanes (`switchboard run`)                     |
|  3. Customizations Hub (Plugins, Skills & Rules, Custom Agents, MCP Registration) |
|  4. Low-Level Scheduled Automations (Cron -> `switchboard run <lane>`)            |
+----------+------------------------+------------------------+----------------------+
           |                        |                        |
           v                        v                        v
  [AI Provider CLIs]     [Direct MCP & Skills]      [Docker (When Running)]
  - Claude Code          - Remote HTTPS/SSE MCPs    - Stateful/heavy services
  - Codex                - Local npx/node/uvx       - Container-only MCPs
  - Antigravity (agy)      stdio MCPs               - Self-hosted stacks / DBs /
  - Junie / VS Code      - Shared SKILL.md &          sandboxed toolchains
                           Rules (CLAUDE/AGENTS/
                           GEMINI.md)
```

### Layer Responsibilities

1. **Switchboard (Provider Gateway & Customizations Control Plane)**
   - **Accounts & Lanes**: Manages provider accounts, isolated config directories, quota telemetry, and ToS-compliant failover via `switchboard run <lane> -- <cmd>`.
   - **Customizations Hub**: Single point of registration and synchronization for **Plugins**, **Skills & Rules**, **Custom Agents**, and **MCP Servers** across all detected AI clients (`claude`, `codex`, `antigravity`, `junie`, `vscode`, `vscodeInsiders`) and every isolated account profile (`~/.claude-<id>`).
   - **Low-Level Scheduled Automations**: Runs general-purpose scheduled prompts and maintenance tasks through `switchboard run`, decoupling scheduled work from any single vendor daemon or domain-specific bot.

2. **Interactive Multi-Agent Workbenches (T3 Code, IDEs)**
   - Own interactive coding threads, side-by-side model comparisons, worktree handoffs, pull request reviews, and browser/device previews.
   - Consume the skills, rules, agents, and MCP servers that Switchboard provisions into each provider's configuration directory.

3. **Domain-Specific Support & Repo Bridges**
   - Own product-specific integrations (e.g., team chat listeners, customer/reseller ticket triage, repository-specific autonomous bug fixing).
   - Delegate underlying CLI execution to `switchboard run` so domain workflows inherit multi-account quota failover and shared customizations.

4. **Docker / Container Runtime**
   - Used strictly as an **opt-in runtime** for stateful infrastructure, heavy binary dependencies, or sandboxed containers.
   - Switchboard must never require Docker Desktop to be running for standard remote HTTPS MCP servers, lightweight local stdio MCP servers (`npx`, `node`, `uvx`), or skills/plugins.

---

## 2. MCP & Tool Runtime Policy: Switchboard vs. Docker

A core design rule of Switchboard is zero unnecessary runtime dependencies. While Docker's MCP catalog is a useful upstream metadata feed, routing everyday MCP servers through Docker containers requires Docker Desktop to be running at all times and adds significant memory and startup overhead.

Switchboard classifies MCP servers and tools into three runtime tiers:

| Runtime Tier | How It Runs | Managed By | Examples |
|---|---|---|---|
| **1. Remote (`http` / `sse`)** | Direct HTTPS connection from each AI client to the remote MCP endpoint (with OAuth or Bearer token in the client's store). | **Switchboard natively** (default, zero local daemon required). | Stripe, Linear, Notion, Sentry, Context7, Cloudflare, Figma, Asana, GitHub, remote Home Assistant / network controller endpoints. |
| **2. Local Stdio (`npx` / `node` / `uvx` / binary)** | Spawned on-demand by the AI client over `stdio` using local Node/Python/system binaries. | **Switchboard natively** (writes `command`, `args`, and `env` into each client's MCP config). | Chrome DevTools MCP, Playwright, filesystem/git servers, offline embedding tools such as `modern-web-guidance`. |
| **3. Containerized (`docker`)** | Spawned via `docker run -i --rm ...` or bridged to a running container stack. | **Optional in Switchboard** (badged as `Docker`; checks if Docker daemon is reachable and warns/hides when Docker is stopped). | Heavy security scanners, isolated database sandboxes, or container-only third-party MCP images. |

---

## 3. Evolving the `MCP` Tab into `Customizations`

Switchboard's current `MCP` tab will be renamed to **`Customizations`** and redesigned around two primary views modeled after Antigravity's Customizations experience, while remaining **100% provider-agnostic**:

- **`Marketplace`**: Discover and install curated **Plugins**, **Skills & Rules**, **Custom Agents**, and **MCP Servers** (Remote, Local Stdio, and optional Docker).
- **`Installed`**: Inspect, toggle, sync, test, and remove installed items across four collapsible sections:
  1. **Plugins**
  2. **Skills & Rules**
  3. **Custom Agents**
  4. **MCP Servers**

### 3.1 Dynamic Provider Eligibility & Cross-Client Sync Matrix

Currently, `core/mcp.js` hardcodes 6 client keys (`claude`, `codex`, `antigravity`, `junie`, `vscode`, `vscodeInsiders`) and only fans out multi-account config folders for `claude`. Meanwhile, `core/providers.js` (`TOOLS`) already tracks 14 providers (`claude`, `codex`, `gemini`, `copilot`, `junie`, `qwen`, `amp`, `opencode`, `grok`, `cursor`, `muse`, `aider`, `antigravity`, `ollama`) and `core/accounts.js` (`PROVIDERS`) tracks multi-account homes.

To make Customizations completely low-maintenance as you install tools (for example, starting to use **Grok** or **Qwen** next week) or as new AI providers are added to Switchboard:

1. **Single Provider Registry (`core/providers.js` + `core/accounts.js`)**:
   - Every provider in `TOOLS` and `APPS` automatically exposes a **Customization Target Profile** (defaulting by convention to `~/.<id>/skills`, `~/.<id>/rules`, `~/.<id>/agents`, `~/.<id>/AGENTS.md`, and `~/.<id>/mcp.json`, with per-provider overrides only where a vendor uses a non-standard file like Codex's `config.toml` or Claude's `.claude.json`).
   - Adding a new provider to `TOOLS` in `core/providers.js` automatically makes it a first-class Customization target with zero edits to the Customizations UI or sync engine.
2. **Automatic Appearance When Installed**:
   - Customizations queries `detectInstalled()` (`core/providers.js`) and `listAccounts()` (`core/accounts.js`).
   - Any provider that is currently installed on the machine or has a registered account (e.g., if you install **Grok** next week) **automatically appears in the client chips** for every Plugin, Skill, Rule, Custom Agent, and MCP Server.
   - Uninstalled providers stay hidden from the active chips so the UI is never cluttered with tools you do not use, and the moment you install one (such as Grok), it appears and can be activated with one click (or auto-provisioned if "Sync to All Installed Clients" is enabled).
3. **Generalized Multi-Account Fan-Out (`claude*4`, `codex*2`, `qwen*2`, etc.)**:
   - Instead of checking `if (key === 'claude')`, `targetsFor(providerId)` dynamically fans out across **every** account home registered for that provider in `accounts.json`.

#### Canonical Store & Native Layout Mapping

Switchboard acts as the canonical manager (`<userData>/customizations/`) and synchronizes customizations into each installed provider's native layout:

| Customization Type | Switchboard Canonical Store | Claude Code (`~/.claude` & `~/.claude-<id>`) | Codex (`~/.codex` & `~/.codex-<id>`) | Antigravity / Gemini (`~/.gemini`) | Grok / Qwen / Cursor / OpenCode / Any New Provider (`~/.<id>`) |
|---|---|---|---|---|---|
| **Plugins** | `<userData>/customizations/plugins/<name>/` (`plugin.json`, `README.md`, bundled skills/agents/mcp) | Unpacks bundled skills -> `skills/`, agents -> `agents/`, MCP -> `.claude.json` | Unpacks bundled skills -> `skills/`, MCP -> `config.toml` | `~/.gemini/config/plugins/<name>/` + `~/.gemini/config/config.json` + unpacked skills | Unpacks bundled skills -> `~/.<id>/skills/`, rules -> `~/.<id>/rules/`, MCP -> native MCP config |
| **Skills (`SKILL.md`)** | `<userData>/customizations/skills/<name>/SKILL.md` (plus guides/scripts) | `skills/<name>/` (disabled in `skills.disabled/<name>/`) | `skills/<name>/` (disabled in `skills.disabled/<name>/`) | `skills/<name>/` and `config/skills/<name>/` | `skills/<name>/` (disabled in `skills.disabled/<name>/`) |
| **Rules (`*.md`)** | `<userData>/customizations/rules/<name>.md` | `CLAUDE.md` and `rules/<name>.md` | `AGENTS.md` and `rules/<name>.md` | `GEMINI.md` and `rules/<name>.md` | `AGENTS.md` (or `<ID>.md`) and `rules/<name>.md` |
| **Custom Agents** | `<userData>/customizations/agents/<name>.md` | `agents/<name>.md` | Translated to skill/instruction or agent profile | `agents/<name>.md` | `agents/<name>.md` |
| **MCP Servers** | Existing `core/mcp.js` per-client read/write with backup protection | `.claude.json` (`mcpServers.<name>`) | `config.toml` (`[mcp_servers.<name>]`) | `antigravity/mcp_config.json` (`mcpServers.<name>`) | Provider's MCP config (`mcp.json` / `.junie/mcp/mcp.json` / `Code/User/mcp.json`) |

### 3.2 Trusted, Self-Updating Marketplace Feeds (Zero Manual Maintenance)

The Marketplace must never be a static, hand-maintained list that goes stale or sits empty. Instead, Switchboard aggregates and auto-refreshes directly from the **official, trusted vendor feeds** that Antigravity, Claude Code, Codex, and Docker already maintain, plus supports one-click installation from any GitHub repository URL (`owner/repo`).

#### Official Upstream Sources Aggregated by Switchboard

| Trusted Source | Local Cache / Upstream Feed | What It Provides (Auto-Updated) |
|---|---|---|
| **1. Google Antigravity Official & Partner Catalogs** | `~/.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/marketplace.json` & `antigravity-plugins-partners/marketplace.json` (plus upstream `gstatic.com/antigravity/plugins*`) | **67+ Official & Partner Plugins** (`modern-web-guidance-plugin`, `chrome-devtools-plugin`, `firebase`, `gdocs`, `gdrive`, `gsheets`, `stripe`, `context7`, `supabase`, `figma`, `linear`, `notion`, `sentry`, `vercel-plugin`, `auth0`, etc.) using the `agent-plugins.org` schema. |
| **2. Anthropic Claude Code Official & Custom Marketplaces** | `~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json` (`plugins/` + `external_plugins/`) and `~/.claude/plugins/known_marketplaces.json` | **50+ Official Anthropic & External Plugins** (`code-review`, `code-simplifier`, `frontend-design`, `feature-dev`, `security-guidance`, `skill-creator`, `pr-review-toolkit`, `mcp-server-dev`, `commit-commands`, `hookify`, LSP plugins, plus any user-added Claude marketplaces). |
| **3. OpenAI Codex Curated & Bundled Catalogs** | `~/.codex/plugins/cache/openai-curated-remote`, `openai-bundled`, `openai-primary-runtime` | **Curated OpenAI Plugins & Skills** (`github`, `gmail`, `google-calendar`, `google-drive`, `slack`, `atlassian-rovo`, `openai-templates`, etc.). |
| **4. Official MCP Registry & Docker MCP Catalog** | `https://registry.modelcontextprotocol.io` & `https://desktop.docker.com/mcp/catalog/v3/catalog.json` (cached in `<userData>/catalog-cache.json`, with bundled fallback in `core/catalog-remote.json`) | **Remote HTTPS/OAuth MCP Servers, Local Stdio (`npx`/`uvx`) MCPs, and Optional Docker MCPs**, filtered and badged by runtime tier. |
| **5. Direct GitHub / URL Add (`+ Add from GitHub / URL`)** | Any `owner/repo` or `https://github.com/...` URL (just like `claude plugin`, `agy plugin install`, or `npx skills add`) | Clones/fetches any third-party plugin, `SKILL.md` pack, or MCP server manifest on demand and registers it across all selected clients. |

#### How Auto-Refresh Works
1. **Instant Startup from Local Vendor Caches + Bundled Snapshot**: On launch, Switchboard immediately reads the live marketplace caches already maintained on disk by Antigravity (`~/.gemini/antigravity/cache/marketplaces/`), Claude Code (`~/.claude/plugins/marketplaces/`), and Codex (`~/.codex/plugins/cache/`), merged with Switchboard's cached remote catalog. The Marketplace is populated with 150+ trusted items on day one, even offline.
2. **Background Refresh (Zero Maintenance)**: Switchboard periodically refreshes remote catalog JSON feeds in the background (caching to `<userData>/customizations/catalog-cache.json`) and runs `git pull --ff-only` / HTTP ETag checks on registered marketplace feeds so newly released plugins, skills, and MCP servers appear automatically.
3. **Smart Deduplication & Source Badging**: When the same tool appears in multiple vendor catalogs (for example, `stripe`, `linear`, `context7`, or `firebase` in both Antigravity and Claude Code), Switchboard merges them into a single card showing its verified source badges (`Verified: Google`, `Verified: Anthropic`, `Verified: OpenAI`, `Verified: Docker`) and provisions each client using its native format when you click **`+ Add`**.

### 3.3 `Marketplace` View Design

1. **Top Sub-Navigation & Filters**
   - Sub-view toggle: **`Marketplace`** | **`Installed`**
   - Search input (`Search plugins, skills, agents, and MCP servers...`)
   - Source filter pills: `All Sources` | `Antigravity` | `Claude Official` | `OpenAI Codex` | `MCP Registry`
   - Type filter pills: `All` | `Featured` | `Plugins` | `Skills` | `MCP (Remote)` | `MCP (Local)` | `MCP (Docker)`
   - Action button: **`+ Add from GitHub / Custom...`** (accepts any `owner/repo`, GitHub URL, custom marketplace repo, or custom Remote/Stdio MCP server).

2. **Featured Showcase & Card Grid**
   - Displays curated high-value items first (e.g., **Modern Web Guidance**, **Chrome DevTools**, **Context7**, **Firebase**, **Google Workspace**, **Stripe**, **Linear**, **Supabase**, **Notion**, **Sentry**, **Cloudflare**, **Figma**).
   - Each card displays:
     - Icon / logo badge + Display Name + Trusted Source badge (`Google`, `Anthropic`, `OpenAI`, `Docker`)
     - Type badge (`Plugin`, `Skill Pack`, `Remote MCP`, `Local MCP`, `Docker MCP`)
     - Concise description
     - **`Details`** button (opens the Overview Drawer/Modal) and **`+ Add`** / **`Installed`** action button.

3. **Overview Detail Modal / Drawer**
   - Clicking a card opens an Antigravity-style **Overview** view showing:
     - Header with logo, version, author, license, repository link, and `+ Add` / `Remove` button
     - Client compatibility chips showing which installed AI clients will receive the customization (`Claude`, `Codex`, `Antigravity`, `Junie`, `VS Code`)
     - Rendered Markdown overview (`README.md` or catalog description, suggested prompts, and included skills/tools list).

### 3.4 `Installed` View Design

Organized into four collapsible sections with item counts and section-level action buttons:

1. **`Plugins (N)`** (`+ Install from Repo/Zip`)
   - Lists installed plugin packages (discovered from Switchboard's canonical store and `~/.gemini/config/plugins/`).
   - Shows version, description, bundled components (`2 skills`, `1 MCP server`), client sync chips, an **Enable/Disable** toggle, and **Remove**.

2. **`Skills & Rules (N)`** (Filter pills: `All` | `Built In` | `Global` + `+ New Skill / Rule`)
   - Discovers all global skills (`~/.claude/skills`, `~/.codex/skills`, `~/.gemini/skills`, `~/.gemini/config/skills`), built-in skills (`~/.gemini/antigravity/builtin/skills`), and global instruction/rule files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `rules/*.md`).
   - Deduplicates skills by slug (e.g., `/modern-web-guidance`, `/chrome-extensions`, `/simplify-it`, `/bug-hunt`) and shows per-client sync pills (`Claude`, `Codex`, `Antigravity`) so a skill installed in one client can be synced to all other clients and isolated account profiles with one click.
   - Supports **Enable/Disable** per skill (moving between `skills/<name>` and `skills.disabled/<name>`).

3. **`Custom Agents (N)`** (`+ New Agent`)
   - Discovers custom agent definitions across `~/.claude/agents/` and `~/.gemini/agents/`.
   - Allows viewing/editing the agent prompt and syncing across supported clients.

4. **`MCP Servers (N)`** (`+ Add MCP Server`)
   - Preserves all current Switchboard MCP capabilities (per-client registration toggles, `claude*N` fan-out across isolated Claude profiles, OAuth/credential indicators, `Test` reachability probe, `Remove`).
   - Adds **Tool Count & Expandable Tool List** (e.g., `google-workspace • > 43 tools enabled`, `home-assistant • > 72 tools enabled`, `unifi-home • > 197 tools enabled`) sourced from local tool schema caches (`~/.gemini/antigravity/mcp/<server>/*.json`) or on-demand MCP `tools/list` probes.
   - Adds support for **Local Stdio MCP servers** (`command`, `args`, `env`) alongside Remote HTTPS/SSE servers, plus optional Docker status detection for Docker-backed servers.

---

## 4. Automations Boundary: Domain Bridge vs. Switchboard

Scheduled automations split cleanly into two categories based on what state gates them:

| Category | Where It Lives | Why |
|---|---|---|
| **1. Repo & Bot-Coupled Routines** | **Domain-Specific AI Bridge** | Coupled to a specific repository, its local knowledge base, chat channel state, and whether that repository's bot is currently enabled or paused. Uses `switchboard run` under the hood for execution failover, while the bridge owns scheduling and repo-bot gating. |
| **2. General Low-Level Routines** | **Switchboard (`Automations` tab)** | Machine-level or cross-project prompts that do not depend on a single repo's support bot being enabled, and should not be locked to a single vendor daemon (such as Antigravity's built-in Automations). |

### How Switchboard Low-Level Automations Work
- **Storage**: `<userData>/automations.json` (written via `writeJsonAtomic`), plus execution logs in `<userData>/logs/automations/<id>.jsonl`.
- **Job Definition**:
  - `id`, `name`, `enabled`
  - `prompt`: Prompt text or `/skill` invocation
  - `lane`: Target Switchboard lane (e.g., `coding`, `ops`) so runs automatically fail over across accounts/providers when quota is exhausted or a rate limit is hit
  - `cwd`: Working directory for execution
  - `schedule`: Interval or cron expression (evaluated by Switchboard's background tick loop in `src/main.js`, plus a CLI subcommand `switchboard automation run <id>`)
- **UI**:
  - `Create with Prompt` / `+ New` modal, `Enabled` toggle, `Run Now` button, last-run status badge, and expandable output log viewer.

---

## 5. Phased Implementation Plan

### Phase 1: Core Customizations Engine & Local Stdio MCP Support (`core/`)
1. **Extend `core/mcp.js`**:
   - Add `stdio` transport registration (`command`, `args`, `env`) alongside `http`/`sse` across all 6 client adapters (`claude`, `codex`, `antigravity`, `junie`, `vscode`, `vscodeInsiders`).
   - Add tool discovery helper (`listServerTools(name)`) reading cached tool schemas (when available) so the UI can show `> N tools enabled` and expand tool names/descriptions.
   - Add optional Docker daemon reachability check (`isDockerRunning()`) for `docker`-tier catalog entries.
2. **Create `core/customizations.js`**:
   - Implement discovery and cross-client sync for **Plugins**, **Skills** (`skills/` and `skills.disabled/`), **Rules** (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `rules/*.md`), and **Custom Agents** (`agents/*.md`).
   - Ensure every write into foreign client directories creates a timestamped backup in `<userData>/backups/<client>/` and uses atomic file operations.
   - Curate a built-in cross-provider **Plugins & Skills Catalog** (`core/catalog-customizations.json`) including `modern-web-guidance` (and `chrome-extensions`), Official/Partner plugins, and common local stdio MCP servers.
3. **CLI Parity (`bin/cli.js`)**:
   - Add `switchboard customizations list`, `switchboard skill sync <name>`, and extend `switchboard mcp add` to accept `--stdio <command> [args...]`.
4. **Unit Tests (`test/customizations.test.js`, `test/mcp.test.js`)**:
   - Test skill/rule/plugin discovery, enable/disable toggling, cross-client syncing, and stdio MCP registration in temp directories without touching real user configs.

### Phase 2: `Customizations` UI Facelift (`src/ui/index.html`, `src/main.js`, `src/preload.cjs`)
1. **Wire IPC Handlers**:
   - Expose `customizations:list`, `customizations:syncSkill`, `customizations:toggleSkill`, `customizations:installPlugin`, `customizations:removePlugin`, and `mcp:listTools` in `src/main.js` and `src/preload.cjs`.
2. **Redesign Tab in `src/ui/index.html`**:
   - Rename sidebar/top tab from `MCP` to `Customizations`.
   - Build the `Marketplace` sub-view (Featured cards, runtime/category filters, search, and the `Overview` detail modal rendering full README/details).
   - Build the `Installed` sub-view with collapsible sections for **Plugins**, **Skills & Rules** (`All | Built In | Global`), **Custom Agents**, and **MCP Servers** (with `> N tools enabled` expandable drawer and `+ Add MCP Server` modal supporting both Remote URL and Local Stdio).
3. **UI Tests (`test/ui-mcp.test.js` / `test/ui-customizations.test.js`)**:
   - Verify rendering of `Marketplace`, `Installed` sections, tool count badges, and detail views while keeping all top-level functions at column 0 for test lifting.

### Phase 3: Provider-Agnostic `Automations` (`core/automations.js` & UI)
1. **Build `core/automations.js`**:
   - CRUD for scheduled automation jobs, schedule evaluation, and execution via `core/runner.js` against configured lanes.
2. **CLI & GUI Integration**:
   - Add `switchboard automation list|add|run|remove` and an `Automations` view in the GUI with `Create with Prompt`, schedule toggles, `Run Now`, and run history logs.
