#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_LINK="$HOME/.dotfiles"
DEFAULT_PACKAGES=(
  pi-web-search
  pi-web-fetch
  pi-context-denylist
  tmux
)
BREWFILE="$DOTFILES_DIR/Brewfile"
ARCH_PACKAGES=(
  stow
  tmux
)

print_usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [options] [package...]

Options:
  --dry-run     Show what would change without modifying files
  --unlink      Remove stow links instead of creating/updating them
  --skip-deps   Do not install dependencies/package-manager tools
  -h, --help    Show this help

Examples:
  ./bootstrap.sh
  ./bootstrap.sh --dry-run
  ./bootstrap.sh tmux
  ./bootstrap.sh pi-web-search pi-web-fetch pi-context-denylist
  ./bootstrap.sh --unlink tmux
EOF
}

as_root() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Error: need root privileges to install packages, but sudo is not available." >&2
    exit 1
  fi
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

ensure_arch_linux() {
  if [[ -f /etc/arch-release ]] || command -v pacman >/dev/null 2>&1; then
    return
  fi

  echo "Error: Linux support is currently Arch Linux only." >&2
  echo "Install stow/tmux manually and rerun with --skip-deps, or use an Arch-based host." >&2
  exit 1
}

ensure_arch_packages() {
  local missing=()
  local package

  ensure_arch_linux

  for package in "$@"; do
    if ! command -v "$package" >/dev/null 2>&1; then
      missing+=("$package")
    fi
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    return
  fi

  echo "Installing Arch packages: ${missing[*]}"
  as_root pacman -Syu --needed --noconfirm "${missing[@]}"
}

ensure_dependencies() {
  case "$(uname -s)" in
    Darwin)
      ensure_xcode_clt
      ensure_homebrew
      load_brew_env
      brew bundle --file "$BREWFILE"
      ;;
    Linux)
      ensure_arch_packages "${ARCH_PACKAGES[@]}"
      ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      echo "Install stow manually, then rerun with --skip-deps." >&2
      exit 1
      ;;
  esac
}

validate_packages() {
  local package

  for package in "$@"; do
    if [[ ! -d "$DOTFILES_DIR/$package" ]]; then
      echo "Error: unknown package '$package' (missing $DOTFILES_DIR/$package)." >&2
      exit 1
    fi
  done
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

remove_identical_stow_targets() {
  local package src prefix rel target

  for package in "$@"; do
    prefix="$DOTFILES_DIR/$package/"
    while IFS= read -r -d '' src; do
      rel="${src#$prefix}"
      target="$HOME/$rel"

      if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$src" "$target"; then
        if [[ "$dry_run" == "true" ]]; then
          echo "[dry-run] Remove identical existing target $target so Stow can link it"
        else
          rm "$target"
        fi
      fi
    done < <(find "$DOTFILES_DIR/$package" -type f -print0)
  done
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
install_deps="true"
packages=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run="true"
      ;;
    --unlink)
      mode="unlink"
      ;;
    --skip-deps)
      install_deps="false"
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

validate_packages "${packages[@]}"

if [[ "$mode" == "link" && "$install_deps" == "true" ]]; then
  if [[ "$dry_run" == "true" ]]; then
    case "$(uname -s)" in
      Darwin) echo "[dry-run] Would ensure macOS dependencies with Homebrew" ;;
      Linux) echo "[dry-run] Would ensure Arch Linux dependencies with pacman" ;;
      *) echo "[dry-run] Would check dependencies for unsupported OS: $(uname -s)" ;;
    esac
  else
    ensure_dependencies
  fi
fi

if [[ "$mode" == "link" ]]; then
  ensure_dotfiles_symlink
  remove_identical_stow_targets "${packages[@]}"
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

if command -v stow >/dev/null 2>&1; then
  (
    cd "$DOTFILES_DIR"
    stow "${stow_args[@]}" "${packages[@]}"
  )
elif [[ "$dry_run" == "true" ]]; then
  echo "[dry-run] stow is not installed; would run: stow ${stow_args[*]} ${packages[*]}"
else
  echo "Error: GNU Stow is not installed or not in PATH." >&2
  echo "Install stow or rerun without --skip-deps to let bootstrap install it." >&2
  exit 1
fi

if [[ "$mode" == "link" ]]; then
  ensure_zshrc_sources_dotfiles_pi_zsh
fi

echo "Done."
