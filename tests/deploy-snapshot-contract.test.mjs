import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const DEPLOY_DIR = fileURLToPath(new URL("../deploy/tencent-cloud/xmind-site/", import.meta.url));
const SNAPSHOT = path.join(DEPLOY_DIR, "snapshot-host.sh");
const COMPARE = path.join(DEPLOY_DIR, "compare-snapshots.sh");
const HASHED_FILES = [
  "containers.json", "images.json", "networks.json", "volumes.json",
  "listening-ports.tsv", "gateway-contract.json", "gateway-nginx-host.sha256",
  "gateway-nginx-container.sha256", "cert-lineages.tsv", "server-markers.tsv",
  "existing-domains.sha256", "existing-domains.tsv",
];
const CERT_HEADER = [
  "lineage", "renewal_conf", "renewal_sha256", "live_dir", "cert_target",
  "fullchain_target", "cert_sha256", "fullchain_sha256", "fingerprint_sha256",
  "serial", "issuer", "not_before", "not_after", "dns_names",
].join("\t");
const RELEASE_ID = "20260811T010203Z";
const ARTIFACT_SHA = "a".repeat(64);
const EXPECTED_TAG = `xmind-site:${ARTIFACT_SHA.slice(0, 12)}`;

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gatewayContainer({ startedAt = "before", restartCount = 4 } = {}) {
  return {
    Config: { Image: "nginx@sha256:edge", Labels: {} },
    Created: "gateway-created",
    HostConfig: { PortBindings: {}, RestartPolicy: { MaximumRetryCount: 0, Name: "unless-stopped" } },
    Id: "gateway-id", Image: "sha256:gateway", Mounts: [], Name: "/ai_video_nginx",
    Networks: [{ key: "lighthouse_ai_video_net", value: { IPAddress: "172.20.0.2", NetworkID: "network-edge" } }],
    State: { Health: "healthy", RestartCount: restartCount, StartedAt: startedAt },
  };
}

function gatewayContract({ startedAt = "before", restartCount = 4 } = {}) {
  const container = gatewayContainer({ startedAt, restartCount });
  return {
    Config: container.Config, Created: container.Created, Health: container.State.Health,
    HostConfig: container.HostConfig, Id: container.Id, Image: container.Image,
    Mounts: container.Mounts, Networks: container.Networks,
    RestartCount: container.State.RestartCount, StartedAt: container.State.StartedAt,
  };
}

function web({ id, image, configImage = EXPECTED_TAG, startedAt }) {
  return {
    Config: {
      Image: configImage,
      Labels: {
        "com.docker.compose.project": "xmind_site",
        "com.docker.compose.service": "web",
        "com.lute.application": "xmind-site",
        "com.lute.exposure": "lighthouse-gateway-only",
      },
    },
    Created: startedAt,
    HostConfig: {
      PortBindings: { "8080/tcp": [{ HostIp: "172.20.0.1", HostPort: "18888" }] },
      RestartPolicy: { MaximumRetryCount: 0, Name: "unless-stopped" },
    },
    Id: id, Image: image, Mounts: [], Name: "/xmind_site-web-1",
    Networks: [{ key: "xmind_site_internal", value: { IPAddress: "172.30.0.2", NetworkID: "network-xmind" } }],
    State: { Health: "healthy", RestartCount: 0, StartedAt: startedAt },
  };
}

function image({ id, tags, artifact = null }) {
  return {
    Architecture: "amd64", Created: `${id}-created`, Id: id,
    Labels: artifact ? { "com.lute.artifact.sha256": artifact } : {},
    Os: "linux", RepoDigests: [], RepoTags: tags,
  };
}

function network({
  id, name, driver = "bridge", internal = false, attachable = false,
  labels = {}, containers = [], config = [{ Gateway: "172.30.0.1", Subnet: "172.30.0.0/16" }],
} = {}) {
  return {
    Attachable: attachable, Containers: containers, Driver: driver, Id: id,
    IPAM: { Config: config, Driver: "default", Options: null }, Ingress: false,
    Internal: internal, Labels: labels, Name: name,
  };
}

