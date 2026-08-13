# Shared pi shell helpers (managed by ~/code/dotfiles)

# Prefer Homebrew's pi so behavior is consistent across machines.
if [ -x /opt/homebrew/bin/pi ]; then
  pi() {
    /opt/homebrew/bin/pi "$@"
  }
fi

# Update pi quickly.
alias pi-update='brew update && brew upgrade pi-coding-agent && brew link --overwrite pi-coding-agent && /opt/homebrew/bin/pi --version'

# Keep machine-specific secrets outside this repo.
# Example (in ~/.zshrc.local or ~/.config/zsh/local.zsh):
#   export EXA_API_KEY='...'
#   export BRAVE_API_KEY='...'
