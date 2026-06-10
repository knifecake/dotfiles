# Shared pi shell helpers (managed by ~/code/dotfiles)

# Prefer Homebrew's pi + node so behavior is consistent across directories.
# This avoids mise/asdf-selected Node/npm prefixes changing which global pi runs.
_dotfiles_pi_prefix=""
for _dotfiles_candidate in /opt/homebrew /home/linuxbrew/.linuxbrew; do
  if [ -x "$_dotfiles_candidate/bin/pi" ] && [ -x "$_dotfiles_candidate/bin/node" ] && [ -x "$_dotfiles_candidate/bin/npm" ]; then
    _dotfiles_pi_prefix="$_dotfiles_candidate"
    break
  fi
done
unset _dotfiles_candidate

if [ -n "$_dotfiles_pi_prefix" ]; then
  pi() {
    "$_dotfiles_pi_prefix/bin/node" "$_dotfiles_pi_prefix/bin/pi" "$@"
  }

  pi-update() {
    "$_dotfiles_pi_prefix/bin/npm" install -g --ignore-scripts --min-release-age=0 --no-fund --no-audit @earendil-works/pi-coding-agent@latest && \
      "$_dotfiles_pi_prefix/bin/node" "$_dotfiles_pi_prefix/bin/pi" --version
  }
fi

# Keep machine-specific secrets outside this repo.
# Example (in ~/.zshrc.local or ~/.config/zsh/local.zsh):
#   export EXA_API_KEY='...'
#   export BRAVE_API_KEY='...'
