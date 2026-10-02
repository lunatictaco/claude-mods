# claude-mods

Personal Claude Code mods, as a plugin marketplace.

| Mod | What it shows |
| --- | --- |
| `run-board` | Every background Bash job, Monitor and background subagent: ⟳/✓/✗, label, elapsed time, latest output line, and the exit code in red when one fails. Header: "3 running · 11 done · 1 failed". A toast when a job finishes, a status-line count while jobs run. `/run-board` opens the pane; `/run-board clear` drops finished rows; `/run-board close` closes it and stops it popping open until you run `/run-board` again. |
| `figure-ledger` | Figures (png/svg/pdf…), structures (pdb/psf/dcd…) and data files (csv/npy/h5…) written this session, grouped, newest first, ● new or ↻ rewritten. Each figure shows the notebook and cell (or script line) that names it and the data files that cell references, or "⚠ no notebook cell". Rescans after each Bash call and every minute. `/figure-ledger` opens it; `/figure-ledger close` closes it (it keeps recording); `/figure-ledger clear` empties it. |
| `protein-pet` | A 24-residue chain in a side panel (docked right in fullscreen, inline above the prompt otherwise) that coils into a spiral with its hydrophobic core buried as work finishes: +1 per successful Bash command or answered turn, +3 per finished background job; failures misfold it (red shake, steps lost). Native state → toast, folded count kept across sessions, then a new chain. `/protein` opens the panel, `/protein demo` replays a fold, `/protein close` (or `hide`) closes it and keeps it closed in new sessions, `/protein open` (or `show`), `/protein reset`. |
| `project-tree` | `/tree` shows the project's directory tree in the side panel: folders first, git-tracked and untracked files (ignored files skipped; plain `find` outside git), deeper folders collapsed to a file count, and markers M modified · + new · - deleted · • folder holds changes. Refreshes after edits and shell commands while open. `/tree 5` sets the depth (default 3), `/tree all` expands everything, `/tree close` closes it. |

## Install (every session)

```
/plugin marketplace add lunatictaco/claude-mods
/plugin install run-board@lunatictaco-mods
/plugin install figure-ledger@lunatictaco-mods
/plugin install protein-pet@lunatictaco-mods
/plugin install project-tree@lunatictaco-mods
/reload-plugins
```

User-scope installs load in every session. Update later with `/plugin marketplace update lunatictaco-mods`.

Panes opened unprompted only seat in terminals ≥144 columns; the slash commands open them at any width.
