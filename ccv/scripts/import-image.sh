#!/usr/bin/env bash
# Imports a local Docker image into the k3d node's containerd, for the node's own platform only.
#
#   ccv/scripts/import-image.sh kirchhoff/judge:dev
#
# Why not `k3d image import`: with Docker's containerd image store, a pulled image is a multi-platform index whose
# other-platform blobs are absent locally, and k3d's import then fails ("content digest ... not found") or reports
# success without importing anything. `docker save --platform` exports exactly the node's platform.
set -euo pipefail
image="${1:?usage: import-image.sh <image>}"
node="${K3D_NODE:-k3d-kirchhoff-server-0}"
platform="linux/$(docker exec "$node" uname -m | sed -e 's/aarch64/arm64/' -e 's/x86_64/amd64/')"
docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet --platform "$platform" "$image" >/dev/null
docker save --platform "$platform" "$image" | docker exec -i "$node" ctr -n k8s.io images import - >/dev/null
docker exec "$node" crictl inspecti "$image" >/dev/null || { echo "import of $image failed" >&2; exit 1; }
echo "imported $image ($platform) into $node"
