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
PI_PACKAGES=(
  "npm:@plannotator/pi-extension"
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

find_homebrew_pi_prefix() {
  local prefix

  for prefix in /opt/homebrew /home/linuxbrew/.linuxbrew; do
    if [[ -x "$prefix/bin/pi" && -x "$prefix/bin/node" && -x "$prefix/bin/npm" ]]; then
      printf "%s\n" "$prefix"
      return 0
    fi
  done

  return 1
}

pi_bin_points_to_coding_agent() {
  local bin_path="$1"
  local target

  [[ -e "$bin_path" || -L "$bin_path" ]] || return 1
  target="$(readlink "$bin_path" 2>/dev/null || true)"
  [[ "$target" == *pi-coding-agent* ]]
}

cleanup_conflicting_pi_installs() {
  local brew_prefix mise_node_dir prefix local_prefix
  local removed="false"

  brew_prefix="$(find_homebrew_pi_prefix || true)"
  if [[ -z "$brew_prefix" ]]; then
    return
  fi

  # If pi was installed globally under mise-managed Node versions, cwd-specific
  # mise activation can shadow the Homebrew-backed pi wrapper from pi.zsh.
  mise_node_dir="$HOME/.local/share/mise/installs/node"
  if [[ -d "$mise_node_dir" ]]; then
    for prefix in "$mise_node_dir"/*; do
      [[ -e "$prefix" ]] || continue
      if pi_bin_points_to_coding_agent "$prefix/bin/pi" || [[ -d "$prefix/lib/node_modules/@mariozechner/pi-coding-agent" || -d "$prefix/lib/node_modules/@earendil-works/pi-coding-agent" ]]; then
        if [[ "$dry_run" == "true" ]]; then
          echo "[dry-run] Remove conflicting pi install under $prefix"
        else
          if pi_bin_points_to_coding_agent "$prefix/bin/pi"; then
            rm -f "$prefix/bin/pi"
          fi
          rm -rf "$prefix/lib/node_modules/@mariozechner/pi-coding-agent"
          rm -rf "$prefix/lib/node_modules/@earendil-works/pi-coding-agent"
          rmdir "$prefix/lib/node_modules/@mariozechner" "$prefix/lib/node_modules/@earendil-works" 2>/dev/null || true
        fi
        removed="true"
      fi
    done
  fi

  # Also remove the installer fallback location when Homebrew pi is present.
  local_prefix="$HOME/.local"
  if pi_bin_points_to_coding_agent "$local_prefix/bin/pi" || [[ -d "$local_prefix/lib/node_modules/@mariozechner/pi-coding-agent" || -d "$local_prefix/lib/node_modules/@earendil-works/pi-coding-agent" ]]; then
    if [[ "$dry_run" == "true" ]]; then
      echo "[dry-run] Remove conflicting pi install under $local_prefix"
    else
      if pi_bin_points_to_coding_agent "$local_prefix/bin/pi"; then
        rm -f "$local_prefix/bin/pi"
      fi
      rm -rf "$local_prefix/lib/node_modules/@mariozechner/pi-coding-agent"
      rm -rf "$local_prefix/lib/node_modules/@earendil-works/pi-coding-agent"
      rmdir "$local_prefix/lib/node_modules/@mariozechner" "$local_prefix/lib/node_modules/@earendil-works" 2>/dev/null || true
    fi
    removed="true"
  fi

  if [[ "$removed" == "true" ]]; then
    echo "Using Homebrew-backed pi at $brew_prefix/bin/pi"
  fi
}

ensure_pi_settings() {
  local brew_prefix settings_file npm_path node_path

  brew_prefix="$(find_homebrew_pi_prefix || true)"
  settings_file="$HOME/.pi/agent/settings.json"
  npm_path=""
  node_path=""

  if [[ -n "$brew_prefix" ]]; then
    npm_path="$brew_prefix/bin/npm"
    node_path="$brew_prefix/bin/node"
  elif command -v node >/dev/null 2>&1; then
    node_path="$(command -v node)"
  fi

  if [[ "$dry_run" == "true" ]]; then
    if [[ -n "$npm_path" ]]; then
      echo "[dry-run] Ensure $settings_file sets npmCommand to [$npm_path]"
    fi
    echo "[dry-run] Ensure $settings_file includes Pi packages: ${PI_PACKAGES[*]}"
    return
  fi

  if [[ -z "$node_path" ]]; then
    echo "Warning: node is not available; skipping Pi settings update for packages: ${PI_PACKAGES[*]}" >&2
    return
  fi

  mkdir -p "${settings_file%/*}"
  "$node_path" - "$npm_path" "$settings_file" "${PI_PACKAGES[@]}" <<'NODE'
const fs = require("fs");
const [npmPath, settingsFile, ...packageSources] = process.argv.slice(2);
let settings = {};
if (fs.existsSync(settingsFile)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch {
    settings = {};
  }
}

if (npmPath) {
  settings.npmCommand = [npmPath];
}

function sourceOf(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.source === "string") return entry.source;
  return undefined;
}

function npmName(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const versionAt = slash === -1 ? -1 : spec.indexOf("@", slash + 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

function identity(source) {
  if (source.startsWith("npm:")) return `npm:${npmName(source.slice(4))}`;
  return source;
}

const packages = Array.isArray(settings.packages) ? settings.packages : [];
const identities = new Set(packages.map(sourceOf).filter(Boolean).map(identity));
for (const source of packageSources) {
  const key = identity(source);
  if (!identities.has(key)) {
    packages.push(source);
    identities.add(key);
  }
}
if (packages.length > 0) {
  settings.packages = packages;
}

fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
NODE
}

run_pi_command() {
  local brew_prefix

  brew_prefix="$(find_homebrew_pi_prefix || true)"
  if [[ -n "$brew_prefix" ]]; then
    "$brew_prefix/bin/node" "$brew_prefix/bin/pi" "$@"
    return
  fi

  if command -v pi >/dev/null 2>&1; then
    pi "$@"
    return
  fi

  return 127
}

ensure_pi_packages_installed() {
  local source

  if [[ ${#PI_PACKAGES[@]} -eq 0 ]]; then
    return
  fi

  if [[ "$dry_run" == "true" ]]; then
    echo "[dry-run] Install/reconcile Pi packages with pi install: ${PI_PACKAGES[*]}"
    return
  fi

  for source in "${PI_PACKAGES[@]}"; do
    echo "Installing Pi package $source"
    if ! run_pi_command install "$source"; then
      echo "Warning: failed to install Pi package $source; ensure pi is installed and rerun bootstrap." >&2
    fi
  done
}

ensure_shell_rc_sources_dotfiles_file() {
  local rc_file="$1"
  local dotfiles_file="$2"
  local marker_label="$3"
  local marker_start="# >>> dotfiles $marker_label >>>"
  local marker_end="# <<< dotfiles $marker_label <<<"
  local source_line="[[ -r \"\$HOME/.dotfiles/$dotfiles_file\" ]] && source \"\$HOME/.dotfiles/$dotfiles_file\""
  local tmp

  if [[ "$dry_run" == "true" ]]; then
    echo "[dry-run] Ensure $rc_file sources $HOME/.dotfiles/$dotfiles_file"
    return
  fi

  if [[ ! -f "$rc_file" ]]; then
    {
      printf "%s\n" "$marker_start"
      printf "%s\n" "$source_line"
      printf "%s\n" "$marker_end"
    } > "$rc_file"
    return
  fi

  tmp="$(mktemp)"
  awk -v start="$marker_start" -v end="$marker_end" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    skip != 1 { print }
  ' "$rc_file" > "$tmp"

  mv "$tmp" "$rc_file"

  {
    printf "\n%s\n" "$marker_start"
    printf "%s\n" "$source_line"
    printf "%s\n" "$marker_end"
  } >> "$rc_file"
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
  cleanup_conflicting_pi_installs
  ensure_pi_settings
  ensure_pi_packages_installed
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
  ensure_shell_rc_sources_dotfiles_file "$HOME/.zshrc" "pi.zsh" "pi.zsh"
  ensure_shell_rc_sources_dotfiles_file "$HOME/.zshrc" "worktrunk.zsh" "worktrunk.zsh"
  ensure_shell_rc_sources_dotfiles_file "$HOME/.bashrc" "worktrunk.bash" "worktrunk.bash"
fi

echo "Done."
