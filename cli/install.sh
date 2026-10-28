#!/bin/sh
# OpenTandem installer for macOS and Linux. Node.js does not need to be installed.
#   curl -fsSL https://opentandem.org/install.sh -o install.sh && sh install.sh remote
# Installs the pinned Node.js runtime (checked against a pinned sha256) and the launcher, then runs
# `opentandem <arguments>` (default: remote). The launcher keeps the CLI and the Runner up to date.
set -u

SERVER='__SERVER_ORIGIN__'
NODE_VERSION='__NODE_VERSION__'

fail() { printf '✗ %s\n' "$1" >&2; exit 1; }
# Same language rule as the CLI: the system display language (macOS AppleLanguages, otherwise LC_ALL/LC_MESSAGES/LANG).
LOCALE=$(defaults read -g AppleLanguages 2>/dev/null | tr -d ' \n"()' | cut -c1-2)
[ -n "$LOCALE" ] || LOCALE=$(printf %.2s "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}")
say() { if [ "$LOCALE" = zh ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Missing system command: $1"; }
need curl
need tar
[ -n "${HOME:-}" ] || fail 'Cannot determine the home directory.'

case "$(uname -s)" in
  Darwin) PLATFORM=darwin; ROOT="$HOME/Library/Application Support/OpenTandem"; SHA_CMD='shasum -a 256' ;;
  Linux) PLATFORM=linux; ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/opentandem"; SHA_CMD='sha256sum' ;;
  *) fail "Unsupported system: $(uname -s). On Windows run: irm $SERVER/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac
case "$PLATFORM-$ARCH" in
  darwin-arm64) NODE_SHA='__SHA_DARWIN_ARM64__' ;;
  darwin-x64) NODE_SHA='__SHA_DARWIN_X64__' ;;
  linux-arm64) NODE_SHA='__SHA_LINUX_ARM64__' ;;
  linux-x64) NODE_SHA='__SHA_LINUX_X64__' ;;
esac
INSTANCE=$(printf '%s' "$SERVER" | sed -E 's#^https?://##; s#:#_#')
RUNTIME="$ROOT/runtime/node-v$NODE_VERSION-$PLATFORM-$ARCH"
NODE="$RUNTIME/bin/node"
mkdir -p "$ROOT/runtime" "$ROOT/$INSTANCE" || fail "Cannot create $ROOT"

if [ ! -x "$NODE" ]; then
  say '→ Downloading the Node.js runtime (one time, about 30 MB)…' '→ 正在下载 Node.js 运行环境（只需一次，约 30 MB）…'
  # Unpack inside the install folder, not /tmp: on some Linux systems /tmp is a small in-memory disk.
  STAGE=$(mktemp -d "$ROOT/runtime/.stage-XXXXXX") || fail 'Cannot create a temporary folder.'
  trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
  # The mirror first (one attempt), then nodejs.org; both are checked against the same pinned sha256 below.
  case "$PLATFORM" in darwin) EXT=tar.gz ;; *) EXT=tar.xz ;; esac
  curl -fL --compressed --connect-timeout 15 "$SERVER/api/runner-runtime/$ARCH?platform=$PLATFORM" -o "$STAGE/node.tar" \
    || curl -fL --compressed --connect-timeout 15 --retry 2 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$PLATFORM-$ARCH.$EXT" -o "$STAGE/node.tar" \
    || fail 'Node.js download failed. Check your network and try again.'
  [ "$($SHA_CMD "$STAGE/node.tar" | awk '{print $1}')" = "$NODE_SHA" ] || fail 'Node.js checksum mismatch. Installation stopped.'
  mkdir "$STAGE/node" && tar -xf "$STAGE/node.tar" -C "$STAGE/node" --strip-components=1 || fail 'Cannot extract Node.js.'
  rm -rf "$RUNTIME" && mv "$STAGE/node" "$RUNTIME" || fail 'Cannot install Node.js.'
  rm -rf "$STAGE"
fi

LAUNCHER="$ROOT/$INSTANCE/launcher.mjs"
# The temporary copy keeps the .mjs extension: `node --check` refuses unknown extensions.
NEXT="$ROOT/$INSTANCE/launcher.next.mjs"
curl -fsSL --connect-timeout 15 --retry 2 "$SERVER/api/cli-script?file=launcher.mjs" -o "$NEXT" \
  && "$NODE" --check "$NEXT" && mv "$NEXT" "$LAUNCHER" || fail 'Cannot download OpenTandem. Check your network and try again.'

[ $# -gt 0 ] || set -- remote
OPENTANDEM_SERVER="$SERVER" exec "$NODE" "$LAUNCHER" "$@"
