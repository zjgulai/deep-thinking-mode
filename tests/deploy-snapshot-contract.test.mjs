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
const RELEASE_ID = "20260811T010203Z";
const ARTIFACT_SHA = "a".repeat(64);

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gateway({ startedAt = "before", restartCount = 4 } = {}) {
  return {
    Config: { Image: "nginx@sha256:edge", Labels: {} },
    Created: "gateway-created", Health: "healthy", HostConfig: { PortBindings: {}, RestartPolicy: { Name: "unless-stopped" } },
    Id: "gateway-id", Image: "sha256:gateway", Mounts: [], Name: "/ai_video_nginx",
    Networks: [], RestartCount: restartCount, StartedAt: startedAt,
  };
}

function web({ id, image, startedAt }) {
  return {
    Config: { Image: `xmind-site:${image.slice(-12)}`, Labels: { "com.docker.compose.project": "xmind_site", "com.docker.compose.service": "web" } },
    Created: startedAt, HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "172.20.0.1", HostPort: "18888" }] }, RestartPolicy: { Name: "unless-stopped" } },
    Id: id, Image: image, Mounts: [], Name: "/xmind_site-web-1", Networks: [{ key: "xmind_site_internal", value: { IPAddress: "172.30.0.2", NetworkID: "network-xmind" } }],
    State: { Health: "healthy", RestartCount: 0, StartedAt: startedAt },
  };
}

function image({ id, tags, artifact = null }) {
  return { Architecture: "amd64", Created: id, Id: id, Labels: artifact ? { "com.lute.artifact.sha256": artifact } : {}, Os: "linux", RepoDigests: [], RepoTags: tags };
}

async function writeSnapshot(root, phase, values) {
  const dir = path.join(root, RELEASE_ID, phase);
  await mkdir(dir, { recursive: true });
  const defaults = {
    "containers.json": stable([]), "images.json": stable([]), "networks.json": stable([]), "volumes.json": stable([]),
    "listening-ports.tsv": "LISTEN\t127.0.0.1:80\n", "gateway-contract.json": stable(gateway()),
    "gateway-nginx-host.sha256": "old-config\n", "gateway-nginx-container.sha256": "old-config\n",
    "cert-lineages.tsv": "existing.example\tstable-cert\n", "server-markers.tsv": "begin\t0\nend\t0\nserver_name\t0\nproxy_pass\t0\nblock_sha256\tabsent\n",
    "existing-domains.sha256": "domain-list\n", "existing-domains.tsv": "existing.example\t0\t200\t203.0.113.1\t0\n",
    ...values,
  };
  for (const [name, content] of Object.entries(defaults)) await writeFile(path.join(dir, name), content);
  await writeFile(path.join(dir, "release-id.txt"), `${RELEASE_ID}\n`);
  await writeFile(path.join(dir, "phase.txt"), `${phase}\n`);
  await refreshManifest(dir);
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

test("deployment snapshot scripts have valid Bash syntax and remain outside Docker allowlist", async () => {
  await execFileAsync("bash", ["-n", SNAPSHOT]);
  await execFileAsync("bash", ["-n", COMPARE]);
  const dockerignore = await readFile(path.join(DEPLOY_DIR, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\*\*$/m);
  assert.doesNotMatch(dockerignore, /!snapshot-host|!compare-snapshots/);
});

test("upgrade permits only the xmind web/image replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xmind-snapshot-upgrade-"));
  try {
    const oldImage = image({ id: "sha256:old", tags: ["xmind-site:old"] });
    const candidate = image({ id: "sha256:new", tags: [`xmind-site:${ARTIFACT_SHA.slice(0, 12)}`], artifact: ARTIFACT_SHA });
    const commonImage = image({ id: "sha256:edge", tags: ["nginx:edge"] });
    const shared = {
      "networks.json": stable([{ Name: "xmind_site_internal" }]),
      "gateway-contract.json": stable(gateway()),
      "containers.json": stable([gateway(), web({ id: "web-old", image: "sha256:old", startedAt: "old" })]),
      "images.json": stable([commonImage, oldImage]),
      "server-markers.tsv": "begin\t1\nend\t1\nserver_name\t2\nproxy_pass\t1\nblock_sha256\tstable\n",
    };
    await writeSnapshot(root, "pre", shared);
    await writeSnapshot(root, "post", {
      ...shared,
      "containers.json": stable([gateway(), web({ id: "web-new", image: "sha256:new", startedAt: "new" })]),
      "images.json": stable([commonImage, oldImage, candidate]),
    });
    assert.equal((await runCompare(root, "upgrade")).code, 0);

    const post = path.join(root, RELEASE_ID, "post");
    await writeFile(path.join(post, "gateway-contract.json"), stable(gateway({ restartCount: 5 })));
    const result = await runCompare(root, "upgrade");
    assert.notEqual(result.code, 0, "gateway mutation must fail closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first install permits only the planned origin, network, port, cert, and gateway cutover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xmind-snapshot-first-"));
  try {
    const commonImage = image({ id: "sha256:edge", tags: ["nginx:edge"] });
    const candidate = image({ id: "sha256:new", tags: [`xmind-site:${ARTIFACT_SHA.slice(0, 12)}`], artifact: ARTIFACT_SHA });
    await writeSnapshot(root, "pre", {
      "containers.json": stable([gateway()]), "images.json": stable([commonImage]),
      "networks.json": stable([{ Name: "lighthouse_ai_video_net" }]),
    });
    await writeSnapshot(root, "post", {
      "containers.json": stable([gateway({ startedAt: "after", restartCount: 5 }), web({ id: "web-new", image: "sha256:new", startedAt: "new" })]),
      "images.json": stable([commonImage, candidate]),
      "networks.json": stable([{ Name: "lighthouse_ai_video_net" }, { Name: "xmind_site_internal" }]),
      "listening-ports.tsv": "LISTEN\t127.0.0.1:80\nLISTEN\t172.20.0.1:18888\n",
      "gateway-contract.json": stable(gateway({ startedAt: "after", restartCount: 5 })),
      "gateway-nginx-host.sha256": "new-config\n", "gateway-nginx-container.sha256": "new-config\n",
      "cert-lineages.tsv": "existing.example\tstable-cert\nxmind.lute-tlz-dddd.top\tnew-cert\n",
      "server-markers.tsv": "begin\t1\nend\t1\nserver_name\t2\nproxy_pass\t1\nblock_sha256\tnew\n",
    });
    assert.equal((await runCompare(root, "first_install")).code, 0);

    const post = path.join(root, RELEASE_ID, "post");
    const extra = web({ id: "unexpected-worker", image: "sha256:new", startedAt: "new" });
    extra.Config.Labels["com.docker.compose.service"] = "worker";
    await writeFile(
      path.join(post, "containers.json"),
      stable([gateway({ startedAt: "after", restartCount: 5 }), web({ id: "web-new", image: "sha256:new", startedAt: "new" }), extra]),
    );
    await refreshManifest(post);
    assert.notEqual((await runCompare(root, "first_install")).code, 0, "an extra xmind service must fail closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
