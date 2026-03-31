#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_LINK="$HOME/.dotfiles"
DEFAULT_PACKAGES=(
  pi-web-search
  pi-web-fetch
)

print_usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [options] [package...]

Options:
  --dry-run   Show what stow would do
  --unlink    Remove stow links instead of creating/updating them
  -h, --help  Show this help

Examples:
  ./bootstrap.sh
  ./bootstrap.sh --dry-run
  ./bootstrap.sh pi-web-search pi-web-fetch
  ./bootstrap.sh --unlink pi-web-search
EOF
}

ensure_xcode_clt() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi

  echo "Installing Xcode Command Line Tools..."
  xcode-select --install || true
  echo "Please finish the Xcode Command Line Tools installation, then rerun ./bootstrap.sh"
  exit 1
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  echo "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
}

load_brew_env() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_dotfiles_symlink() {
  if [[ "$dry_run" == "true" ]]; then
    echo "[dry-run] Ensure $DOTFILES_LINK -> $DOTFILES_DIR"
    return
  fi

  if [[ -L "$DOTFILES_LINK" ]]; then
    if [[ "$(cd "$DOTFILES_LINK" 2>/dev/null && pwd -P || true)" == "$DOTFILES_DIR" ]]; then
      return
    fi
    ln -sfn "$DOTFILES_DIR" "$DOTFILES_LINK"
    return
  fi

  if [[ -e "$DOTFILES_LINK" ]]; then
    echo "Error: $DOTFILES_LINK exists and is not a symlink. Move/remove it and rerun bootstrap." >&2
    exit 1
  fi

  ln -s "$DOTFILES_DIR" "$DOTFILES_LINK"
}

ensure_zshrc_sources_dotfiles_pi_zsh() {
  local zshrc="$HOME/.zshrc"
  local marker_start="# >>> dotfiles pi.zsh >>>"
  local marker_end="# <<< dotfiles pi.zsh <<<"
  local source_line='[[ -r "$HOME/.dotfiles/pi.zsh" ]] && source "$HOME/.dotfiles/pi.zsh"'
  local tmp

  if [[ "$dry_run" == "true" ]]; then
    echo "[dry-run] Ensure $zshrc sources $HOME/.dotfiles/pi.zsh"
    return
  fi

  if [[ ! -f "$zshrc" ]]; then
    {
      printf "%s\n" "$marker_start"
      printf "%s\n" "$source_line"
      printf "%s\n" "$marker_end"
    } > "$zshrc"
    return
  fi

  tmp="$(mktemp)"
  awk -v start="$marker_start" -v end="$marker_end" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    skip != 1 { print }
  ' "$zshrc" > "$tmp"

  mv "$tmp" "$zshrc"

  {
    printf "\n%s\n" "$marker_start"
    printf "%s\n" "$source_line"
    printf "%s\n" "$marker_end"
  } >> "$zshrc"
}

mode="link"
dry_run="false"
packages=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run="true"
      ;;
    --unlink)
      mode="unlink"
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      packages+=("$1")
      ;;
  esac
  shift
done

if [[ ${#packages[@]} -eq 0 ]]; then
  packages=("${DEFAULT_PACKAGES[@]}")
fi

ensure_xcode_clt
ensure_homebrew
load_brew_env

if [[ "$mode" == "link" ]]; then
  ensure_dotfiles_symlink
  
  brew bundle --file "$DOTFILES_DIR/Brewfile"
fi

stow_args=(--no-folding -t "$HOME")
if [[ "$dry_run" == "true" ]]; then
  stow_args+=(-n -v)
fi

if [[ "$mode" == "link" ]]; then
  stow_args+=(-R)
else
  stow_args+=(-D)
fi

(
  cd "$DOTFILES_DIR"
  stow "${stow_args[@]}" "${packages[@]}"
)

if [[ "$mode" == "link" ]]; then
  ensure_zshrc_sources_dotfiles_pi_zsh
fi

echo "Done."
