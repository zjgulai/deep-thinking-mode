import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { ensureSourceIdKey } from "../tools/lib/source-id-key.mjs";
import { sourceIdForLocator } from "../tools/lib/source-id.mjs";
import { assertWechatSourceUrl, canonicalizeHttpUrl } from "../tools/lib/url-canonicalizer.mjs";
import { createCleaningStateFixture } from "./helpers/cleaning-state-fixture.mjs";

const execFileAsync = promisify(execFile);
const CURRENT_POINTER = ".local/state/current-cleaning.json";
const SOURCE_ID_KEY_MODULE = pathToFileURL(
  fileURLToPath(new URL("../tools/lib/source-id-key.mjs", import.meta.url))
).href;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withLocalState(run) {
  const root = await mkdtemp("/tmp/bm-key-");
  const keyPath = join(root, ".local", "state", "source-id-key.bin");
  const backupPath = join(root, ".local", "backup", "source-id-key.bin");
  const pointerPath = join(root, CURRENT_POINTER);
  await Promise.all([
    mkdir(dirname(keyPath), { recursive: true }),
    mkdir(dirname(backupPath), { recursive: true })
  ]);
  try {
    return await run({ root, keyPath, backupPath, pointerPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withFixture(sourceCount, run) {
  const fixture = await createCleaningStateFixture({ sourceCount });
  const keyPath = join(fixture.rootDir, ".local", "state", "source-id-key.bin");
  const backupPath = join(fixture.rootDir, ".local", "backup", "source-id-key.bin");
  await mkdir(dirname(backupPath), { recursive: true });
  try {
    return await run({ fixture, keyPath, backupPath });
  } finally {
    await fixture.cleanup();
  }
}

async function assertMissing(path) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}

async function captureRejection(promise) {
  return promise.then(
    () => assert.fail("expected rejection"),
    (cause) => cause
  );
}

async function withOpenHook(hook, run) {
  const originalOpen = fs.open;
  fs.open = async (path, flags, ...args) => hook({ originalOpen, path, flags, args });
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
}

async function runBoundedKeyChild({ keyPath, backupPath, setupRace = false }, timeoutMs = 1500) {
  const source = `
    import fs from "node:fs/promises";
    import { execFileSync } from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    ${setupRace ? `
      const target = ${JSON.stringify(keyPath)};
      const originalOpen = fs.open;
      let replaced = false;
      fs.open = async (path, flags, ...args) => {
        if (!replaced && path === target && typeof flags === "number") {
          replaced = true;
          await fs.unlink(target);
          execFileSync("/usr/bin/mkfifo", [target]);
        }
        return originalOpen(path, flags, ...args);
      };
      syncBuiltinESMExports();
    ` : ""}
    const { ensureSourceIdKey } = await import(${JSON.stringify(SOURCE_ID_KEY_MODULE)});
    try {
      const value = await ensureSourceIdKey({
        keyPath: ${JSON.stringify(keyPath)},
        backupPath: ${JSON.stringify(backupPath)},
        currentPointer: null
      });
      process.stdout.write(JSON.stringify({ ok: true, keySha256: value.keySha256 }));
    } catch (cause) {
      process.stdout.write(JSON.stringify({
        ok: false,
        code: cause?.code,
        kind: cause?.kind,
        path: cause?.path,
        operation: cause?.operation
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`key child timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`key child failed (${code ?? signal}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (cause) {
        reject(new Error(`invalid key child output: ${stdout}\n${stderr}`, { cause }));
      }
    });
  });
}

test("source id requires the private key and matches the fixed vector", () => {
  const result = sourceIdForLocator({
    privateKey: Buffer.alloc(32, 0x11),
    locatorType: "url",
    locator: "https://mp.weixin.qq.com/s/synthetic-source"
  });
  assert.equal(result.sourceId, "src_da1f3403ad99e7c55172c7e3be20372c");
  assert.match(result.locatorSha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () => sourceIdForLocator({ locatorType: "url", locator: "https://mp.weixin.qq.com/s/synthetic-source" }),
    /privateKey/
  );
});

test("source ID rejects a stored truncated collision for a different locator", () => {
  const privateKey = Buffer.alloc(32, 0x22);
  const existing = sourceIdForLocator({ privateKey, locatorType: "url", locator: "https://mp.weixin.qq.com/s/first" });
  const colliding = sourceIdForLocator({ privateKey, locatorType: "url", locator: "https://mp.weixin.qq.com/s/second" });
  assert.throws(
    () => sourceIdForLocator({
      privateKey,
      locatorType: "url",
      locator: "https://mp.weixin.qq.com/s/second",
      existingLocatorSha256BySourceId: new Map([[colliding.sourceId, existing.locatorSha256]])
    }),
    (cause) => cause?.code === "SOURCE_ID_COLLISION"
  );
});

test("canonicalizes HTTP URLs without reordering query parameters", () => {
  assert.equal(
    canonicalizeHttpUrl("HTTPS://MP.WEIXIN.QQ.COM:443/s/synthetic?b=2&a=%2f#section"),
    "https://mp.weixin.qq.com/s/synthetic?b=2&a=%2f"
  );
  assert.equal(canonicalizeHttpUrl("http://example.test:80/a#fragment"), "http://example.test/a");
  for (const input of ["ftp://example.test/a", "https://user@example.test/a", "https://:secret@example.test/a"]) {
    assert.throws(() => canonicalizeHttpUrl(input), (cause) => cause?.code === "URL_INVALID");
  }
});

test("only the exact WeChat HTTPS host is accepted", () => {
  assert.doesNotThrow(() => assertWechatSourceUrl("https://mp.weixin.qq.com/s/synthetic"));
  for (const url of [
    "http://mp.weixin.qq.com/s/synthetic",
    "https://sub.mp.weixin.qq.com/s/synthetic",
    "https://mp.weixin.qq.com.evil.test/s/synthetic"
  ]) {
    assert.throws(() => assertWechatSourceUrl(url), (cause) => cause?.code === "WECHAT_SOURCE_URL_INVALID");
  }
});

test("the key lifecycle API rejects unknown, missing, mistyped and nonfixed currentPointer options without writes", async () => {
  await withLocalState(async ({ root, keyPath, backupPath }) => {
    const invalidOptions = [
      { keyPath, backupPath, currentPointer: null, catalogPath: join(root, ".local", "catalog", "sources.jsonl") },
      { keyPath, backupPath },
      { keyPath, backupPath, currentPointer: 42 },
      { keyPath, backupPath, currentPointer: ".local/state/not-current-cleaning.json" }
    ];
    for (const options of invalidOptions) {
      await assert.rejects(ensureSourceIdKey(options), TypeError);
      await assertMissing(keyPath);
      await assertMissing(backupPath);
    }
  });
});

for (const sourceCount of [1, 0]) {
  test(`pointer-existing verified ${sourceCount === 0 ? "empty" : "nonempty"} state makes two missing keys irrecoverably lost`, async () => {
    await withFixture(sourceCount, async ({ fixture, keyPath, backupPath }) => {
      const cause = await captureRejection(ensureSourceIdKey({
        keyPath,
        backupPath,
        currentPointer: fixture.currentPointer
      }));
      assert.equal(cause.code, "SOURCE_ID_KEY_LOST");
      assert.equal(cause.persistent_writes_occurred, false);
      await assertMissing(keyPath);
      await assertMissing(backupPath);
    });
  });
}

test("pointer-existing reader failures preserve missing, invalid and I/O fields without key writes", async () => {
  await withLocalState(async ({ keyPath, backupPath, pointerPath }) => {
    const missing = await captureRejection(ensureSourceIdKey({ keyPath, backupPath, currentPointer: CURRENT_POINTER }));
    assert.deepEqual(
      {
        code: missing.code,
        kind: missing.kind,
        path: missing.path,
        persistent_writes_occurred: missing.persistent_writes_occurred
      },
      {
        code: "LOCAL_STATE_MISSING",
        kind: "expected",
        path: CURRENT_POINTER,
        persistent_writes_occurred: false
      }
    );

    await writeFile(pointerPath, Buffer.from("not canonical json\n"));
    const invalid = await captureRejection(ensureSourceIdKey({ keyPath, backupPath, currentPointer: CURRENT_POINTER }));
    assert.equal(invalid.code, "LOCAL_STATE_INVALID");
    assert.equal(invalid.kind, "expected");
    assert.equal(invalid.path, CURRENT_POINTER);

    await writeFile(pointerPath, Buffer.from("reader reaches open\n"));
    const readerPointerPath = await realpath(pointerPath);
    await withOpenHook(async ({ originalOpen, path, flags, args }) => {
      if (path === readerPointerPath) {
        const failure = new Error("synthetic pointer open failure");
        failure.code = "EACCES";
        throw failure;
      }
      return originalOpen(path, flags, ...args);
    }, async () => {
      const io = await captureRejection(ensureSourceIdKey({ keyPath, backupPath, currentPointer: CURRENT_POINTER }));
      assert.deepEqual(
        {
          code: io.code,
          kind: io.kind,
          path: io.path,
          operation: io.operation,
          persistent_writes_occurred: io.persistent_writes_occurred
        },
        {
          code: "CLEANING_IO_FAILURE",
          kind: "io",
          path: CURRENT_POINTER,
          operation: "open",
          persistent_writes_occurred: false
        }
      );
    });
    await assertMissing(keyPath);
    await assertMissing(backupPath);
  });
});

for (const missingArtifact of ["catalog", "report"]) {
  test(`pointer-existing ${missingArtifact} failure is preserved and creates no key`, async () => {
    await withFixture(1, async ({ fixture, keyPath, backupPath }) => {
      if (missingArtifact === "catalog") await fixture.deleteCatalog();
      else await fixture.deleteReport();
      const cause = await captureRejection(ensureSourceIdKey({
        keyPath,
        backupPath,
        currentPointer: fixture.currentPointer
      }));
      assert.equal(cause.code, "LOCAL_STATE_MISSING");
      assert.equal(cause.kind, "expected");
      assert.equal(cause.path, missingArtifact === "catalog" ? fixture.pointer.catalog_path : fixture.pointer.report_path);
      assert.equal(cause.persistent_writes_occurred, false);
      await assertMissing(keyPath);
      await assertMissing(backupPath);
    });
  });
}

test("a pointer switch inside the strict reader window is preserved and creates no key", async () => {
  const alternate = await createCleaningStateFixture({ outputs: [Buffer.from("alternate\n")] });
  try {
    await withFixture(1, async ({ fixture, keyPath, backupPath }) => {
      const readerPointerPath = await realpath(fixture.pointerPath);
      let pointerOpens = 0;
      await withOpenHook(async ({ originalOpen, path, flags, args }) => {
        if (path === readerPointerPath && typeof flags === "number") {
          pointerOpens += 1;
          if (pointerOpens === 2) await writeFile(fixture.pointerPath, alternate.pointerBytes);
        }
        return originalOpen(path, flags, ...args);
      }, async () => {
        const cause = await captureRejection(ensureSourceIdKey({
          keyPath,
          backupPath,
          currentPointer: fixture.currentPointer
        }));
        assert.equal(cause.code, "LOCAL_STATE_INVALID");
        assert.equal(cause.kind, "expected");
        assert.equal(cause.path, CURRENT_POINTER);
        assert.equal(cause.persistent_writes_occurred, false);
      });
      assert.equal(pointerOpens, 2);
      await assertMissing(keyPath);
      await assertMissing(backupPath);
    });
  } finally {
    await alternate.cleanup();
  }
});

test("a matching key created during the reader call is re-read and repairs its missing copy", async () => {
  await withFixture(1, async ({ fixture, keyPath, backupPath }) => {
    const concurrentKey = Buffer.alloc(32, 0x6a);
    const readerCatalogPath = await realpath(fixture.catalogPath);
    let created = false;
    await withOpenHook(async ({ originalOpen, path, flags, args }) => {
      if (!created && path === readerCatalogPath && typeof flags === "number") {
        created = true;
        await writeFile(keyPath, concurrentKey, { mode: 0o600 });
      }
      return originalOpen(path, flags, ...args);
    }, async () => {
      const result = await ensureSourceIdKey({
        keyPath,
        backupPath,
        currentPointer: fixture.currentPointer
      });
      assert.equal(result.keySha256, sha256(concurrentKey));
    });
    assert.equal(created, true);
    assert.deepEqual(await readFile(keyPath), concurrentKey);
    assert.deepEqual(await readFile(backupPath), concurrentKey);
  });
});

test("one surviving key recovers the other without reading a present pointer's catalog or outputs", async () => {
  await withFixture(1, async ({ fixture, keyPath, backupPath }) => {
    const survivor = Buffer.alloc(32, 0x71);
    await writeFile(keyPath, survivor, { mode: 0o600 });
    await fixture.deleteCatalog();
    const result = await ensureSourceIdKey({
      keyPath,
      backupPath,
      currentPointer: fixture.currentPointer
    });
    assert.equal(result.keySha256, sha256(survivor));
    assert.deepEqual(await readFile(backupPath), survivor);
  });
});

test("null bootstrap creates exactly two matching 0600 key copies while the fixed pointer stays absent", async () => {
  await withLocalState(async ({ keyPath, backupPath }) => {
    const result = await ensureSourceIdKey({ keyPath, backupPath, currentPointer: null });
    assert.equal(result.key.length, 32);
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(backupPath)).mode & 0o777, 0o600);
    assert.equal(sha256(await readFile(keyPath)), result.keySha256);
    assert.equal(sha256(await readFile(backupPath)), result.keySha256);
  });
});

test("null bootstrap rejects a fixed pointer present at operation start without publishing keys", async () => {
  await withFixture(0, async ({ keyPath, backupPath }) => {
    const cause = await captureRejection(ensureSourceIdKey({ keyPath, backupPath, currentPointer: null }));
    assert.equal(cause.code, "SOURCE_ID_KEY_RACE");
    assert.equal(cause.persistent_writes_occurred, false);
    await assertMissing(keyPath);
    await assertMissing(backupPath);
  });
});

test("null bootstrap returns matching valid key copies even when the fixed pointer exists", async () => {
  await withLocalState(async ({ keyPath, backupPath, pointerPath }) => {
    const key = Buffer.alloc(32, 0x72);
    await writeFile(pointerPath, Buffer.from("already present\n"));
    await writeFile(keyPath, key, { mode: 0o600 });
    await writeFile(backupPath, key, { mode: 0o600 });

    const result = await ensureSourceIdKey({ keyPath, backupPath, currentPointer: null });

    assert.equal(result.keySha256, sha256(key));
    assert.deepEqual(await readFile(keyPath), key);
    assert.deepEqual(await readFile(backupPath), key);
  });
});

test("null bootstrap repairs one surviving key even when the fixed pointer exists", async () => {
  await withLocalState(async ({ keyPath, backupPath, pointerPath }) => {
    const survivor = Buffer.alloc(32, 0x73);
    await writeFile(pointerPath, Buffer.from("already present\n"));
    await writeFile(keyPath, survivor, { mode: 0o600 });

    const result = await ensureSourceIdKey({ keyPath, backupPath, currentPointer: null });

    assert.equal(result.keySha256, sha256(survivor));
    assert.deepEqual(await readFile(keyPath), survivor);
    assert.deepEqual(await readFile(backupPath), survivor);
  });
});

test("null bootstrap stops after a pointer appears before the later publication and never truncates the first key", async () => {
  await withLocalState(async ({ keyPath, backupPath, pointerPath }) => {
    const originalLstat = fs.lstat;
    const originalWriteFile = fs.writeFile;
    let injected = false;
    fs.lstat = async (path, ...args) => {
      if (!injected && path === pointerPath) {
        try {
          const published = await originalLstat(keyPath);
          if (published.isFile()) {
            injected = true;
            await originalWriteFile(pointerPath, Buffer.from("appeared\n"));
          }
        } catch (cause) {
          if (cause?.code !== "ENOENT") throw cause;
        }
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      const cause = await captureRejection(ensureSourceIdKey({ keyPath, backupPath, currentPointer: null }));
      assert.equal(cause.code, "SOURCE_ID_KEY_RACE");
      assert.equal(injected, true);
    } finally {
      fs.lstat = originalLstat;
      syncBuiltinESMExports();
    }
    assert.equal((await lstat(keyPath)).size, 32);
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    await assertMissing(backupPath);
  });
});

test("null bootstrap binds a pointer present at operation start even when it disappears on the first key lstat", async () => {
  await withLocalState(async ({ keyPath, backupPath, pointerPath }) => {
    await writeFile(pointerPath, Buffer.from("present at operation start\n"));
    const originalLstat = fs.lstat;
    let removed = false;
    fs.lstat = async (path, ...args) => {
      if (!removed && path === keyPath) {
        removed = true;
        await unlink(pointerPath);
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      const cause = await captureRejection(
        ensureSourceIdKey({ keyPath, backupPath, currentPointer: null })
      );
      assert.equal(removed, true);
      assert.equal(cause.code, "SOURCE_ID_KEY_RACE");
      assert.equal(cause.persistent_writes_occurred, false);
    } finally {
      fs.lstat = originalLstat;
      syncBuiltinESMExports();
    }
    await assertMissing(keyPath);
    await assertMissing(backupPath);
  });
});

test("a sync failure after writing a new key scrubs the unpublished handle to zero bytes", async () => {
  await withLocalState(async ({ keyPath, backupPath }) => {
    const originalOpen = fs.open;
    let injected = false;
    let cleanupSynced = false;
    fs.open = async (path, flags, ...args) => {
      const handle = await originalOpen(path, flags, ...args);
      if (path === keyPath && flags === "wx") {
        const originalSync = handle.sync.bind(handle);
        let syncCalls = 0;
        handle.sync = async () => {
          syncCalls += 1;
          if (syncCalls === 1) {
            injected = true;
            const cause = new Error("synthetic key sync failure");
            cause.code = "EIO";
            throw cause;
          }
          cleanupSynced = true;
          return originalSync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const cause = await captureRejection(
        ensureSourceIdKey({ keyPath, backupPath, currentPointer: null })
      );
      assert.equal(cause.code, "EIO");
      assert.equal(cause.persistent_writes_occurred, true);
      assert.equal(injected, true);
      assert.equal(cleanupSynced, true);
    } finally {
      fs.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal((await lstat(keyPath)).size, 0);
    assert.equal((await readFile(keyPath)).length, 0);
    await assertMissing(backupPath);
  });
});

test("a parent replacement in the write window scrubs the original unpublished handle", async () => {
  await withLocalState(async ({ root, keyPath, backupPath }) => {
    const stateDirectory = dirname(keyPath);
    const movedStateDirectory = join(root, ".local", "state-before-race");
    const originalOpen = fs.open;
    let swapped = false;
    fs.open = async (path, flags, ...args) => {
      const handle = await originalOpen(path, flags, ...args);
      if (path === keyPath && flags === "wx") {
        const originalWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async (contents, ...writeArgs) => {
          const result = await originalWriteFile(contents, ...writeArgs);
          if (!swapped) {
            swapped = true;
            await rename(stateDirectory, movedStateDirectory);
            await mkdir(stateDirectory);
          }
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const cause = await captureRejection(
        ensureSourceIdKey({ keyPath, backupPath, currentPointer: null })
      );
      assert.equal(cause.code, "SOURCE_ID_KEY_RACE");
      assert.equal(cause.persistent_writes_occurred, true);
      assert.equal(swapped, true);
    } finally {
      fs.open = originalOpen;
      syncBuiltinESMExports();
    }
    const movedKeyPath = join(movedStateDirectory, "source-id-key.bin");
    assert.equal((await lstat(movedKeyPath)).size, 0);
    assert.equal((await readFile(movedKeyPath)).length, 0);
    await assertMissing(keyPath);
    await assertMissing(backupPath);
  });
});

test("an error after the first completed publication ORs the operation-wide persistent-write flag", async () => {
  await withLocalState(async ({ root, keyPath, backupPath }) => {
    const localRoot = join(root, ".local");
    const backupDirectory = dirname(backupPath);
    const movedBackupDirectory = join(root, ".local", "backup-before-race");
    const originalOpen = fs.open;
    const originalLstat = fs.lstat;
    let keyReadCompleted = false;
    let postReadLocalChecks = 0;
    let swapped = false;
    fs.open = async (path, flags, ...args) => {
      const handle = await originalOpen(path, flags, ...args);
      if (path === keyPath && typeof flags === "number") {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          if (result.bytesRead === 32) keyReadCompleted = true;
          return result;
        };
      }
      return handle;
    };
    fs.lstat = async (path, ...args) => {
      if (keyReadCompleted && path === localRoot) {
        postReadLocalChecks += 1;
        if (!swapped && postReadLocalChecks === 2) {
          swapped = true;
          await rename(backupDirectory, movedBackupDirectory);
          await mkdir(backupDirectory);
        }
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      const cause = await captureRejection(
        ensureSourceIdKey({ keyPath, backupPath, currentPointer: null })
      );
      assert.equal(cause.code, "SOURCE_ID_KEY_RACE");
      assert.equal(cause.persistent_writes_occurred, true);
      assert.equal(swapped, true);
    } finally {
      fs.open = originalOpen;
      fs.lstat = originalLstat;
      syncBuiltinESMExports();
    }
    assert.equal((await lstat(keyPath)).size, 32);
    await assertMissing(backupPath);
  });
});

test("mismatched valid key copies are never overwritten", async () => {
  await withLocalState(async ({ keyPath, backupPath }) => {
    const first = Buffer.alloc(32, 0x33);
    const second = Buffer.alloc(32, 0x44);
    await writeFile(keyPath, first, { mode: 0o600 });
    await writeFile(backupPath, second, { mode: 0o600 });
    await assert.rejects(
      ensureSourceIdKey({ keyPath, backupPath, currentPointer: null }),
      (cause) => cause?.code === "SOURCE_ID_KEY_MISMATCH"
    );
    assert.deepEqual(await readFile(keyPath), first);
    assert.deepEqual(await readFile(backupPath), second);
  });
});

test("key and backup paths resolving to the same leaf are rejected", async () => {
  await withLocalState(async ({ keyPath }) => {
    await assert.rejects(
      ensureSourceIdKey({
        keyPath,
        backupPath: join(keyPath, "..", "source-id-key.bin"),
        currentPointer: null
      }),
      (cause) => cause?.code === "SOURCE_ID_KEY_PATH_CONFLICT"
    );
  });
});

test("a pre-existing key leaf symlink is invalid and never reads or changes its referent", async () => {
  await withLocalState(async ({ root, keyPath, backupPath }) => {
    const outsidePath = join(root, "outside-key.bin");
    const outsideKey = Buffer.alloc(32, 0x7a);
    await writeFile(outsidePath, outsideKey, { mode: 0o600 });
    await symlink(outsidePath, keyPath);
    const cause = await captureRejection(
      ensureSourceIdKey({ keyPath, backupPath, currentPointer: null })
    );
    assert.equal(cause.code, "SOURCE_ID_KEY_INVALID");
    assert.deepEqual(await readFile(outsidePath), outsideKey);
    await assertMissing(backupPath);
  });
});

test("a key ancestor symlink remains fail-closed", async () => {
  await withLocalState(async ({ root, keyPath, backupPath }) => {
    const stateDirectory = dirname(keyPath);
    const realStateDirectory = join(root, ".local", "real-state");
    await rename(stateDirectory, realStateDirectory);
    await symlink(realStateDirectory, stateDirectory);
    const cause = await captureRejection(
      ensureSourceIdKey({ keyPath, backupPath, currentPointer: null })
    );
    assert.equal(
      new Set(["SYMLINK_TRAVERSAL", "SOURCE_ID_KEY_RACE"]).has(cause.code),
      true
    );
    await assertMissing(backupPath);
  });
});

test("an intermediate .local symlink is rejected before external state is inspected", async () => {
  const root = await mkdtemp("/tmp/bm-safe-");
  const externalRoot = await mkdtemp("/tmp/bm-external-");
  const externalLocal = join(externalRoot, "local");
  const externalState = join(externalLocal, "state");
  const externalBackup = join(externalLocal, "backup");
  const keyPath = join(root, ".local", "state", "source-id-key.bin");
  const backupPath = join(root, ".local", "backup", "source-id-key.bin");
  await mkdir(externalState, { recursive: true });
  await mkdir(externalBackup, { recursive: true });
  await symlink(externalLocal, join(root, ".local"));

  const originalOpen = fs.open;
  const originalLstat = fs.lstat;
  let externalStateOpened = false;
  let externalStateInspected = false;
  fs.open = async (path, flags, ...args) => {
    if (path === join(root, ".local", "state")) externalStateOpened = true;
    return originalOpen(path, flags, ...args);
  };
  fs.lstat = async (path, ...args) => {
    if (path === join(root, ".local", "state")) externalStateInspected = true;
    return originalLstat(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const cause = await captureRejection(
      ensureSourceIdKey({ keyPath, backupPath, currentPointer: null })
    );
    assert.equal(cause.code, "SYMLINK_TRAVERSAL");
    assert.equal(externalStateOpened, false);
    assert.equal(externalStateInspected, false);
    assert.deepEqual(await readdir(externalState), []);
    assert.deepEqual(await readdir(externalBackup), []);
  } finally {
    fs.open = originalOpen;
    fs.lstat = originalLstat;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

for (const leafType of ["fifo", "socket", "directory"]) {
  test(`a pre-existing ${leafType} key leaf is rejected as invalid without blocking`, async () => {
    await withLocalState(async ({ keyPath, backupPath }) => {
      let server;
      if (leafType === "fifo") {
        await execFileAsync("/usr/bin/mkfifo", [keyPath]);
      } else if (leafType === "socket") {
        server = createServer();
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(keyPath, resolve);
        });
      } else {
        await mkdir(keyPath);
      }
      try {
        const outcome = await runBoundedKeyChild({ keyPath, backupPath });
        assert.deepEqual(outcome, {
          ok: false,
          code: "SOURCE_ID_KEY_INVALID"
        });
      } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
      }
    });
  });
}

test("real character-device coverage is used only when the host permits synthetic mknod", async (t) => {
  assert.equal((await lstat("/dev/null")).isCharacterDevice(), true);
  await withLocalState(async ({ keyPath, backupPath }) => {
    try {
      await execFileAsync("/sbin/mknod", [keyPath, "c", "3", "2"]);
    } catch (cause) {
      t.diagnostic(`synthetic character device unavailable: ${String(cause.stderr ?? cause.message).trim()}`);
      await assertMissing(keyPath);
      return;
    }
    const outcome = await runBoundedKeyChild({ keyPath, backupPath });
    assert.deepEqual(outcome, {
      ok: false,
      code: "SOURCE_ID_KEY_INVALID"
    });
  });
});

test("a regular key replaced by a FIFO after pre-lstat is a nonblocking race", async () => {
  await withLocalState(async ({ keyPath, backupPath }) => {
    await writeFile(keyPath, Buffer.alloc(32, 0x51), { mode: 0o600 });
    const outcome = await runBoundedKeyChild({ keyPath, backupPath, setupRace: true });
    assert.deepEqual(outcome, {
      ok: false,
      code: "SOURCE_ID_KEY_RACE"
    });
  });
});

test("an oversized sparse key is rejected before any content read", async () => {
  await withLocalState(async ({ keyPath, backupPath }) => {
    const handle = await open(keyPath, "w", 0o600);
    await handle.truncate(1024 * 1024 * 1024);
    await handle.close();
    let readAttempted = false;
    await withOpenHook(async ({ originalOpen, path, flags, args }) => {
      const opened = await originalOpen(path, flags, ...args);
      if (path === keyPath && typeof flags === "number") {
        opened.read = async () => {
          readAttempted = true;
          throw new Error("oversized key content must not be read");
        };
        opened.readFile = async () => {
          readAttempted = true;
          throw new Error("oversized key content must not be read");
        };
      }
      return opened;
    }, async () => {
      await assert.rejects(
        ensureSourceIdKey({ keyPath, backupPath, currentPointer: null }),
        (cause) => cause?.code === "SOURCE_ID_KEY_INVALID"
      );
    });
    assert.equal(readAttempted, false);
  });
});

test("existing valid exact-size 0600 key copies pass bounded reads", async () => {
  await withLocalState(async ({ keyPath, backupPath }) => {
    const key = Buffer.alloc(32, 0x61);
    await writeFile(keyPath, key, { mode: 0o600 });
    await writeFile(backupPath, key, { mode: 0o600 });
    const result = await ensureSourceIdKey({ keyPath, backupPath, currentPointer: null });
    assert.deepEqual(result.key, key);
    assert.equal(result.keySha256, sha256(key));
  });
});

test("an absolute fixed pointer under the reader's real root is accepted on aliased and direct tmp roots", async () => {
  await withLocalState(async ({ root, keyPath, backupPath }) => {
    const key = Buffer.alloc(32, 0x62);
    await writeFile(keyPath, key, { mode: 0o600 });
    await writeFile(backupPath, key, { mode: 0o600 });
    const realRoot = await realpath(root);
    const currentPointer = join(realRoot, CURRENT_POINTER);
    const result = await ensureSourceIdKey({ keyPath, backupPath, currentPointer });
    assert.equal(result.keySha256, sha256(key));
  });
});
