#!/usr/bin/env bash
# Reads the published image from the GitHub container registry, for the
# release workflow. Only reads: the registry's own HTTP API, so the answer
# does not depend on which Docker credentials a machine happens to hold.
#
#   scripts/registry.sh digest <tag>      prints the tag's digest, or nothing
#   scripts/registry.sh sbom <tag> <file> writes the SPDX bill of materials
#                                         attached to the image at build time
#
# The repository comes from GITHUB_REPOSITORY. With GH_TOKEN and
# GITHUB_ACTOR set, it signs in, which a private package needs. Without
# them it reads anonymously, which a public package allows.
set -euo pipefail

repo="${GITHUB_REPOSITORY:-jasonsdevspace/inventory-reservations}"
repo="${repo,,}"
api="https://ghcr.io/v2/$repo"
index='application/vnd.oci.image.index.v1+json'
manifest='application/vnd.oci.image.manifest.v1+json'

scope="https://ghcr.io/token?scope=repository:$repo:pull&service=ghcr.io"
if [ -n "${GH_TOKEN:-}" ] && [ -n "${GITHUB_ACTOR:-}" ]; then
    token=$(curl -fsS -u "$GITHUB_ACTOR:$GH_TOKEN" "$scope" | jq -r .token)
else
    token=$(curl -fsS "$scope" | jq -r .token)
fi
auth="Authorization: Bearer $token"

# A tag that does not exist answers 404, which prints nothing rather than
# failing, so a caller can ask whether a tag is free.
digest() {
    local status
    status=$(curl -sS -o /dev/null -w '%{http_code}' -I -H "$auth" -H "Accept: $index" "$api/manifests/$1")
    case "$status" in
        200) curl -fsSI -H "$auth" -H "Accept: $index" "$api/manifests/$1" |
            tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }' ;;
        404) ;;
        *) echo "the registry answered $status for $1" >&2; exit 1 ;;
    esac
}

# The image index lists an attestation manifest beside the image, and its
# SPDX layer is an in-toto statement whose predicate is the document.
sbom() {
    local attestation layer
    attestation=$(curl -fsS -H "$auth" -H "Accept: $index" "$api/manifests/$1" |
        jq -r '[.manifests[] | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest")][0].digest')
    layer=$(curl -fsS -H "$auth" -H "Accept: $manifest" "$api/manifests/$attestation" |
        jq -r '[.layers[] | select(.annotations["in-toto.io/predicate-type"] == "https://spdx.dev/Document")][0].digest')
    if [ "$layer" = "null" ] || [ -z "$layer" ]; then
        echo "the image at $1 carries no SPDX bill of materials" >&2
        exit 1
    fi
    curl -fsSL -H "$auth" "$api/blobs/$layer" | jq '.predicate' > "$2"
}

case "${1:-}" in
    digest) digest "$2" ;;
    sbom) sbom "$2" "$3" ;;
    *) echo "usage: scripts/registry.sh digest <tag> | sbom <tag> <file>" >&2; exit 2 ;;
esac