function xmindNetwork(overrides = {}) {
  return network({
    id: "network-xmind",
    name: "xmind_site_internal",
    labels: {
      "com.docker.compose.network": "internal",
      "com.docker.compose.project": "xmind_site",
      "com.docker.compose.version": "2.29.7",
    },
    containers: [{ IPv4Address: "172.30.0.2/16", IPv6Address: "", Name: "xmind_site-web-1" }],
    ...overrides,
  });
}

function edgeNetwork() {
  return network({
    id: "network-edge", name: "lighthouse_ai_video_net",
    labels: { "com.docker.compose.network": "ai_video_net", "com.docker.compose.project": "lighthouse" },
    containers: [{ IPv4Address: "172.20.0.2/16", IPv6Address: "", Name: "ai_video_nginx" }],
    config: [{ Gateway: "172.20.0.1", Subnet: "172.20.0.0/16" }],
  });
}

function certLineage({ lineage = "existing.example", dnsNames = lineage, liveDir, certTarget } = {}) {
  const actualLiveDir = liveDir ?? `/etc/letsencrypt/live/${lineage}`;
  const actualCertTarget = certTarget ?? `/etc/letsencrypt/archive/${lineage}/cert1.pem`;
  return [
    lineage,
    `/etc/letsencrypt/renewal/${lineage}.conf`,
    "1".repeat(64),
    actualLiveDir,
    actualCertTarget,
    `/etc/letsencrypt/archive/${lineage}/fullchain1.pem`,
    "2".repeat(64),
    "3".repeat(64),
    "AA:BB:CC",
    "0123456789ABCDEF",
    "CN=Example Issuer",
    "Aug 11 00:00:00 2026 GMT",
    "Nov  9 00:00:00 2026 GMT",
    dnsNames,
  ].join("\t");
}

function certSnapshot(...rows) {
  return `${[CERT_HEADER, ...rows].join("\n")}\n`;
}

function serverMarkers(blockHash, { begin = 1, end = 1, serverName = 2, proxyPass = 1 } = {}) {
  return `begin\t${begin}\nend\t${end}\nserver_name\t${serverName}\nproxy_pass\t${proxyPass}\nblock_sha256\t${blockHash}\n`;
}

async function writeSnapshot(root, phase, values) {
  const dir = path.join(root, RELEASE_ID, phase);
  await mkdir(dir, { recursive: true });
  const defaults = {
    "containers.json": stable([]), "images.json": stable([]), "networks.json": stable([]), "volumes.json": stable([]),
    "listening-ports.tsv": "LISTEN\t127.0.0.1:80\n", "gateway-contract.json": stable(gatewayContract()),
    "gateway-nginx-host.sha256": "old-config\n", "gateway-nginx-container.sha256": "old-config\n",
    "cert-lineages.tsv": certSnapshot(certLineage()), "server-markers.tsv": serverMarkers("absent", { begin: 0, end: 0, serverName: 0, proxyPass: 0 }),
    "existing-domains.sha256": "domain-list\n", "existing-domains.tsv": "existing.example\t0\t200\t203.0.113.1\t0\n",
    ...values,
  };
  for (const [name, content] of Object.entries(defaults)) await writeFile(path.join(dir, name), content);
  await writeFile(path.join(dir, "release-id.txt"), `${RELEASE_ID}\n`);
  await writeFile(path.join(dir, "phase.txt"), `${phase}\n`);
  await refreshManifest(dir);
}

async function writeReleaseContract(root, serverBlockSha256) {
  const pre = path.join(root, RELEASE_ID, "pre");
  const contract = stable({
    artifact_sha256: ARTIFACT_SHA,
    image_tag: EXPECTED_TAG,
    release_id: RELEASE_ID,
    schema_version: 1,
    server_block_sha256: serverBlockSha256,
  });
  await writeFile(path.join(pre, "release-contract.json"), contract);
  const digest = createHash("sha256").update(contract).digest("hex");
  await writeFile(path.join(pre, "release-contract.sha256"), `${digest}  release-contract.json\n`);
}

