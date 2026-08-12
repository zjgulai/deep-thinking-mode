#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 3)); then
  echo "usage: compare-snapshots.sh <release-id> <first_install|upgrade> <64-char-artifact-sha>" >&2
  exit 64
fi
release_id=$1
mode=$2
artifact_sha=$3
[[ $release_id =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ $mode == first_install || $mode == upgrade ]]
[[ $artifact_sha =~ ^[0-9a-f]{64}$ ]]

audit_root=${XMIND_AUDIT_ROOT:-/opt/xmind-site/audit}
pre="$audit_root/$release_id/pre"
post="$audit_root/$release_id/post"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for snapshot in "$pre" "$post"; do
  test "$(cat "$snapshot/release-id.txt")" = "$release_id"
  (cd "$snapshot" && sha256sum -c snapshot-files.sha256)
done
test "$(cat "$pre/phase.txt")" = pre
test "$(cat "$post/phase.txt")" = post
cmp "$pre/existing-domains.sha256" "$post/existing-domains.sha256"
cmp "$pre/existing-domains.tsv" "$post/existing-domains.tsv"
cmp "$pre/volumes.json" "$post/volumes.json"

jq -S '[.[] | select((.Config.Labels["com.docker.compose.project"] // "") != "xmind_site")]' "$pre/containers.json" > "$work/pre-non-xmind-containers.json"
jq -S '[.[] | select((.Config.Labels["com.docker.compose.project"] // "") != "xmind_site")]' "$post/containers.json" > "$work/post-non-xmind-containers.json"

jq -r '.[].Id' "$pre/images.json" | LC_ALL=C sort > "$work/pre-image-ids.txt"
jq -r '.[].Id' "$post/images.json" | LC_ALL=C sort > "$work/post-image-ids.txt"
test ! -s <(comm -23 "$work/pre-image-ids.txt" "$work/post-image-ids.txt")
comm -13 "$work/pre-image-ids.txt" "$work/post-image-ids.txt" > "$work/new-image-ids.txt"
test "$(wc -l < "$work/new-image-ids.txt")" -eq 1
candidate_id=$(jq -r --arg sha "$artifact_sha" '.[] | select(.Labels["com.lute.artifact.sha256"] == $sha) | .Id' "$post/images.json")
test "$candidate_id" = "$(cat "$work/new-image-ids.txt")"
while read -r old_id; do
  jq -S --arg id "$old_id" '.[] | select(.Id == $id) | del(.RepoTags)' "$pre/images.json" > "$work/pre-old-image.json"
  jq -S --arg id "$old_id" '.[] | select(.Id == $id) | del(.RepoTags)' "$post/images.json" > "$work/post-old-image.json"
  cmp "$work/pre-old-image.json" "$work/post-old-image.json"
done < "$work/pre-image-ids.txt"

candidate_count=$(jq --arg sha "$artifact_sha" '[.[] | select(.Labels["com.lute.artifact.sha256"] == $sha)] | length' "$post/images.json")
test "$candidate_count" -eq 1
jq -e --arg sha "$artifact_sha" '.[] | select(.Labels["com.lute.artifact.sha256"] == $sha) | .RepoTags | any(startswith("xmind-site:"))' "$post/images.json" >/dev/null
expected_tag="xmind-site:${artifact_sha:0:12}"
jq -e --arg sha "$artifact_sha" --arg tag "$expected_tag" '.[] | select(.Labels["com.lute.artifact.sha256"] == $sha) | .RepoTags | index($tag) != null' "$post/images.json" >/dev/null

if [[ $mode == upgrade ]]; then
  cmp "$work/pre-non-xmind-containers.json" "$work/post-non-xmind-containers.json"
  cmp "$pre/networks.json" "$post/networks.json"
  cmp "$pre/listening-ports.tsv" "$post/listening-ports.tsv"
  cmp "$pre/gateway-contract.json" "$post/gateway-contract.json"
  cmp "$pre/gateway-nginx-host.sha256" "$post/gateway-nginx-host.sha256"
  cmp "$pre/gateway-nginx-container.sha256" "$post/gateway-nginx-container.sha256"
  cmp "$pre/cert-lineages.tsv" "$post/cert-lineages.tsv"
  cmp "$pre/server-markers.tsv" "$post/server-markers.tsv"
  test "$(jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site" and .Config.Labels["com.docker.compose.service"] == "web")] | length' "$pre/containers.json")" -eq 1
  test "$(jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site" and .Config.Labels["com.docker.compose.service"] == "web")] | length' "$post/containers.json")" -eq 1
  test "$(jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site")] | length' "$pre/containers.json")" -eq 1
  test "$(jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site")] | length' "$post/containers.json")" -eq 1
  jq -S '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site" and .Config.Labels["com.docker.compose.service"] == "web") | del(.Id,.Image,.Created,.Config.Image,.State.StartedAt)]' "$pre/containers.json" > "$work/pre-xmind-web-static.json"
  jq -S '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site" and .Config.Labels["com.docker.compose.service"] == "web") | del(.Id,.Image,.Created,.Config.Image,.State.StartedAt)]' "$post/containers.json" > "$work/post-xmind-web-static.json"
  cmp "$work/pre-xmind-web-static.json" "$work/post-xmind-web-static.json"
  while read -r old_id; do
    jq -e --arg id "$old_id" '.[] | select(.Id == $id)' "$post/images.json" >/dev/null
  done < <(jq -r '.[] | select((.RepoTags // []) | any(startswith("xmind-site:"))) | .Id' "$pre/images.json")
