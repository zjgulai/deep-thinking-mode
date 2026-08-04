import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { readCurrentCleaningState } from "./cleaning-state.mjs";
import { assertInsideLocalRoot, assertNoSymlinkTraversal } from "./fs-safety.mjs";
import { sha256 } from "./hash.mjs";

const POINTER_RELATIVE_PATH = ".local/state/current-cleaning.json";
const KEY_BYTES = 32;
const KEY_MODE = 0o600;
const READ_NOFOLLOW_NONBLOCK = fsConstants.O_RDONLY |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;
const DIRECTORY_NOFOLLOW = fsConstants.O_RDONLY |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_DIRECTORY;

function keyError(code, message, persistentWritesOccurred = false) {
  const error = new Error(message);
  error.code = code;
  error.persistent_writes_occurred = persistentWritesOccurred;
  return error;
}

function raceError(cause, persistentWritesOccurred = false) {
  if (cause?.code === "SOURCE_ID_KEY_RACE") {
    if (persistentWritesOccurred) cause.persistent_writes_occurred = true;
    return cause;
  }
  return keyError(
    "SOURCE_ID_KEY_RACE",
    "the private key path or cleaning pointer changed while it was being inspected",
    persistentWritesOccurred
  );
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function validateOptions(options) {
  if (!isPlainObject(options)) throw new TypeError("options must be an object");
  const keys = Object.keys(options).sort();
  const expected = ["backupPath", "currentPointer", "keyPath"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("options must contain exactly keyPath, backupPath and currentPointer");
  }
  if (typeof options.keyPath !== "string" || options.keyPath.length === 0 ||
      typeof options.backupPath !== "string" || options.backupPath.length === 0) {
    throw new TypeError("keyPath and backupPath are required strings");
  }
  if (options.currentPointer !== null &&
      (typeof options.currentPointer !== "string" || options.currentPointer.length === 0)) {
    throw new TypeError("currentPointer must be null or a string");
  }
  return options;
}

function repositoryRootForLocalPath(candidatePath) {
  let current = resolve(candidatePath);
  while (dirname(current) !== current) {
    if (basename(current) === ".local") return dirname(current);
    current = dirname(current);
  }
  throw keyError("SOURCE_ID_KEY_PATH_INVALID", "key paths must be below .local");
}

function resolveKeyPaths({ keyPath, backupPath }) {
  const resolvedKeyPath = resolve(keyPath);
  const resolvedBackupPath = resolve(backupPath);
  if (resolvedKeyPath === resolvedBackupPath) {
    throw keyError("SOURCE_ID_KEY_PATH_CONFLICT", "key and backup paths must be different files");
  }
  const repoRoot = repositoryRootForLocalPath(resolvedKeyPath);
  if (repositoryRootForLocalPath(resolvedBackupPath) !== repoRoot) {
    throw keyError("SOURCE_ID_KEY_PATH_INVALID", "key copies must be in the same repository");
  }
  return { repoRoot, keyPath: resolvedKeyPath, backupPath: resolvedBackupPath };
}

async function assertSafeKeyPaths({ repoRoot, keyPath, backupPath }) {
  for (const candidatePath of [keyPath, backupPath]) {
    await assertInsideLocalRoot({ repoRoot, candidatePath });
    await assertNoSymlinkTraversal({ repoRoot, candidatePath: dirname(candidatePath) });
  }
}

async function validateCurrentPointer(repoRoot, currentPointer) {
  if (currentPointer === null) return;
  const actual = isAbsolute(currentPointer)
    ? resolve(currentPointer)
    : resolve(repoRoot, currentPointer);
  const requestedRootPointer = resolve(repoRoot, POINTER_RELATIVE_PATH);
  const realRootPointer = resolve(await realpath(repoRoot), POINTER_RELATIVE_PATH);
  if (actual !== requestedRootPointer && actual !== realRootPointer) {
    throw new TypeError("currentPointer must resolve to the fixed cleaning pointer");
  }
}

async function closeAll(entries) {
  await Promise.all(entries.map(async ({ handle }) => handle.close().catch(() => undefined)));
}

async function captureBootstrapState(repoRoot) {
  const statePath = resolve(repoRoot, ".local", "state");
  const pointerPath = resolve(repoRoot, POINTER_RELATIVE_PATH);
  let handle;
  try {
    const beforeOpen = await lstat(statePath);
    handle = await open(statePath, DIRECTORY_NOFOLLOW);
    const details = await handle.stat();
    if (!beforeOpen.isDirectory() ||
        !details.isDirectory() ||
        beforeOpen.dev !== details.dev ||
        beforeOpen.ino !== details.ino) {
      throw raceError();
    }
    let pointerAtStart = null;
    try {
      pointerAtStart = await lstat(pointerPath);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw raceError(cause);
    }
    return { statePath, pointerPath, handle, details, pointerAtStart };
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    throw cause?.code === "SOURCE_ID_KEY_RACE" ? cause : raceError(cause);
  }
}

async function assertBootstrapStateStable(context, persistentWritesOccurred) {
  try {
    const handleDetails = await context.handle.stat();
    const pathDetails = await lstat(context.statePath);
    if (!handleDetails.isDirectory() ||
        !pathDetails.isDirectory() ||
        handleDetails.dev !== context.details.dev ||
        handleDetails.ino !== context.details.ino ||
        pathDetails.dev !== context.details.dev ||
        pathDetails.ino !== context.details.ino) {
      throw raceError(undefined, persistentWritesOccurred);
    }
    if (context.pointerAtStart !== null) {
      throw keyError(
        "SOURCE_ID_KEY_RACE",
        "the fixed cleaning pointer existed at source ID key operation start",
        persistentWritesOccurred
      );
    }
    try {
      await lstat(context.pointerPath);
    } catch (cause) {
      if (cause?.code === "ENOENT") return;
      throw raceError(cause, persistentWritesOccurred);
    }
    throw keyError(
      "SOURCE_ID_KEY_RACE",
      "the fixed cleaning pointer appeared during source ID key bootstrap",
      persistentWritesOccurred
    );
  } catch (cause) {
    throw raceError(cause, persistentWritesOccurred);
  }
}

async function captureOperation(paths) {
  const directoryPaths = [
    resolve(paths.repoRoot, ".local"),
    dirname(paths.keyPath),
    dirname(paths.backupPath)
  ];
  const ancestors = [];
  try {
    for (const path of [...new Set(directoryPaths)]) {
      const beforeOpen = await lstat(path);
      const handle = await open(path, DIRECTORY_NOFOLLOW);
      try {
        const details = await handle.stat();
        if (!beforeOpen.isDirectory() ||
            !details.isDirectory() ||
            beforeOpen.dev !== details.dev ||
            beforeOpen.ino !== details.ino) {
          throw raceError();
        }
        ancestors.push({ path, handle, details });
      } catch (cause) {
        await handle.close().catch(() => undefined);
        throw cause;
      }
    }
    return { ...paths, ancestors };
  } catch (cause) {
    await closeAll(ancestors);
    throw cause?.code === "SOURCE_ID_KEY_RACE" ? cause : raceError(cause);
  }
}

async function assertOperationStable(operation) {
  try {
    for (const ancestor of operation.ancestors) {
      const current = await lstat(ancestor.path);
      if (!current.isDirectory() ||
          current.dev !== ancestor.details.dev ||
          current.ino !== ancestor.details.ino) {
        throw raceError();
      }
    }
  } catch (cause) {
    throw cause?.code === "SOURCE_ID_KEY_RACE" ? cause : raceError(cause);
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertValidPreexistingKey(details) {
  if (!details.isFile() || (details.mode & 0o777) !== KEY_MODE || details.size !== KEY_BYTES) {
    throw keyError(
      "SOURCE_ID_KEY_INVALID",
      "source ID key must be a 32-byte 0600 regular file"
    );
  }
}

async function lstatKeyPath(path) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw raceError(cause);
  }
}

async function assertLeafMatches(path, expectedDetails) {
  let current;
  try {
    current = await lstat(path);
  } catch (cause) {
    throw raceError(cause);
  }
  if (!current.isFile() || !sameFileSnapshot(expectedDetails, current)) throw raceError();
}

async function readExactlyKeyBytes(handle) {
  const contents = Buffer.alloc(KEY_BYTES);
  let offset = 0;
  while (offset < contents.length) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      contents.length - offset,
      offset
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== KEY_BYTES) throw raceError();
  return contents;
}

