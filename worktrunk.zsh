# Worktrunk shell integration (directory switching + zsh completions)
# Managed by ~/code/dotfiles. Requires the `wt` binary from Homebrew/package manager.

# Worktrunk's zsh completions need compinit. If another zsh framework already
# loaded it, this is a no-op.
if [[ -o interactive ]] && ! (( $+functions[compdef] )); then
  autoload -Uz compinit
  compinit -i
fi

if command -v wt >/dev/null 2>&1; then
  eval "$(command wt config shell init zsh)"
fi
