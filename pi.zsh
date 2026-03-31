# Shared pi shell helpers (managed by ~/code/dotfiles)

# Prefer Homebrew's pi + node so behavior is consistent across machines.
if [ -x /opt/homebrew/bin/pi ] && [ -x /opt/homebrew/bin/node ]; then
  pi() {
    /opt/homebrew/bin/node /opt/homebrew/bin/pi "$@"
  }
fi

# Update pi quickly.
alias pi-update='/opt/homebrew/bin/npm install -g @mariozechner/pi-coding-agent@latest && /opt/homebrew/bin/node /opt/homebrew/bin/pi --version'

# Keep machine-specific secrets outside this repo.
# Example (in ~/.zshrc.local or ~/.config/zsh/local.zsh):
#   export EXA_API_KEY='...'
#   export BRAVE_API_KEY='...'
