# dotfiles

Shared scripts/configs for macOS and Arch Linux machines, installed with [GNU Stow](https://www.gnu.org/software/stow/).

## Current packages

- `pi-web-search` → `~/.pi/agent/extensions/web-search`
- `pi-web-fetch` → `~/.pi/agent/extensions/web-fetch`
- `pi-context-denylist` → `~/.pi/agent/extensions/context-denylist` and `~/.pi/context-denylist`
- Pi package `npm:@plannotator/pi-extension` installed via `pi install`
- `tmux` → `~/.config/tmux/tmux.conf`
- Worktrunk shell integration is sourced into `~/.zshrc` and `~/.bashrc` from `worktrunk.zsh` / `worktrunk.bash`.

This package-level layout lets machine-specific files coexist safely. Example: a local-only extension in `~/.pi/agent/extensions/internal-work-tool` is untouched by Stow.

## Quick start

Clone anywhere:

```bash
git clone <your-repo-url> <anywhere-you-like>
cd <anywhere-you-like>
./bootstrap.sh
```

What `bootstrap.sh` does:

1. Detects macOS vs Arch Linux
2. Installs dependencies:
   - macOS: Xcode Command Line Tools, Homebrew, then `brew bundle` from `Brewfile` (including the current `pi-coding-agent` formula)
   - Arch Linux: `stow` and `tmux` via `pacman`
3. Ensures `~/.dotfiles` points to this clone
4. Removes pre-existing target files only when they are identical to the tracked file, so Stow can link them safely
5. Runs Stow with `--no-folding` to link selected packages into `~`
6. Removes stale/conflicting Pi installs from mise Node and `~/.local` when a Homebrew-backed Pi is present
7. Pins Pi package operations to Homebrew npm via `~/.pi/agent/settings.json` `npmCommand`
8. Ensures configured Pi packages are listed in settings and installed with `pi install`
9. Ensures `~/.zshrc` sources `~/.dotfiles/pi.zsh` and Worktrunk zsh integration, and `~/.bashrc` sources Worktrunk bash integration (managed blocks)

Open a new shell after the first bootstrap (or run `exec zsh`) so the managed
`pi` shell function takes effect in the current terminal.

## Common commands

Dry run:

```bash
./bootstrap.sh --dry-run
```

Install/relink one package:

```bash
./bootstrap.sh tmux
```

Install without trying to install system dependencies:

```bash
./bootstrap.sh --skip-deps
```

Unlink one package:

```bash
./bootstrap.sh --unlink tmux
```

If Stow reports a conflict ("existing target is not owned by stow"), compare and move/remove that target, then rerun bootstrap. Identical files are handled automatically.

## Pi context denylist

Edit `~/.pi/context-denylist` with one path/glob per line. Matching `AGENTS.md` context files and skills are filtered out of the model system prompt, but remain readable on demand. Run `/reload` or restart Pi after editing it.

Example:

```text
~/code/factorial/AGENTS.md
~/code/factorial/.agents
**/noisy-skill/**
```

Note: Pi's startup header may still report denied context/skill files because resource discovery happens before the extension rewrites the prompt for model calls.

## Adding another shared Pi extension

For published Pi packages, add their source to `PI_PACKAGES` in `bootstrap.sh`.

For local/stowed extensions, create a new package per extension (recommended):

```text
<package-name>/
  .pi/agent/extensions/<extension-name>/...
```

Then run:

```bash
./bootstrap.sh <package-name>
```

Update `DEFAULT_PACKAGES` in `bootstrap.sh` if you want a local/stowed extension included in the default install.

## Shared shell helpers

- `pi.zsh` contains shared zsh helpers for pi and pins Pi to Homebrew's Node/npm when available, so mise-selected Node versions do not change Pi's install/update target.
- `worktrunk.zsh` / `worktrunk.bash` load `wt config shell init ...` for directory switching and completions.
- `bootstrap.sh` maintains `~/.dotfiles -> <this repo path>`.
- `bootstrap.sh` injects managed source blocks into `~/.zshrc` and `~/.bashrc`.
- Keep machine-specific secrets (API keys, work-only env vars) in a local file that is not tracked in git.
