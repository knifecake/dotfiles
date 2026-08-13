# Shared pi shell helpers (managed by ~/code/dotfiles)

# Prefer Homebrew's pi so behavior is consistent across directories.
# This avoids mise/asdf-selected Node/npm prefixes changing which global pi runs.
_dotfiles_pi_prefix=""
for _dotfiles_candidate in /opt/homebrew /home/linuxbrew/.linuxbrew; do
  if [ -x "$_dotfiles_candidate/bin/pi" ] && [ -x "$_dotfiles_candidate/bin/brew" ]; then
    _dotfiles_pi_prefix="$_dotfiles_candidate"
    break
  fi
done
unset _dotfiles_candidate

if [ -n "$_dotfiles_pi_prefix" ]; then
  pi() {
    "$_dotfiles_pi_prefix/bin/pi" "$@"
  }

  pi-update() {
    "$_dotfiles_pi_prefix/bin/brew" update && \
      "$_dotfiles_pi_prefix/bin/brew" upgrade pi-coding-agent && \
      "$_dotfiles_pi_prefix/bin/brew" link --overwrite pi-coding-agent && \
      "$_dotfiles_pi_prefix/bin/pi" --version
  }
fi
# Keep machine-specific secrets outside this repo.
# Example (in ~/.zshrc.local or ~/.config/zsh/local.zsh):
#   export EXA_API_KEY='...'
#   export BRAVE_API_KEY='...'
