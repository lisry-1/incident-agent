#!/usr/bin/env bash
set -euo pipefail
umask 077
incident_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
incident_tools="$incident_root/data/incident-k8s/bin"
case "$(uname -m)" in
  x86_64) incident_arch=amd64 ;;
  aarch64|arm64) incident_arch=arm64 ;;
  *) echo 'This lab supports Linux amd64/arm64.' >&2; exit 1 ;;
esac
[ "$(uname -s)" = Linux ] || { echo 'Run this installer inside WSL Ubuntu.' >&2; exit 1; }
incident_tmp="$(mktemp -d)"
trap 'rm -rf -- "$incident_tmp"' EXIT
mkdir -p -- "$incident_tools"
curl -fLsS --retry 2 --connect-timeout 10 --max-time 60 \
  "https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-$incident_arch" -o "$incident_tmp/kind"
curl -fLsS --retry 2 --connect-timeout 10 --max-time 60 \
  "https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-$incident_arch.sha256sum" -o "$incident_tmp/kind.sum"
incident_kind_sha="$(awk 'NR==1 {print $1}' "$incident_tmp/kind.sum")"
[[ "$incident_kind_sha" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Invalid kind checksum.' >&2; exit 1; }
printf '%s  %s\n' "$incident_kind_sha" "$incident_tmp/kind" | sha256sum --check --status
curl -fLsS --retry 2 --connect-timeout 10 --max-time 60 \
  "https://dl.k8s.io/release/v1.37.0/bin/linux/$incident_arch/kubectl" -o "$incident_tmp/kubectl"
curl -fLsS --retry 2 --connect-timeout 10 --max-time 60 \
  "https://dl.k8s.io/release/v1.37.0/bin/linux/$incident_arch/kubectl.sha256" -o "$incident_tmp/kubectl.sum"
incident_kubectl_sha="$(tr -d '[:space:]' < "$incident_tmp/kubectl.sum")"
[[ "$incident_kubectl_sha" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Invalid kubectl checksum.' >&2; exit 1; }
printf '%s  %s\n' "$incident_kubectl_sha" "$incident_tmp/kubectl" | sha256sum --check --status
install -m 700 "$incident_tmp/kind" "$incident_tools/kind"
install -m 700 "$incident_tmp/kubectl" "$incident_tools/kubectl"
"$incident_tools/kind" version
"$incident_tools/kubectl" version --client
