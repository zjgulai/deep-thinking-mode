#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 2)); then
  echo "usage: snapshot-host.sh <release-id> <pre|post>" >&2
  exit 64
fi
release_id=$1
phase=$2
[[ $release_id =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ $phase == pre || $phase == post ]]

audit_root=${XMIND_AUDIT_ROOT:-/opt/xmind-site/audit}
current_root=${XMIND_CURRENT_ROOT:-/opt/xmind-site/current}
gateway_name=${XMIND_GATEWAY_NAME:-ai_video_nginx}
gateway_config=${XMIND_GATEWAY_CONFIG:-/opt/ai-video/deploy/lighthouse/nginx.conf}
domains_file=${XMIND_EXISTING_DOMAINS_FILE:-$current_root/existing-domains.txt}
output="$audit_root/$release_id/$phase"

for command in curl docker jq openssl sha256sum ss; do
  command -v "$command" >/dev/null
done
test -f "$domains_file"
test -f "$gateway_config"
if [[ -e $output ]]; then
  echo "refusing to overwrite snapshot: $output" >&2
  exit 1
fi
install -d -m 0700 "$output"
printf '%s\n' "$release_id" > "$output/release-id.txt"
printf '%s\n' "$phase" > "$output/phase.txt"

mapfile -t domains < <(sed '/^[[:space:]]*$/d' "$domains_file")
test "${#domains[@]}" -eq 32
test "$(printf '%s\n' "${domains[@]}" | LC_ALL=C sort -u | wc -l)" -eq 32
cmp -s <(printf '%s\n' "${domains[@]}") "$domains_file"
sha256sum "$domains_file" | awk '{print $1}' > "$output/existing-domains.sha256"