async function refreshManifest(dir) {
  const lines = [];
  for (const name of HASHED_FILES) {
    const content = await readFile(path.join(dir, name));
    lines.push(`${createHash("sha256").update(content).digest("hex")}  ${name}`);
  }
  await writeFile(path.join(dir, "snapshot-files.sha256"), `${lines.join("\n")}\n`);
}

async function runCompare(root, mode, artifact = ARTIFACT_SHA) {
  try {
    const result = await execFileAsync("bash", [COMPARE, RELEASE_ID, mode, artifact], {
      env: { ...process.env, XMIND_AUDIT_ROOT: root },
    });
    return { code: 0, ...result };
  } catch (runError) {
    return { code: runError.code, stdout: runError.stdout, stderr: runError.stderr };
  }
}

async function createUpgrade(root, mutate = () => {}) {
  const oldImage = image({
    id: "sha256:old",
    tags: [EXPECTED_TAG],
    artifact: ARTIFACT_SHA,
  });
  const candidate = image({ id: "sha256:new", tags: [EXPECTED_TAG], artifact: ARTIFACT_SHA });
  const commonImage = image({ id: "sha256:gateway", tags: ["nginx:edge"] });
  const shared = {
    gateway: gatewayContainer(),
    network: xmindNetwork(),
    certs: certSnapshot(certLineage()),
    markers: serverMarkers("stable-block"),
  };
  await writeSnapshot(root, "pre", {
    "containers.json": stable([shared.gateway, web({ id: "web-old", image: oldImage.Id, configImage: EXPECTED_TAG, startedAt: "old" })]),
    "images.json": stable([commonImage, oldImage]),
    "networks.json": stable([shared.network]),
    "gateway-contract.json": stable(gatewayContract()),
    "cert-lineages.tsv": shared.certs,
    "server-markers.tsv": shared.markers,
  });
  await writeReleaseContract(root, "stable-block");
  const post = {
    containers: [shared.gateway, web({ id: "web-new", image: candidate.Id, startedAt: "new" })],
    images: [
      commonImage,
      image({
        id: oldImage.Id,
        tags: [`xmind-site:rollback-${RELEASE_ID}`],
        artifact: ARTIFACT_SHA,
      }),
      candidate,
    ],
    network: shared.network,
    certs: shared.certs,
    markers: shared.markers,
  };
  mutate(post);
  await writeSnapshot(root, "post", {
    "containers.json": stable(post.containers),
    "images.json": stable(post.images),
    "networks.json": stable([post.network]),
    "gateway-contract.json": stable(gatewayContract()),
    "cert-lineages.tsv": post.certs,
    "server-markers.tsv": post.markers,
  });
}

async function createFirstInstall(root, mutate = () => {}) {
  const commonImage = image({ id: "sha256:gateway", tags: ["nginx:edge"] });
  const candidate = image({ id: "sha256:new", tags: [EXPECTED_TAG], artifact: ARTIFACT_SHA });
  await writeSnapshot(root, "pre", {
    "containers.json": stable([gatewayContainer()]),
    "images.json": stable([commonImage]),
    "networks.json": stable([edgeNetwork()]),
    "gateway-contract.json": stable(gatewayContract()),
  });
  await writeReleaseContract(root, "candidate-block");
  const post = {
    containers: [gatewayContainer({ startedAt: "after", restartCount: 5 }), web({ id: "web-new", image: candidate.Id, startedAt: "new" })],
    images: [commonImage, candidate],
    networks: [edgeNetwork(), xmindNetwork()],
    certs: certSnapshot(certLineage(), certLineage({ lineage: "xmind.lute-tlz-dddd.top" })),
    markers: serverMarkers("candidate-block"),
  };
  mutate(post);
  await writeSnapshot(root, "post", {
    "containers.json": stable(post.containers),
    "images.json": stable(post.images),
    "networks.json": stable(post.networks),
    "listening-ports.tsv": "LISTEN\t127.0.0.1:80\nLISTEN\t172.20.0.1:18888\n",
    "gateway-contract.json": stable(gatewayContract({ startedAt: "after", restartCount: 5 })),
    "gateway-nginx-host.sha256": "new-config\n", "gateway-nginx-container.sha256": "new-config\n",
    "cert-lineages.tsv": post.certs,
    "server-markers.tsv": post.markers,
  });
}

