#!/usr/bin/env bash
# Build and prove the source workspace's enforcing sandbox without changing
# host security settings. The ordinary addon-only build does not emit Landlock.
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo 'prepare-linux-sandbox requires a Linux CI runner' >&2
  exit 1
fi
if ! command -v musl-gcc >/dev/null 2>&1; then
  sudo apt-get update -q
  sudo apt-get install -yq musl-tools
fi
pnpm --dir native/system run build:ts
pnpm --dir native/system run build:native
NALR_REQUIRE_LANDLOCK=1 pnpm --dir native/system run test:launcher
