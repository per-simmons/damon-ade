# ADE

An agentic development environment for macOS, Windows, and Linux. ADE is a local-first, single-user desktop app where you build a roster of persistent coding agents and work alongside them in the terminal. Every agent is a durable identity — its own name, photo, git repository, runtime CLI, and long-lived memory — not a throwaway chat session. You come back to the same agent tomorrow and it remembers what it learned today.

The interface is a two-level left rail. **Teams** group your work (a name and a square photo); inside each team live **Agents** (a name and a circular photo). Selecting an agent opens its workspace: a strip of **session** tabs, each a real terminal running the agent's coding CLI inside that agent's own git worktree. A **model bar** under the tabs lets you spawn a session on a different model without leaving the agent. On the right, the **Agent Files** panel shows the agent's memory growing as it works.

ADE runs whatever CLI coding agents you already have installed. Claude Code, OpenAI's Codex, and OpenCode are first-class runtimes. The model bar can also launch sessions on Kimi K2.7, MiniMax M3, and GLM 5.2 through a single OpenRouter key you enter once, in-app. Nothing here is a hosted service — your code, your keys, and your agents' memory all stay on your machine.

## Screenshots

<!-- TODO: rail with teams + agents -->
<!-- TODO: agent workspace with session tabs + model bar -->
<!-- TODO: Agent Files panel showing memory -->

## Install

### Download (recommended)

Download the installer for your platform from the [latest release](https://github.com/per-simmons/damon-ade/releases/latest):

- macOS: signed `.dmg`
- Windows: `ADE-<version>-x64.exe`
- Linux: `.AppImage`

### Build from source

Requires [Bun](https://bun.sh) 1.3.6+.

```bash
git clone https://github.com/per-simmons/damon-ade.git
cd damon-ade
bun install
cd apps/desktop
bun run compile:app        # builds main + preload + renderer into dist/
bunx electron .            # launches the built app
```

`compile:app` runs the full production build; `bunx electron .` then launches it directly. (Avoid `electron-vite preview` for a full run — it can exhaust memory.)

To package a desktop installer from `apps/desktop`, run:

```bash
bun run build
```

On Windows, the installer is written to `apps/desktop/release/ADE-<version>-x64.exe`.

## Prerequisites

ADE orchestrates coding CLIs; it does not bundle them. You need:

- **Git** — required. Each agent gets its own repository or worktree. On macOS, install Apple's command line tools with `xcode-select --install`; on Windows, install [Git for Windows](https://git-scm.com/download/win).
- **At least one agent CLI.** Claude Code is recommended, because it also powers the Kimi, MiniMax, and GLM sessions from the model bar (they run Claude Code pointed at OpenRouter):

  ```bash
  npm i -g @anthropic-ai/claude-code
  ```

  Optionally add the other runtimes:

  ```bash
  npm i -g @openai/codex        # OpenAI GPT-5.5 sessions
  npm i -g opencode-ai          # OpenCode runtime
  ```

- **Node.js** — only as the vehicle for installing the CLIs above via `npm`. ADE itself does not need a separate Node runtime.
- **An OpenRouter API key** — only if you want the open-model sessions (Kimi K2.7, MiniMax M3, GLM 5.2). You enter it in-app the first time you launch one of those models; see the walkthrough. The Claude and OpenAI runtimes authenticate through their own CLIs (your Anthropic and ChatGPT/OpenAI logins) and need no key here.

## Walkthrough

**1. First launch.** ADE opens on a start screen with a single action: **Create a team**. There are no agents until a team exists, so start here.

**2. Create a team.** Give it a name (for example, `Newsletter`). Optionally click the square photo thumbnail to pick an image — teams are the top level of the rail, so a photo makes them easy to find at a glance. The team appears in the left rail.

**3. Create an agent.** Hover the team's header in the rail and click the **+** button ("New agent"). In the New Agent dialog:
   - **Name** — required (for example, `Scout`).
   - **Role** — optional. A sentence describing what this agent is for. Leave it blank if you'd rather shape the agent by talking to it — ADE seeds the agent's identity file either way, and it refines itself over time.
   - **Runtime** — the coding CLI this agent runs: **Claude**, **Codex**, or **OpenCode**. Claude is the default.
   - **Repository** — start a new empty repo, clone from a URL, or point at an existing local path.

   ADE creates the agent, gives it its own git worktree, and scaffolds its memory in the background.

**4. Add profile photos.** Right-click any agent in the rail and choose **Change Photo** (or **Remove Photo**) to give it a circular avatar. Team photos are set the same way from the team's header menu. Photos are optional but make a busy rail readable.

**5. Sessions start automatically.** Opening an agent that has no sessions yet automatically spawns one — a terminal tab running the agent's runtime CLI in its worktree. That's the agent, live. Open more session tabs whenever you want parallel threads of work.

**6. Switch models from the model bar.** Below the session tabs is a quiet row of model logos: **Claude** (the default), **OpenAI** (Codex on GPT-5.5), **Kimi K2.7**, **MiniMax M3**, and **GLM 5.2**. Click any logo to open a new session in the current agent's worktree running that model — the same code, a different model, no context switch.

**7. Connect OpenRouter (first open model only).** The first time you click Kimi, MiniMax, or GLM, ADE asks for your OpenRouter API key (get one at [openrouter.ai/keys](https://openrouter.ai/keys)). Paste it and choose **Save & Launch**. The key is encrypted with the OS credential store, stored locally, and injected only into the agent's terminal — it never leaves your machine and is never shown back to the app's UI. You enter it once; later open-model sessions launch straight away.

**8. Watch the memory grow.** The **Agent Files** panel on the right lists the agent's memory surface, grouped into **Memory**, **Skills**, and **Worktree**. It starts nearly empty and fills in as the agent learns — its identity, your profile, its notes, and any skills it writes for itself. Click a file to open it in a viewer tab.

## How memory works

Every ADE agent keeps a persistent, self-curated memory, adapted from the [Hermes agent](https://github.com/NousResearch/hermes-agent). The design is deliberately simple: plain markdown files the agent reads at the start of every session and writes back to as it learns. The files live outside the git worktree, so they survive branch and worktree churn and are never committed to your code.

Each agent's memory is a small set of files:

- **AGENT.md** — a short identity and operating brief (who the agent is, its role, its standing preferences).
- **USER.md** — a profile of you: name, preferences, communication style, hard rules.
- **MEMORY.md** — the agent's own notes: project conventions, tool quirks, lessons learned, plus an index into any longer topic files.
- **Skills** — reusable, multi-step procedures the agent writes for itself, each a `SKILL.md` whose body loads only when relevant.

A write-back protocol travels with the memory, telling the agent when to save (a stated preference, a correction, a durable fact), when to skip (trivia, one-off state, anything easily re-discovered), and to consolidate rather than endlessly append. A session-end reflection loop prompts the agent to review the conversation and update its memory and skills before it finishes, so the next session starts smarter. On Claude Code this reflection is enforced by a native stop hook; on the other runtimes it runs by convention at session boundaries.

The same canonical files feed every runtime through thin, auto-generated bridge files — a `CLAUDE.md`, an OpenCode config, or a regenerated Codex `AGENTS.md` — so you can switch an agent's runtime without losing its memory. See [docs/memory.md](docs/memory.md) for the full design.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

ADE is a modified derivative of [Superset](https://github.com/superset-sh/superset) (Copyright Superset, Inc.), distributed under the **Elastic License 2.0** — see [LICENSE.md](LICENSE.md). Third-party dependency notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The agent memory architecture is adapted from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT).
