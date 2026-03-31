# dotfiles

Shared scripts/configs for macOS machines, installed with [GNU Stow](https://www.gnu.org/software/stow/).

## Current packages

- `pi-web-search` → `~/.pi/agent/extensions/web-search`
- `pi-web-fetch` → `~/.pi/agent/extensions/web-fetch`

This package-level layout lets machine-specific files coexist safely. Example: a local-only extension in `~/.pi/agent/extensions/internal-work-tool` is untouched by Stow.

## Quick start (new Mac)

Clone anywhere:

```bash
git clone <your-repo-url> <anywhere-you-like>
cd <anywhere-you-like>
./bootstrap.sh
```

What `bootstrap.sh` does:

1. Ensures Xcode Command Line Tools are installed
2. Ensures Homebrew is installed
3. Installs dependencies from `Brewfile` (currently `stow`)
4. Runs Stow with `--no-folding` to link selected packages into `~`
5. Ensures `~/.dotfiles` points to this clone
6. Ensures `~/.zshrc` sources `~/.dotfiles/pi.zsh` (managed block)

## Common commands

Dry run:

```bash
./bootstrap.sh --dry-run
```

Install/relink one package:

```bash
./bootstrap.sh pi-web-search
```

Unlink one package:

```bash
./bootstrap.sh --unlink pi-web-search
```

If you previously managed a file manually and Stow reports a conflict ("existing target is not owned by stow"), remove that one target and rerun bootstrap. Example:

```bash
rm ~/.pi/agent/extensions/web-search/index.ts
./bootstrap.sh pi-web-search

rm ~/.pi/agent/extensions/web-fetch/index.ts
./bootstrap.sh pi-web-fetch
```

## Adding another shared PI extension

Create a new package per extension (recommended):

```text
<package-name>/
  .pi/agent/extensions/<extension-name>/...
```

Then run:

```bash
./bootstrap.sh <package-name>
```

Update `DEFAULT_PACKAGES` in `bootstrap.sh` if you want it included in the default install.

## Shared shell helpers

- `pi.zsh` contains shared zsh helpers for pi.
- `bootstrap.sh` maintains `~/.dotfiles -> <this repo path>`.
- `bootstrap.sh` injects a managed source block into `~/.zshrc` that sources `~/.dotfiles/pi.zsh`.
- Keep machine-specific secrets (API keys, work-only env vars) in a local file that is not tracked in git.
