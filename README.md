# claude-mods

Personal Claude Code mods, as a plugin marketplace.

| Mod | What it shows |
| --- | --- |
| `run-board` | Every background Bash job, Monitor and background subagent: ⟳/✓/✗, label, elapsed time, latest output line, and the exit code in red when one fails. Header: "3 running · 11 done · 1 failed". A toast when a job finishes, a status-line count while jobs run. `/run-board` opens the pane; `/run-board clear` drops finished rows. |
| `figure-ledger` | Figures (png/svg/pdf…), structures (pdb/psf/dcd…) and data files (csv/npy/h5…) written this session, grouped, newest first, ● new or ↻ rewritten. Each figure shows the notebook and cell (or script line) that names it and the data files that cell references, or "⚠ no notebook cell". Rescans after each Bash call and every minute. `/figure-ledger` opens it; `/figure-ledger clear` empties it. |

## Install (every session)

```
/plugin marketplace add lunatictaco/claude-mods
/plugin install run-board@lunatictaco-mods
/plugin install figure-ledger@lunatictaco-mods
/reload-plugins
```

User-scope installs load in every session. Update later with `/plugin marketplace update lunatictaco-mods`.

Panes opened unprompted only seat in terminals ≥144 columns; the slash commands open them at any width.