mapfile -t container_ids < <(docker container ls -aq --no-trunc | LC_ALL=C sort)
if ((${#container_ids[@]})); then
  docker container inspect "${container_ids[@]}" | jq -S '[.[] | {
    Id, Image, Name, Created,
    Config: {Image: .Config.Image, Labels: .Config.Labels},
    HostConfig: {RestartPolicy: .HostConfig.RestartPolicy, PortBindings: .HostConfig.PortBindings},
    Mounts: [.Mounts[] | {Type, Source, Destination, RW, Name}] | sort_by(.Destination),
    Networks: (.NetworkSettings.Networks | to_entries | map({key, value: {NetworkID: .value.NetworkID, IPAddress: .value.IPAddress}}) | sort_by(.key)),
    State: {StartedAt: .State.StartedAt, RestartCount: .RestartCount, Health: .State.Health.Status}
  }] | sort_by(.Id)' > "$output/containers.json"
else
  printf '[]\n' > "$output/containers.json"
fi

mapfile -t image_ids < <(docker image ls -aq --no-trunc | LC_ALL=C sort -u)
if ((${#image_ids[@]})); then
  docker image inspect "${image_ids[@]}" | jq -S '[.[] | {
    Id, RepoTags: ((.RepoTags // []) | sort), RepoDigests: ((.RepoDigests // []) | sort),
    Architecture, Os, Created, Labels: (.Config.Labels // {})
  }] | sort_by(.Id)' > "$output/images.json"
else
  printf '[]\n' > "$output/images.json"
fi

mapfile -t network_ids < <(docker network ls -q --no-trunc | LC_ALL=C sort -u)
docker network inspect "${network_ids[@]}" | jq -S '[.[] | {
  Id, Name, Driver, Internal, Attachable, Ingress, IPAM, Labels,
  Containers: (.Containers | to_entries | map({Name: .value.Name, IPv4Address: .value.IPv4Address, IPv6Address: .value.IPv6Address}) | sort_by(.Name))
}] | sort_by(.Name)' > "$output/networks.json"

mapfile -t volume_names < <(docker volume ls -q | LC_ALL=C sort -u)
if ((${#volume_names[@]})); then
  docker volume inspect "${volume_names[@]}" | jq -S '[.[] | {Name, Driver, Mountpoint, Labels, Options, Scope}] | sort_by(.Name)' > "$output/volumes.json"
else
  printf '[]\n' > "$output/volumes.json"
fi

ss -H -ltn | awk '{print $1 "\t" $4}' | LC_ALL=C sort -u > "$output/listening-ports.tsv"
docker container inspect "$gateway_name" | jq -S '.[0] | {
  Id, Image, Created,
  Config: {Image: .Config.Image, Labels: .Config.Labels},
  HostConfig: {RestartPolicy: .HostConfig.RestartPolicy, PortBindings: .HostConfig.PortBindings},
  Mounts: [.Mounts[] | {Type, Source, Destination, RW, Name}] | sort_by(.Destination),
  Networks: (.NetworkSettings.Networks | to_entries | map({key, value: {NetworkID: .value.NetworkID, IPAddress: .value.IPAddress}}) | sort_by(.key)),
  StartedAt: .State.StartedAt, RestartCount: .RestartCount, Health: .State.Health.Status
}' > "$output/gateway-contract.json"
sha256sum "$gateway_config" | awk '{print $1}' > "$output/gateway-nginx-host.sha256"
docker exec "$gateway_name" sha256sum /etc/nginx/nginx.conf | awk '{print $1}' > "$output/gateway-nginx-container.sha256"

cert_output="$output/cert-lineages.tsv"
printf 'lineage\trenewal_conf\trenewal_sha256\tlive_dir\tcert_target\tfullchain_target\tcert_sha256\tfullchain_sha256\tfingerprint_sha256\tserial\tissuer\tnot_before\tnot_after\tdns_names\n' > "$cert_output"
shopt -s nullglob
for renewal in /etc/letsencrypt/renewal/*.conf; do
  lineage=$(basename "$renewal" .conf)
  live="/etc/letsencrypt/live/$lineage"
  renewal_sha=$(sha256sum "$renewal" | awk '{print $1}')
  cert_target=$(readlink -f "$live/cert.pem")
  fullchain_target=$(readlink -f "$live/fullchain.pem")
  cert_sha=$(sha256sum "$cert_target" | awk '{print $1}')
  fullchain_sha=$(sha256sum "$fullchain_target" | awk '{print $1}')
  fingerprint=$(openssl x509 -in "$cert_target" -noout -fingerprint -sha256 | sed 's/^[^=]*=//')
  serial=$(openssl x509 -in "$cert_target" -noout -serial | sed 's/^[^=]*=//')
  issuer=$(openssl x509 -in "$cert_target" -noout -issuer | sed 's/^[^=]*=//')
  not_before=$(openssl x509 -in "$cert_target" -noout -startdate | sed 's/^[^=]*=//')
  not_after=$(openssl x509 -in "$cert_target" -noout -enddate | sed 's/^[^=]*=//')
  dns_names=$(
    openssl x509 -in "$cert_target" -noout -ext subjectAltName \
      | grep -o 'DNS:[^,[:space:]]*' \
      | sed 's/^DNS://' \
      | LC_ALL=C sort -u \
      | paste -sd, -
  )
  for field in "$lineage" "$renewal" "$renewal_sha" "$live" "$cert_target" \
    "$fullchain_target" "$cert_sha" "$fullchain_sha" "$fingerprint" "$serial" \
    "$issuer" "$not_before" "$not_after" "$dns_names"; do
    [[ $field != *$'\t'* && $field != *$'\n'* && -n $field ]]
  done
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$lineage" "$renewal" "$renewal_sha" "$live" "$cert_target" \
    "$fullchain_target" "$cert_sha" "$fullchain_sha" "$fingerprint" "$serial" \
    "$issuer" "$not_before" "$not_after" "$dns_names" >> "$cert_output"
done
{
  head -n 1 "$cert_output"
  tail -n +2 "$cert_output" | LC_ALL=C sort
} > "$cert_output.sorted"
mv "$cert_output.sorted" "$cert_output"

begin_count=$(grep -Fc '# BEGIN xmind.lute-tlz-dddd.top' "$gateway_config" || true)
end_count=$(grep -Fc '# END xmind.lute-tlz-dddd.top' "$gateway_config" || true)
server_count=$(grep -Ec '^[[:space:]]*server_name[[:space:]]+xmind[.]lute-tlz-dddd[.]top;' "$gateway_config" || true)
proxy_count=$(grep -Fc 'proxy_pass http://172.20.0.1:18888;' "$gateway_config" || true)
block_sha=absent
if ((begin_count == 1 && end_count == 1)); then
  block_sha=$(sed -n '/# BEGIN xmind[.]lute-tlz-dddd[.]top/,/# END xmind[.]lute-tlz-dddd[.]top/p' "$gateway_config" | sha256sum | awk '{print $1}')
fi
printf 'begin\t%s\nend\t%s\nserver_name\t%s\nproxy_pass\t%s\nblock_sha256\t%s\n' \
  "$begin_count" "$end_count" "$server_count" "$proxy_count" "$block_sha" > "$output/server-markers.tsv"

domain_failures=0
: > "$output/existing-domains.tsv"
for domain in "${domains[@]}"; do
  set +e
  metrics=$(curl --silent --show-error --output /dev/null --max-time 20 \
    --write-out '%{http_code}\t%{remote_ip}\t%{ssl_verify_result}' "https://$domain/")
  curl_rc=$?
  set -e
  printf '%s\t%s\t%s\n' "$domain" "$curl_rc" "$metrics" >> "$output/existing-domains.tsv"
  if ((curl_rc != 0)) || [[ ${metrics##*$'\t'} != 0 ]]; then
    domain_failures=$((domain_failures + 1))
  fi
done
test "$domain_failures" -eq 0

(
  cd "$output"
  sha256sum containers.json images.json networks.json volumes.json listening-ports.tsv \
    gateway-contract.json gateway-nginx-host.sha256 gateway-nginx-container.sha256 \
    cert-lineages.tsv server-markers.tsv existing-domains.sha256 existing-domains.tsv \
    > snapshot-files.sha256
)
chown -R ubuntu:ubuntu "$output"
