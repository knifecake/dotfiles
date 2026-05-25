# Worktrunk shell integration (directory switching + bash completions)
# Managed by ~/code/dotfiles. Requires the `wt` binary from Homebrew/package manager.

if command -v wt >/dev/null 2>&1; then
  eval "$(command wt config shell init bash)"
fi