else
  jq -S '[.[] | select((.Config.Labels["com.docker.compose.project"] // "") != "xmind_site" and .Name != "/ai_video_nginx")]' "$pre/containers.json" > "$work/pre-non-xmind-non-gateway.json"
  jq -S '[.[] | select((.Config.Labels["com.docker.compose.project"] // "") != "xmind_site" and .Name != "/ai_video_nginx")]' "$post/containers.json" > "$work/post-non-xmind-non-gateway.json"
  cmp "$work/pre-non-xmind-non-gateway.json" "$work/post-non-xmind-non-gateway.json"
  test "$(jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site")] | length' "$pre/containers.json")" -eq 0
  test "$(jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site")] | length' "$post/containers.json")" -eq 1
  test "$(jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "xmind_site" and .Config.Labels["com.docker.compose.service"] == "web")] | length' "$post/containers.json")" -eq 1
  test "$(jq '[.[] | select(.Name == "xmind_site_internal")] | length' "$pre/networks.json")" -eq 0
  test "$(jq '[.[] | select(.Name == "xmind_site_internal")] | length' "$post/networks.json")" -eq 1
  jq -S '[.[] | select(.Name != "xmind_site_internal")]' "$pre/networks.json" > "$work/pre-non-xmind-networks.json"
  jq -S '[.[] | select(.Name != "xmind_site_internal")]' "$post/networks.json" > "$work/post-non-xmind-networks.json"
  cmp "$work/pre-non-xmind-networks.json" "$work/post-non-xmind-networks.json"
  grep -Fx $'LISTEN\t172.20.0.1:18888' "$post/listening-ports.tsv" >/dev/null
  grep -Fxv $'LISTEN\t172.20.0.1:18888' "$post/listening-ports.tsv" > "$work/post-ports-without-xmind.tsv"
  cmp "$pre/listening-ports.tsv" "$work/post-ports-without-xmind.tsv"
  jq -S 'del(.StartedAt,.RestartCount,.Health)' "$pre/gateway-contract.json" > "$work/pre-gateway-static.json"
  jq -S 'del(.StartedAt,.RestartCount,.Health)' "$post/gateway-contract.json" > "$work/post-gateway-static.json"
  cmp "$work/pre-gateway-static.json" "$work/post-gateway-static.json"
  test "$(jq -r '.RestartCount' "$post/gateway-contract.json")" -eq "$(( $(jq -r '.RestartCount' "$pre/gateway-contract.json") + 1 ))"
  cmp "$post/gateway-nginx-host.sha256" "$post/gateway-nginx-container.sha256"
  ! cmp -s "$pre/gateway-nginx-host.sha256" "$post/gateway-nginx-host.sha256"
  awk -F '\t' '$1 != "xmind.lute-tlz-dddd.top"' "$post/cert-lineages.tsv" > "$work/post-non-xmind-certs.tsv"
  awk -F '\t' '$1 != "xmind.lute-tlz-dddd.top"' "$pre/cert-lineages.tsv" > "$work/pre-non-xmind-certs.tsv"
  cmp "$work/pre-non-xmind-certs.tsv" "$work/post-non-xmind-certs.tsv"
  test "$(awk -F '\t' '$1 == "xmind.lute-tlz-dddd.top" { count++ } END { print count+0 }' "$pre/cert-lineages.tsv")" -eq 0
  test "$(awk -F '\t' '$1 == "xmind.lute-tlz-dddd.top" { count++ } END { print count+0 }' "$post/cert-lineages.tsv")" -eq 1
  grep -Fx $'begin\t0' "$pre/server-markers.tsv" >/dev/null
  grep -Fx $'end\t0' "$pre/server-markers.tsv" >/dev/null
  grep -Fx $'server_name\t0' "$pre/server-markers.tsv" >/dev/null
  grep -Fx $'proxy_pass\t0' "$pre/server-markers.tsv" >/dev/null
  grep -Fx $'begin\t1' "$post/server-markers.tsv" >/dev/null
  grep -Fx $'end\t1' "$post/server-markers.tsv" >/dev/null
  grep -Fx $'server_name\t2' "$post/server-markers.tsv" >/dev/null
  grep -Fx $'proxy_pass\t1' "$post/server-markers.tsv" >/dev/null
fi
