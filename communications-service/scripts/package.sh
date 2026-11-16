#!/usr/bin/env bash
set -euo pipefail
service_root="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$service_root/dist}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
version="$(cat "$service_root/VERSION")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then exit 1; fi
commit="$(git -C "$service_root" rev-parse HEAD)"
if [[ -n "$(git -C "$service_root" status --porcelain --untracked-files=normal -- .)" ]]; then commit="$commit-dirty"; fi
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
build_platforms="${COMMUNICATIONS_BUILD_PLATFORMS:-darwin/arm64 darwin/amd64 linux/arm64 linux/amd64}"
for platform in $build_platforms; do
  case "$platform" in darwin/arm64|darwin/amd64|linux/arm64|linux/amd64) ;; *) echo "Unsupported target: $platform" >&2; exit 1 ;; esac
  target_os="${platform%/*}"; target_arch="${platform#*/}"
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  env CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go -C "$service_root" build -trimpath -ldflags "-s -w -X github.com/zsa233/workspace-workbench/communications-service/internal/httpapi.Version=$version -X github.com/zsa233/workspace-workbench/communications-service/internal/httpapi.Commit=$commit -X github.com/zsa233/workspace-workbench/communications-service/internal/httpapi.BuildTime=$built_at" -o "$stage/project-communications" ./cmd/project-communications
  cp "$service_root/README.md" "$stage/README.md"
  cp -R "$service_root/deploy" "$stage/deploy"
  tar -czf "$output/project-communications-$version-$target_os-$target_arch.tar.gz" -C "$stage" project-communications README.md deploy
  rm -rf "$stage"; trap - EXIT
  echo "Built $platform"
done
cd "$output"
if command -v sha256sum >/dev/null; then sha256sum project-communications-"$version"-*.tar.gz > SHA256SUMS; else shasum -a 256 project-communications-"$version"-*.tar.gz > SHA256SUMS; fi