async function readKeyIfPresent({ operation, path }) {
  await assertOperationStable(operation);
  const beforeOpen = await lstatKeyPath(path);
  if (beforeOpen === null) {
    await assertOperationStable(operation);
    return null;
  }
  assertValidPreexistingKey(beforeOpen);

  let handle;
  try {
    try {
      handle = await open(path, READ_NOFOLLOW_NONBLOCK);
    } catch (cause) {
      throw raceError(cause);
    }
    const beforeRead = await handle.stat();
    if (!beforeRead.isFile() || !sameFileSnapshot(beforeOpen, beforeRead)) throw raceError();
    await assertLeafMatches(path, beforeRead);
    await assertOperationStable(operation);

    const key = await readExactlyKeyBytes(handle);

    const afterRead = await handle.stat();
    if (!afterRead.isFile() || !sameFileSnapshot(beforeRead, afterRead)) throw raceError();
    await assertLeafMatches(path, afterRead);
    await assertOperationStable(operation);
    return { key, keySha256: sha256(key) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function readerFailure(result) {
  const error = new Error(result.error.code);
  Object.assign(error, result.error);
  return error;
}

async function scrubUnpublishedKey(handle) {
  let failure = null;
  try {
    await handle.truncate(0);
  } catch (cause) {
    failure = cause;
  }
  try {
    await handle.sync();
  } catch (cause) {
    if (failure === null) failure = cause;
  }
  try {
    await handle.close();
  } catch (cause) {
    if (failure === null) failure = cause;
  }
  if (failure !== null) throw failure;
}

async function publishKeyCopy({
  operation,
  destinationPath,
  key,
  keySha256,
  beforePublish
}) {
  await assertOperationStable(operation);
  if (beforePublish) await beforePublish();
  await assertOperationStable(operation);

  let handle;
  let created = false;
  let published = false;
  try {
    handle = await open(destinationPath, "wx", KEY_MODE);
    created = true;
  } catch (cause) {
    if (cause?.code !== "EEXIST") throw cause;
    const existing = await readKeyIfPresent({ operation, path: destinationPath });
    if (existing === null) throw raceError();
    if (existing.keySha256 !== keySha256) {
      throw keyError(
        "DESTINATION_CONFLICT",
        "destination already exists with different key material"
      );
    }
    return "same_hash";
  }

  let failure = null;
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || (initial.mode & 0o777) !== KEY_MODE || initial.size !== 0) {
      throw keyError("SOURCE_ID_KEY_INVALID", "new source ID key is not an empty 0600 regular file");
    }
    await assertLeafMatches(destinationPath, initial);
    await assertOperationStable(operation);

    await handle.writeFile(key);
    const afterWrite = await handle.stat();
    if (!afterWrite.isFile() ||
        afterWrite.dev !== initial.dev ||
        afterWrite.ino !== initial.ino ||
        (afterWrite.mode & 0o777) !== KEY_MODE ||
        afterWrite.size !== KEY_BYTES) {
      throw keyError("SOURCE_ID_KEY_INVALID", "published source ID key is not a 32-byte 0600 regular file");
    }
    await assertLeafMatches(destinationPath, afterWrite);
    await assertOperationStable(operation);

    await handle.sync();
    const afterSync = await handle.stat();
    if (!afterSync.isFile() || !sameFileSnapshot(afterWrite, afterSync)) {
      throw keyError("SOURCE_ID_KEY_INVALID", "synced source ID key changed before publication");
    }
    await assertLeafMatches(destinationPath, afterSync);
    await assertOperationStable(operation);

    const publishedKey = await readKeyIfPresent({ operation, path: destinationPath });
    if (publishedKey === null || publishedKey.keySha256 !== keySha256) {
      throw keyError("SOURCE_ID_KEY_CONFLICT", "published source ID key does not match its expected hash");
    }
    published = true;
  } catch (cause) {
    failure = cause;
  }

  try {
    if (published) await handle.close();
    else await scrubUnpublishedKey(handle);
  } catch (cleanupCause) {
    if (failure !== null && cleanupCause && typeof cleanupCause === "object" &&
        cleanupCause.cause === undefined) {
      cleanupCause.cause = failure;
    }
    failure = cleanupCause;
  }

  if (failure !== null) {
    if (created && failure && typeof failure === "object") {
      failure.persistent_writes_occurred = true;
    }
    throw failure;
  }
  return "created";
}

export async function ensureSourceIdKey(options) {
  const { keyPath, backupPath, currentPointer } = validateOptions(options);
  const paths = resolveKeyPaths({ keyPath, backupPath });
  let persistentWritesOccurred = false;
  let operation;
  let bootstrapState = null;

  try {
    await assertSafeKeyPaths(paths);
    await validateCurrentPointer(paths.repoRoot, currentPointer);
    if (currentPointer === null) {
      bootstrapState = await captureBootstrapState(paths.repoRoot);
    }
    operation = await captureOperation(paths);
    let cleaningStateChecked = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [current, backup] = await Promise.all([
        readKeyIfPresent({ operation, path: paths.keyPath }),
        readKeyIfPresent({ operation, path: paths.backupPath })
      ]);

      if (current && backup) {
        if (current.keySha256 !== backup.keySha256) {
          throw keyError("SOURCE_ID_KEY_MISMATCH", "source ID key copies have different hashes");
        }
        return current;
      }

      if (!current && !backup && currentPointer !== null && !cleaningStateChecked) {
        const result = await readCurrentCleaningState({
          rootDir: paths.repoRoot,
          currentPointer,
          selectedSourceIds: []
        });
        if (!result.ok) throw readerFailure(result);
        cleaningStateChecked = true;
        const [afterReaderCurrent, afterReaderBackup] = await Promise.all([
          readKeyIfPresent({ operation, path: paths.keyPath }),
          readKeyIfPresent({ operation, path: paths.backupPath })
        ]);
        if (!afterReaderCurrent && !afterReaderBackup) {
          throw keyError(
            "SOURCE_ID_KEY_LOST",
            "source ID key is missing while a verified cleaning pointer exists"
          );
        }
        continue;
      }

      if (!current && !backup && currentPointer !== null) {
        throw keyError(
          "SOURCE_ID_KEY_LOST",
          "source ID key is missing while a verified cleaning pointer exists"
        );
      }

      let beforePublish = null;
      if (!current && !backup && bootstrapState !== null) {
        await assertBootstrapStateStable(bootstrapState, persistentWritesOccurred);
        // Caller serialization remains required: repeated absence checks cannot make
        // the final pointer-check -> wx publication boundary atomic.
        beforePublish = () => assertBootstrapStateStable(
          bootstrapState,
          persistentWritesOccurred
        );
      }

      const source = current ?? backup ?? { key: randomBytes(KEY_BYTES) };
      const keySha256 = source.keySha256 ?? sha256(source.key);

      try {
        if (!current) {
          const outcome = await publishKeyCopy({
            operation,
            destinationPath: paths.keyPath,
            key: source.key,
            keySha256,
            beforePublish
          });
          if (outcome === "created") persistentWritesOccurred = true;
        }
        if (!backup) {
          const outcome = await publishKeyCopy({
            operation,
            destinationPath: paths.backupPath,
            key: source.key,
            keySha256,
            beforePublish
          });
          if (outcome === "created") persistentWritesOccurred = true;
        }
      } catch (cause) {
        if (cause?.code !== "DESTINATION_CONFLICT") throw cause;
      }
    }
    throw keyError(
      "SOURCE_ID_KEY_CONFLICT",
      "source ID key could not be restored without a conflict",
      persistentWritesOccurred
    );
  } catch (cause) {
    if (cause && typeof cause === "object") {
      cause.persistent_writes_occurred =
        cause.persistent_writes_occurred === true || persistentWritesOccurred;
    }
    throw cause;
  } finally {
    if (operation) await closeAll(operation.ancestors);
    await bootstrapState?.handle.close().catch(() => undefined);
  }
}