async function withSnapshots(create, mutate, assertion) {
  const root = await mkdtemp(path.join(tmpdir(), "xmind-snapshot-"));
  try {
    await create(root, mutate);
    await assertion(await runCompare(root, create === createUpgrade ? "upgrade" : "first_install"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("snapshot producer schema matches the comparator fixtures and stays outside Docker", async () => {
  await execFileAsync("bash", ["-n", SNAPSHOT]);
  await execFileAsync("bash", ["-n", COMPARE]);
  const [dockerignore, snapshotSource, runbook] = await Promise.all([
    readFile(path.join(DEPLOY_DIR, ".dockerignore"), "utf8"),
    readFile(SNAPSHOT, "utf8"),
    readFile(path.join(DEPLOY_DIR, "RUNBOOK.md"), "utf8"),
  ]);
  assert.match(dockerignore, /^\*\*$/m);
  assert.doesNotMatch(dockerignore, /!snapshot-host|!compare-snapshots/);
  assert.match(snapshotSource, /Id, Name, Driver, Internal, Attachable, Ingress, IPAM, Labels/);
  assert.match(snapshotSource, /lineage\\trenewal_conf\\trenewal_sha256\\tlive_dir/);
  assert.match(snapshotSource, /fingerprint_sha256\\tserial\\tissuer\\tnot_before\\tnot_after\\tdns_names/);
  assert.match(runbook, /release-contract[.]json/);
  assert.match(runbook, /server_block_sha256/);
  assert.match(runbook, /sha256sum release-contract[.]json > release-contract[.]sha256/);
});

test("upgrade binds the running web and rollback hold to the candidate image", async (t) => {
  await withSnapshots(createUpgrade, () => {}, ({ code, stdout, stderr }) => assert.equal(code, 0, `${stdout}\n${stderr}`));

  const mutations = [
    ["candidate image was only loaded", (post) => {
      post.containers[1] = web({ id: "web-new", image: "sha256:old", configImage: EXPECTED_TAG, startedAt: "new" });
    }],
    ["container image reference is not the artifact tag", (post) => {
      post.containers[1].Config.Image = "xmind-site:wrong";
    }],
    ["rollback hold tag is absent", (post) => {
      post.images[1].RepoTags = [];
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => withSnapshots(createUpgrade, mutate, ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${name} must fail closed\n${stdout}\n${stderr}`);
    }));
  }
});

test("first install binds web, network, certificate, and marker to the release contract", async (t) => {
  await withSnapshots(createFirstInstall, () => {}, ({ code, stdout, stderr }) => assert.equal(code, 0, `${stdout}\n${stderr}`));

  const mutations = [
    ["web runs the gateway image", (post) => {
      post.containers[1].Image = "sha256:gateway";
    }],
    ["network has the wrong driver and isolation mode", (post) => {
      post.networks[1] = xmindNetwork({ driver: "host", internal: true });
    }],
    ["web points at a different network identity", (post) => {
      post.containers[1].Networks[0].value.NetworkID = "network-impostor";
    }],
    ["certificate has a bogus live path and extra SAN", (post) => {
      post.certs = certSnapshot(
        certLineage(),
        certLineage({
          lineage: "xmind.lute-tlz-dddd.top",
          dnsNames: "evil.example,xmind.lute-tlz-dddd.top",
          liveDir: "/tmp/fake-lineage",
        }),
      );
    }],
    ["server marker is not the candidate block", (post) => {
      post.markers = serverMarkers("arbitrary-block");
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => withSnapshots(createFirstInstall, mutate, ({ code, stdout, stderr }) => {
      assert.notEqual(code, 0, `${name} must fail closed\n${stdout}\n${stderr}`);
    }));
  }
});
