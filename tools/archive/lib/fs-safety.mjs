import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;

function safetyError(code, message) {
  const cause = new Error(message);
  cause.code = code;
  return cause;
}

function isStrictDescendant(parentPath, candidatePath) {
  const pathFromParent = relative(parentPath, candidatePath);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function resolveLocalCandidate({ repoRoot, candidatePath }) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new TypeError("repoRoot is required");
  }
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw new TypeError("candidatePath is required");
  }
  const resolvedRepository = resolve(repoRoot);
  const localRoot = resolve(resolvedRepository, ".local");
  const resolvedCandidate = resolve(candidatePath);
  if (!isStrictDescendant(localRoot, resolvedCandidate)) {
    throw safetyError("LOCAL_PATH_ESCAPE", "candidate path must be inside the repository .local directory");
  }
  return { resolvedRepository, localRoot, resolvedCandidate };
}

export async function assertInsideLocalRoot({ repoRoot, candidatePath }) {
  resolveLocalCandidate({ repoRoot, candidatePath });
}

export async function assertNoSymlinkTraversal({ repoRoot, candidatePath }) {
  const { resolvedRepository, localRoot, resolvedCandidate } = resolveLocalCandidate({ repoRoot, candidatePath });
  const components = [resolvedRepository, localRoot];
  let currentPath = localRoot;
  for (const segment of relative(localRoot, resolvedCandidate).split(sep)) {
    currentPath = resolve(currentPath, segment);
    components.push(currentPath);
  }

  for (const path of components) {
    let details;
    try {
      details = await lstat(path);
    } catch (cause) {
      if (cause?.code === "ENOENT") return;
      throw cause;
    }
    if (details.isSymbolicLink()) {
      throw safetyError("SYMLINK_TRAVERSAL", "candidate path must not traverse a symbolic link");
    }
  }
}

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readRegularFileHash(path, code) {
  const details = await lstat(path);
  if (!details.isFile()) {
    throw safetyError(code, "path must be a regular file");
  }
  return hash(await readFile(path));
}

async function existingDestinationHash(destinationPath) {
  let details;
  try {
    details = await lstat(destinationPath);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
  if (!details.isFile()) {
    throw safetyError("DESTINATION_CONFLICT", "destination already exists and is not a regular file");
  }
  let handle;
  try {
    handle = await open(destinationPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (cause) {
    if (cause?.code === "ELOOP" || cause?.code === "ENOENT") {
      throw safetyError("DESTINATION_CONFLICT", "destination changed while it was being inspected");
    }
    throw cause;
  }
  try {
    const openedDetails = await handle.stat();
    if (
      !openedDetails.isFile() ||
      openedDetails.dev !== details.dev ||
      openedDetails.ino !== details.ino
    ) {
      throw safetyError("DESTINATION_CONFLICT", "destination changed while it was being inspected");
    }
    return hash(await handle.readFile());
  } finally {
    await handle.close();
  }
}

export async function publishNoClobber({ tempPath, destinationPath, expectedSha256 }) {
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    throw safetyError("SOURCE_HASH_MISMATCH", "expectedSha256 must be a lowercase SHA-256 digest");
  }
  if (await readRegularFileHash(tempPath, "SOURCE_NOT_REGULAR") !== expectedSha256) {
    throw safetyError("SOURCE_HASH_MISMATCH", "temporary artifact does not match expectedSha256");
  }

  const destinationHash = await existingDestinationHash(destinationPath);
  if (destinationHash !== null) {
    if (destinationHash === expectedSha256) return "same_hash";
    throw safetyError("DESTINATION_CONFLICT", "destination already exists with different content");
  }

  try {
    // link(2) creates destination atomically and never replaces an existing entry.
    await link(tempPath, destinationPath);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      throw safetyError("DESTINATION_CONFLICT", "destination appeared while publishing");
    }
    throw cause;
  }
  return "created";
}
