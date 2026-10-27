# J.A.R.V.I.S. HUD for Claude Code

A Claude Code mod that shows your remaining tokens and acts before you run out.

- **Band above the prompt.** One line showing context left, and your 5-hour and weekly plan quotas with reset timers:
  ```
  ◢ CTX ▰▰▰▰▰▰▱▱▱▱ 48K · 5H ▰▰▰▱▱ 58% ↻2h14m · 7D ▰▰▰▰▱ 81% ↻3d4h
  ```
  It goes from Claude orange to amber to red as things fill up. On narrow windows it drops detail rather than wrapping.
- **HUD pane** (`/jarvis`, or click `◢`):
  - **Gauge:** an animated arc-reactor ring for context, with inner rings for your quotas.
  - **Projections:** tokens used per turn, turns left until compaction, and when the 5-hour quota runs out at your current pace.
  - **Where it went:** a donut chart of what's filling your context, plus a tip for the biggest consumer.
  - **Buttons and log:** one-click controls and a log of every alert and action.
- **Alerts:**
  - Toasts at 70, 85 and 95% context, and at 75 and 90% of a quota. Critical levels also send a system notification.
  - A warning before a file read that would use a large share of the remaining context.
- **Acts for you:** past 85% context, it compacts the conversation once the current turn ends. It keeps goals, decisions, files touched and open TODOs.

> The desktop app's Code tab shows the full graphical HUD. In a terminal you get the same band and a text version of the pane.

---

## Requirements

- **Claude Code with mod support.** Tested on CLI 2.1.286 and the desktop app. Check yours with `claude --version`.
- **Access to this repository.** It is **private**, so each person needs:
  1. To be invited as a collaborator on GitHub (ask the owner).
  2. A GitHub credential that git can use. The install never asks for a password. Setup is below.

### One-time GitHub setup

**Windows** (PowerShell):

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```

Close and reopen PowerShell so the new commands are found, then:

```powershell
gh auth login
gh auth setup-git
```

**macOS** (Terminal):

```bash
brew install git gh
gh auth login
gh auth setup-git
```

No Homebrew? Install it from <https://brew.sh>, or install the GitHub CLI from <https://cli.github.com>.

For `gh auth login`, choose **GitHub.com** → **HTTPS** → **Login with a web browser**.

---

## Install

### Option A: plugin install (recommended)

This works the same on Windows and macOS. It takes two steps: add this repository as a marketplace, then install the mod from it.

**From a shell** (PowerShell on Windows, Terminal on macOS):

```bash
claude plugin marketplace add JarvisStriker/jarvis-hud
claude plugin install jarvis-hud@jarvis-hud
```

**Or from inside Claude Code** (an interactive terminal session):

```
/plugin marketplace add JarvisStriker/jarvis-hud
/plugin install jarvis-hud@jarvis-hud
```

**In the desktop app:** click **+** next to the prompt box, then **Plugins** → **Add marketplace**, enter `JarvisStriker/jarvis-hud`, and click **Add plugin** on *jarvis-hud*.

It installs at the **user** scope by default, so it loads in every new session, in the terminal and in the desktop app's Code tab.

> Newer Claude Code versions also take a one-liner: `/plugin install jarvis-hud --marketplace JarvisStriker/jarvis-hud`.

### Option B: clone and load from a folder

Use this if you want to edit the mod yourself. Changes reload automatically in interactive sessions.

**Windows** (PowerShell):

```powershell
git clone https://github.com/JarvisStriker/jarvis-hud.git "$env:USERPROFILE\.claude\mods\jarvis-hud"
```

**macOS** (Terminal):

```bash
git clone https://github.com/JarvisStriker/jarvis-hud.git ~/.claude/mods/jarvis-hud
```

Then add the folder to your **user** settings file:

| OS | Settings file | Value |
| --- | --- | --- |
| Windows | `%USERPROFILE%\.claude\settings.json` | `C:\\Users\\<you>\\.claude\\mods\\jarvis-hud` |
| macOS | `~/.claude/settings.json` | `/Users/<you>/.claude/mods/jarvis-hud` |

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\.claude\\mods\\jarvis-hud"
  }
}
```

If the file already has content, add only the `env` block, or merge it into an existing `env`.

To load several mod folders, separate them with `;` on Windows and `:` on macOS.

To try it once without changing settings:

```bash
claude --plugin-dir ~/.claude/mods/jarvis-hud
```

---

## Check that it works

Start a new session. The band should appear above the prompt right away:

```
◢ JARVIS online · 200K context window · gauges light up after the first reply
```

Send any prompt and the gauges fill in. Run `/jarvis status` for a text briefing.

---

## Commands

| Command | What it does |
| --- | --- |
| `/jarvis` | Open the HUD pane |
| `/jarvis status` | Briefing: context, burn rate, quotas, settings |
| `/jarvis compact` | Compact the conversation now |
| `/jarvis auto on\|off\|<30-98>` | Turn auto-compact on or off, or set its threshold (default 85%) |
| `/jarvis guard on\|off` | Warn before large file reads (default on) |
| `/jarvis voice on\|off` | Speak alerts aloud (default off; see the platform notes) |
| `/jarvis band on\|off` | Show or hide the band |

When the pane has focus, its buttons also respond to keys: `c` compact, `a` auto-compact, `g` read guard, `v` voice, `b` band, `r` rescan.

Settings are saved and carry over between sessions.

---

## Platform notes

| | Windows | macOS |
| --- | --- | --- |
| Graphical HUD (gauge, donut) | Desktop app Code tab | Desktop app Code tab |
| Terminal colours | Windows Terminal: full colour | iTerm2, Ghostty, kitty: full colour. Terminal.app: approximate |
| Voice alerts | Not available: a toast appears instead | Uses the built-in `say` voice |
| System notifications | Uses your Claude Code notification setting | Uses your Claude Code notification setting |

- **Pane in the terminal:** it only opens by itself if the terminal is at least 144 columns wide. Otherwise run `/jarvis`.
- **Plan quotas** appear only on a Claude subscription (Pro/Max). With an API key you see context only.
- **Network:** the mod makes no network requests.

---

## Update

- **Option A:**
  ```bash
  claude plugin marketplace update jarvis-hud
  claude plugin update jarvis-hud@jarvis-hud
  ```
  Then restart Claude Code, or run `/reload-plugins` in an open session.
- **Option B:** run `git pull` in the mod folder. Open sessions reload automatically.

## Uninstall

- **Option A:**
  ```bash
  claude plugin uninstall jarvis-hud@jarvis-hud
  claude plugin marketplace remove jarvis-hud
  ```
- **Option B:** remove the `CLAUDE_CODE_PLUGIN_DIRS` entry from your settings, then delete the folder.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No band at all | Start a **new** session after installing. Run `claude plugin list` and check that `jarvis-hud` is listed and enabled. For Option B, check the path in `settings.json`, including doubled `\\` on Windows. |
| `Marketplace file not found` | Your GitHub account can't read the repo. Accept the invite, then run `gh auth status`. |
| Install hangs or asks for a password | Run `gh auth setup-git` so git can use your GitHub login. |
| Band says "gauges light up after the first reply" | Normal for a new session. Send a prompt. |
| `/jarvis` in Git Bash on Windows opens a path | Git Bash rewrites `/jarvis`. Type it inside Claude Code, not as a shell command. |
| Anything else | Start with `claude --debug` and look for lines starting with `jarvis-hud:`. |

---

## Development

```bash
claude plugin validate .
claude plugin test .
```

The logic is in `hooks/register.tsx`, the state contract in `types/index.d.ts`, and the tests in `tests/hud.test.tsx`.
