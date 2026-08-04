import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { types } from "node:util";

import {
  compileCleaningStateArtifacts,
  isValidCleaningPointerValue
} from "./cleaning-state.mjs";
import { isSha256, sha256 } from "./hash.mjs";
import {
  canonicalJsonBytes,
  canonicalJsonDocumentBytes
} from "./json.mjs";

const RUNS_ROOT = ".local/cleaned/runs";
const SCHEMA_VERSION = "1.0.0";
const DIRECTORY_FLAGS = fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW;
const READ_FLAGS = fs.constants.O_RDONLY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;
const CREATE_FLAGS = fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

const OPTION_KEYS = ["rootDir", "runsRoot", "plan"];
const PUBLISH_OPTION_KEYS = ["rootDir", "runsRoot", "currentPointer", "stagedRun"];
const RECOVERY_OPTION_KEYS = ["rootDir", "confirmation"];
const PLAN_KEYS = ["manifest", "manifest_sha256", "artifacts"];
const STAGED_RUN_KEYS = [
  "plan_manifest",
  "plan_manifest_sha256",
  "run_sha256",
  "staging_path",
  "final_run_path",
  "artifact_manifest"
];
const COMMIT_LOCK_KEYS = [
  "schema_version",
  "owner_pid",
  "owner_nonce",
  "plan_manifest",
  "plan_manifest_sha256",
  "expected_prior_pointer_sha256",
  "desired_pointer_sha256",
  "desired_pointer",
  "run_sha256"
];
const RECOVERY_TARGET_KEYS = [
  "schema_version",
  "record_kind",
  "target_commit_lock_sha256",
  "target_commit_lock_bytes_base64"
];
const RECOVERY_LEASE_KEYS = [
  "schema_version",
  "record_kind",
  "target_commit_lock_sha256",
  "previous_lease_sha256",
  "generation",
  "owner_pid",
  "owner_nonce"
];
const CURRENT_POINTER = ".local/state/current-cleaning.json";
const STATE_DIRECTORY = ".local/state";
const TRANSITIONS_DIRECTORY = ".local/state/cleaning-transitions";
const COMMIT_LOCK_PATH = ".local/state/cleaning-commit.lock";
const RECOVERY_ROOT = ".local/state/cleaning-recovery-leases";
const RECOVERY_CONFIRMATION = "RECOVER_INTERRUPTED_CLEANING_COMMIT";
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_COMMIT_LOCK_BYTES = 512 * 1024 * 1024;
const MAX_RECOVERY_TARGET_BYTES =
  4 * Math.ceil(MAX_COMMIT_LOCK_BYTES / 3) + 1024;
const MAX_RECOVERY_LEASE_BYTES = 64 * 1024;
const MAX_TRANSITION_RECORD_BYTES =
  MAX_POINTER_BYTES + MAX_RECOVERY_LEASE_BYTES;
const RECOVERY_TARGET_DIRECTORY_RE = /^[0-9a-f]{64}$/;
const RECOVERY_TARGET_CANDIDATE_RE =
  /^\.target\.([1-9][0-9]*)\.([0-9a-f]{32})\.tmp$/;
const RECOVERY_LEASE_CHILD_RE = /^lease-after-([0-9a-f]{64})\.json$/;
const RECOVERY_LEASE_CANDIDATE_RE =
  /^\.lease-(root|[0-9a-f]{64})\.([1-9][0-9]*)\.([0-9a-f]{32})\.tmp$/;
const MANIFEST_KEYS = [
  "schema_version",
  "state_mode",
  "expected_prior_pointer",
  "expected_prior_pointer_sha256",
  "prior_run_sha256",
  "prior_catalog_sha256",
  "prior_report_sha256",
  "prior_source_ids",
  "run_preimage",
  "artifact_manifest",
  "desired_pointer",
  "desired_pointer_sha256",
  "registered_source_count"
];
const ARTIFACT_KEYS = ["relative_path", "sha256", "size_bytes"];
const PLAN_ARTIFACT_KEYS = [...ARTIFACT_KEYS, "bytes"];

class StageFailure extends Error {
  constructor(result) {
    super(result.error.code);
    this.result = result;
  }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function ownDataFields(value, keys) {
  if (!isPlainObject(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) =>
    typeof key !== "string" || !keys.includes(key))) return null;
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    fields[key] = descriptor.value;
  }
  return fields;
}

function hasExactKeys(value, keys) {
  return ownDataFields(value, keys) !== null;
}

function snapshotDenseArray(value) {
  if (types.isProxy(value) || !Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
  const length = lengthDescriptor.value;
  let count = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "length") continue;
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < length && String(index) === key) {
      count += 1;
    }
  }
  if (count !== length) return null;
  const result = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    result[index] = descriptor.value;
  }
  return result;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalRepoRelativePath(value) {
  if (!isNonEmptyString(value) || value.includes("\\") || value.includes("\0") ||
      isAbsolute(value) || /^[A-Za-z]:\//.test(value)) return false;
  return value.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== "..");
}

function canonicalClone(value) {
  return JSON.parse(canonicalJsonBytes(value).toString("utf8"));
}

function expectedResult(code, path = null, persistentWritesOccurred = false) {
  return {
    ok: false,
    error: {
      kind: "expected",
      code,
      path: path === "" ? null : path,
      source_id: null,
      persistent_writes_occurred: persistentWritesOccurred
    }
  };
}

function ioResult(operation, path, persistentWritesOccurred) {
  return {
    ok: false,
    error: {
      kind: "io",
      code: "CLEANING_IO_FAILURE",
      operation,
      path: path === "" ? null : path,
      persistent_writes_occurred: persistentWritesOccurred
    }
  };
}

function failExpected(context, code, path = null) {
  throw new StageFailure(expectedResult(code, path, context.persistentWritesOccurred));
}

function failIo(context, operation, path) {
  throw new StageFailure(ioResult(operation, path, context.persistentWritesOccurred));
}

function mapFsFailure(context, error, operation, path, conflictCode = null,
  conflictPath = path) {
  if (error instanceof StageFailure) return error;
  if (conflictCode !== null && [
    "EEXIST", "ENOENT", "ELOOP", "ENOTDIR", "EISDIR"
  ].includes(error?.code)) {
    return new StageFailure(expectedResult(
      conflictCode,
      conflictPath,
      context.persistentWritesOccurred
    ));
  }
  return new StageFailure(ioResult(operation, path, context.persistentWritesOccurred));
}

async function fsCall(context, operation, path, action, conflictCode = null,
  conflictPath = path) {
  try {
    return await action();
  } catch (error) {
    throw mapFsFailure(context, error, operation, path, conflictCode, conflictPath);
  }
}

async function mutationFsCall(
  context,
  operation,
  path,
  action,
  conflictCode = null,
  conflictPath = path,
  persistentWrite = false
) {
  await reproveFixedAncestors(context);
  if (typeof context.mutationAuthority === "function") {
    await context.mutationAuthority();
  }
  const result = await fsCall(
    context,
    operation,
    path,
    action,
    conflictCode,
    conflictPath
  );
  if (persistentWrite) context.persistentWritesOccurred = true;
  return result;
}

function validateOptions(options) {
  if (!isPlainObject(options)) throw new TypeError("options must be a plain object");
  const fields = ownDataFields(options, OPTION_KEYS);
  if (fields === null || !isNonEmptyString(fields.rootDir) ||
      !isNonEmptyString(fields.runsRoot)) {
    throw new TypeError("options must have the exact staging shape");
  }
  if (types.isProxy(fields.plan)) throw new TypeError("plan must not be a Proxy");

  const requestedRoot = resolve(fields.rootDir);
  let canonicalRoot = null;
  let realpathFailure = null;
  let rootIdentity = null;
  try {
    canonicalRoot = fs.realpathSync(fields.rootDir);
  } catch {
    realpathFailure = ioResult("realpath", null, false);
  }
  if (canonicalRoot !== null) {
    try {
      const rootStat = fs.lstatSync(canonicalRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
          !validLinkCount(rootStat)) {
        realpathFailure = expectedResult("LOCAL_STATE_INVALID");
      } else {
        rootIdentity = identity(rootStat);
      }
    } catch {
      realpathFailure = ioResult("lstat", null, false);
    }
  }
  const resolvedRuns = isAbsolute(fields.runsRoot)
    ? resolve(fields.runsRoot)
    : resolve(requestedRoot, fields.runsRoot);
  const requestedRuns = resolve(requestedRoot, RUNS_ROOT);
  const canonicalRuns = canonicalRoot === null ? null : resolve(canonicalRoot, RUNS_ROOT);
  if (resolvedRuns !== requestedRuns && resolvedRuns !== canonicalRuns) {
    throw new TypeError("runsRoot must resolve to the fixed cleaning runs root");
  }
  return {
    rootDir: canonicalRoot,
    rootIdentity,
    plan: fields.plan,
    failure: realpathFailure
  };
}

function validatePublishOptions(options) {
  if (!isPlainObject(options)) throw new TypeError("options must be a plain object");
  const fields = ownDataFields(options, PUBLISH_OPTION_KEYS);
  if (fields === null || !isNonEmptyString(fields.rootDir) ||
      !isNonEmptyString(fields.runsRoot) ||
      !isNonEmptyString(fields.currentPointer)) {
    throw new TypeError("options must have the exact publication shape");
  }
  if (types.isProxy(fields.stagedRun)) {
    throw new TypeError("stagedRun must not be a Proxy");
  }

  const requestedRoot = resolve(fields.rootDir);
  let canonicalRoot = null;
  let realpathFailure = null;
  let rootIdentity = null;
  try {
    canonicalRoot = fs.realpathSync(fields.rootDir);
  } catch {
    realpathFailure = ioResult("realpath", null, false);
  }
  if (canonicalRoot !== null) {
    try {
      const rootStat = fs.lstatSync(canonicalRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
          !validLinkCount(rootStat)) {
        realpathFailure = expectedResult("LOCAL_STATE_INVALID");
      } else {
        rootIdentity = identity(rootStat);
      }
    } catch {
      realpathFailure = ioResult("lstat", null, false);
    }
  }
  const resolvedRuns = isAbsolute(fields.runsRoot)
    ? resolve(fields.runsRoot)
    : resolve(requestedRoot, fields.runsRoot);
  const requestedRuns = resolve(requestedRoot, RUNS_ROOT);
  const canonicalRuns = canonicalRoot === null ? null : resolve(canonicalRoot, RUNS_ROOT);
  if (resolvedRuns !== requestedRuns && resolvedRuns !== canonicalRuns) {
    throw new TypeError("runsRoot must resolve to the fixed cleaning runs root");
  }
  const resolvedPointer = isAbsolute(fields.currentPointer)
    ? resolve(fields.currentPointer)
    : resolve(requestedRoot, fields.currentPointer);
  const requestedPointer = resolve(requestedRoot, CURRENT_POINTER);
  const canonicalPointer = canonicalRoot === null
    ? null
    : resolve(canonicalRoot, CURRENT_POINTER);
  if (resolvedPointer !== requestedPointer && resolvedPointer !== canonicalPointer) {
    throw new TypeError("currentPointer must resolve to the fixed cleaning pointer");
  }
  return {
    rootDir: canonicalRoot,
    rootIdentity,
    stagedRun: fields.stagedRun,
    failure: realpathFailure
  };
}

function validateRecoveryOptions(options) {
  const fields = ownDataFields(options, RECOVERY_OPTION_KEYS);
  if (fields === null || !isNonEmptyString(fields.rootDir) ||
      typeof fields.confirmation !== "string") {
    throw new TypeError("options must have the exact recovery shape");
  }
  return fields;
}

function anchorRecoveryRoot(rootDir) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(rootDir);
  } catch {
    return { failure: ioResult("realpath", null, false) };
  }

  let rootStat;
  try {
    rootStat = fs.lstatSync(canonicalRoot);
  } catch {
    return { failure: ioResult("lstat", null, false) };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !validLinkCount(rootStat)) {
    return { failure: expectedResult("LOCAL_STATE_INVALID") };
  }
  return {
    rootDir: canonicalRoot,
    rootIdentity: identity(rootStat),
    failure: null
  };
}

function snapshotPlan(plan) {
  if (!isPlainObject(plan)) {
    if (types.isProxy(plan)) throw new TypeError("plan must not be a Proxy");
    return null;
  }
  const fields = ownDataFields(plan, PLAN_KEYS);
  if (fields === null) return null;
  if (types.isProxy(fields.artifacts)) {
    throw new TypeError("plan artifacts must not be a Proxy");
  }
  const artifactValues = snapshotDenseArray(fields.artifacts);
  if (artifactValues === null) return null;

  let manifest;
  try {
    manifest = canonicalClone(fields.manifest);
  } catch {
    return null;
  }
  const artifacts = [];
  for (const value of artifactValues) {
    const artifact = ownDataFields(value, PLAN_ARTIFACT_KEYS);
    if (artifact === null || types.isProxy(artifact.bytes) ||
        !types.isUint8Array(artifact.bytes)) {
      return null;
    }
    let bytes;
    try {
      bytes = Buffer.from(artifact.bytes);
    } catch {
      return null;
    }
    artifacts.push({
      relative_path: artifact.relative_path,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      bytes
    });
  }
  return {
    manifest,
    manifest_sha256: fields.manifest_sha256,
    artifacts
  };
}

function snapshotStagedRun(stagedRun) {
  if (!isPlainObject(stagedRun)) {
    throw new TypeError("stagedRun must be a plain object");
  }
  const fields = ownDataFields(stagedRun, STAGED_RUN_KEYS);
  if (fields === null || !isNonEmptyString(fields.plan_manifest_sha256) ||
      !isNonEmptyString(fields.run_sha256) ||
      !isNonEmptyString(fields.staging_path) ||
      !isNonEmptyString(fields.final_run_path)) {
    throw new TypeError("stagedRun must have the exact publication shape");
  }
  if (types.isProxy(fields.plan_manifest) || types.isProxy(fields.artifact_manifest)) {
    throw new TypeError("stagedRun values must not be Proxies");
  }
  const artifactValues = snapshotDenseArray(fields.artifact_manifest);
  if (artifactValues === null) {
    throw new TypeError("artifact_manifest must be a dense array");
  }
  let planManifest;
  try {
    planManifest = canonicalClone(fields.plan_manifest);
  } catch {
    throw new TypeError("plan_manifest must be canonical JSON data");
  }
  const artifactManifest = [];
  for (const value of artifactValues) {
    const artifact = ownDataFields(value, ARTIFACT_KEYS);
    if (artifact === null) {
      throw new TypeError("artifact_manifest entries must have the exact shape");
    }
    artifactManifest.push({ ...artifact });
  }
  return {
    plan_manifest: planManifest,
    plan_manifest_sha256: fields.plan_manifest_sha256,
    run_sha256: fields.run_sha256,
    staging_path: fields.staging_path,
    final_run_path: fields.final_run_path,
    artifact_manifest: artifactManifest
  };
}

function sameCanonical(left, right) {
  try {
    return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
  } catch {
    return false;
  }
}

function parseCanonicalDocumentBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.at(-1) !== 0x0a ||
      bytes.subarray(0, -1).includes(0x0a)) return null;
  let value;
  try {
    value = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
  } catch {
    return null;
  }
  try {
    if (!canonicalJsonDocumentBytes(value).equals(bytes)) return null;
  } catch {
    return null;
  }
  return value;
}

function validSortedIds(values) {
  if (!Array.isArray(values)) return false;
  let prior = null;
  for (const value of values) {
    if (typeof value !== "string" || !/^src_[0-9a-f]{32}$/.test(value) ||
        (prior !== null && value <= prior)) return false;
    prior = value;
  }
  return true;
}

function compiledArtifactSemantics(compiled) {
  const semantics = new Map([
    ["catalog/sources.jsonl", {
      sha256: sha256(compiled.catalog_bytes),
      sizeBytes: compiled.catalog_bytes.length
    }],
    ["cleaning-report.json", {
      sha256: sha256(compiled.report_bytes),
      sizeBytes: compiled.report_bytes.length
    }]
  ]);
  for (const source of compiled.report.run_preimage.sources) {
    semantics.set(source.cleaned_relative_path, {
      sha256: source.cleaned_sha256,
      sizeBytes: source.audit === null
        ? null
        : source.audit.output_byte_length
    });
  }
  return semantics;
}

function validateManifestBinding(manifest, manifestSha256) {
  if (!hasExactKeys(manifest, MANIFEST_KEYS) ||
      manifest.schema_version !== SCHEMA_VERSION ||
      !isSha256(manifestSha256) ||
      sha256(canonicalJsonBytes(manifest)) !== manifestSha256) return null;

  let compiledResult;
  try {
    compiledResult = compileCleaningStateArtifacts(manifest.run_preimage);
  } catch {
    return null;
  }
  if (!compiledResult.ok) return null;
  const compiled = compiledResult.value;

  if (manifest.state_mode === "initial_verified_baseline") {
    if (manifest.expected_prior_pointer !== null ||
        manifest.expected_prior_pointer_sha256 !== null ||
        manifest.prior_run_sha256 !== null ||
        manifest.prior_catalog_sha256 !== null ||
        manifest.prior_report_sha256 !== null ||
        !Array.isArray(manifest.prior_source_ids) ||
        manifest.prior_source_ids.length !== 0) return null;
  } else if (manifest.state_mode === "incremental") {
    if (!isValidCleaningPointerValue(manifest.expected_prior_pointer) ||
        !isSha256(manifest.expected_prior_pointer_sha256) ||
        sha256(canonicalJsonDocumentBytes(manifest.expected_prior_pointer)) !==
          manifest.expected_prior_pointer_sha256 ||
        manifest.prior_run_sha256 !== manifest.expected_prior_pointer.run_sha256 ||
        manifest.prior_catalog_sha256 !== manifest.expected_prior_pointer.catalog_sha256 ||
        manifest.prior_report_sha256 !== manifest.expected_prior_pointer.report_sha256 ||
        !validSortedIds(manifest.prior_source_ids)) return null;
  } else {
    return null;
  }

  if (!sameCanonical(manifest.desired_pointer, compiled.pointer) ||
      !isSha256(manifest.desired_pointer_sha256) ||
      sha256(compiled.pointer_bytes) !== manifest.desired_pointer_sha256 ||
      manifest.registered_source_count !== manifest.run_preimage.sources.length) return null;

  const manifestArtifacts = snapshotDenseArray(manifest.artifact_manifest);
  if (manifestArtifacts === null) return null;
  const expectedArtifactPaths = [
    ...manifest.run_preimage.sources.map((source) => source.cleaned_relative_path),
    "catalog/sources.jsonl",
    "cleaning-report.json"
  ].sort(compareAscii);
  if (manifestArtifacts.length !== expectedArtifactPaths.length) return null;

  const semantics = compiledArtifactSemantics(compiled);
  const checkedManifestArtifacts = [];
  for (let index = 0; index < manifestArtifacts.length; index += 1) {
    const artifact = ownDataFields(manifestArtifacts[index], ARTIFACT_KEYS);
    const semantic = artifact === null
      ? undefined
      : semantics.get(artifact.relative_path);
    if (artifact === null || artifact.relative_path !== expectedArtifactPaths[index] ||
        !isCanonicalRepoRelativePath(artifact.relative_path) ||
        !isSha256(artifact.sha256) || !isNonNegativeInteger(artifact.size_bytes) ||
        semantic === undefined || artifact.sha256 !== semantic.sha256 ||
        (semantic.sizeBytes !== null &&
          artifact.size_bytes !== semantic.sizeBytes)) return null;
    checkedManifestArtifacts.push({ ...artifact });
  }

  return {
    compiled,
    checkedManifestArtifacts,
    runSha256: compiled.run_sha256
  };
}

function validatePlan(plan) {
  if (plan === null) return null;
  const binding = validateManifestBinding(plan.manifest, plan.manifest_sha256);
  if (binding === null) return null;
  const { manifest } = plan;
  const { checkedManifestArtifacts, runSha256 } = binding;

  if (plan.artifacts.length !== checkedManifestArtifacts.length) return null;
  for (let index = 0; index < plan.artifacts.length; index += 1) {
    const artifact = plan.artifacts[index];
    const bound = checkedManifestArtifacts[index];
    if (artifact.relative_path !== bound.relative_path || artifact.sha256 !== bound.sha256 ||
        artifact.size_bytes !== bound.size_bytes ||
        artifact.size_bytes !== artifact.bytes.length ||
        sha256(artifact.bytes) !== artifact.sha256) return null;
  }

  const sourceByPath = new Map(manifest.run_preimage.sources.map((source) =>
    [source.cleaned_relative_path, source]));
  for (const artifact of plan.artifacts) {
    if (artifact.relative_path === "catalog/sources.jsonl") {
      if (!artifact.bytes.equals(binding.compiled.catalog_bytes)) return null;
    } else if (artifact.relative_path === "cleaning-report.json") {
      if (!artifact.bytes.equals(binding.compiled.report_bytes)) return null;
    } else {
      const source = sourceByPath.get(artifact.relative_path);
      if (source === undefined || artifact.sha256 !== source.cleaned_sha256) return null;
    }
  }

  const stagingPath = `.local/tmp/cleaning-${plan.manifest_sha256}`;
  const finalRunPath = `${RUNS_ROOT}/${runSha256}`;
  const artifactIntents = checkedManifestArtifacts.map((artifact) => ({
    relative_path: artifact.relative_path,
    canonical_path: `${finalRunPath}/${artifact.relative_path}`,
    temp_path: `${finalRunPath}/${artifact.relative_path}.tmp-${artifact.sha256}.partial`,
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes
  }));
  const intent = {
    schema_version: SCHEMA_VERSION,
    record_kind: "staging_intent",
    plan_manifest: manifest,
    plan_manifest_sha256: plan.manifest_sha256,
    run_sha256: runSha256,
    staging_path: stagingPath,
    final_run_path: finalRunPath,
    artifact_intents: artifactIntents
  };
  const intentBytes = canonicalJsonDocumentBytes(intent);
  const intentSha256 = sha256(intentBytes);
  const intentPath = `${stagingPath}/intent.json`;
  return {
    plan,
    runSha256,
    stagingPath,
    finalRunPath,
    artifactIntents,
    intent,
    intentBytes,
    intentPath,
    intentCandidatePath: `${stagingPath}/intent.json.tmp-${intentSha256}.partial`,
    artifactBytes: new Map(plan.artifacts.map((artifact) =>
      [artifact.relative_path, artifact.bytes]))
  };
}

function validateStagedRun(stagedRun) {
  const manifest = stagedRun.plan_manifest;
  const binding = validateManifestBinding(
    manifest,
    stagedRun.plan_manifest_sha256
  );
  if (binding === null) return null;
  const stagingPath = `.local/tmp/cleaning-${stagedRun.plan_manifest_sha256}`;
  const finalRunPath = `${RUNS_ROOT}/${binding.runSha256}`;
  if (stagedRun.run_sha256 !== binding.runSha256 ||
      stagedRun.staging_path !== stagingPath ||
      stagedRun.final_run_path !== finalRunPath ||
      !sameCanonical(stagedRun.artifact_manifest, binding.checkedManifestArtifacts)) {
    return null;
  }
  return {
    manifest,
    planManifestSha256: stagedRun.plan_manifest_sha256,
    runSha256: binding.runSha256,
    stagingPath,
    finalRunPath,
    artifactManifest: binding.checkedManifestArtifacts,
    artifactIntents: binding.checkedManifestArtifacts.map((artifact) => ({
      ...artifact,
      canonical_path: `${finalRunPath}/${artifact.relative_path}`
    })),
    compiled: binding.compiled,
    desiredPointerBytes: canonicalJsonDocumentBytes(manifest.desired_pointer),
    expectedPriorPointerBytes: manifest.expected_prior_pointer === null
      ? null
      : canonicalJsonDocumentBytes(manifest.expected_prior_pointer)
  };
}

function layoutFromCommitIntent(intent) {
  if (!hasExactKeys(intent, COMMIT_LOCK_KEYS) ||
      intent.schema_version !== SCHEMA_VERSION ||
      !Number.isSafeInteger(intent.owner_pid) || intent.owner_pid <= 0 ||
      typeof intent.owner_nonce !== "string" ||
      !/^[0-9a-f]{32}$/.test(intent.owner_nonce)) return null;
  const binding = validateManifestBinding(
    intent.plan_manifest,
    intent.plan_manifest_sha256
  );
  if (binding === null || intent.run_sha256 !== binding.runSha256 ||
      intent.expected_prior_pointer_sha256 !==
        intent.plan_manifest.expected_prior_pointer_sha256 ||
      intent.desired_pointer_sha256 !== intent.plan_manifest.desired_pointer_sha256 ||
      !sameCanonical(intent.desired_pointer, intent.plan_manifest.desired_pointer)) {
    return null;
  }
  const finalRunPath = `${RUNS_ROOT}/${binding.runSha256}`;
  return {
    manifest: intent.plan_manifest,
    planManifestSha256: intent.plan_manifest_sha256,
    runSha256: binding.runSha256,
    finalRunPath,
    artifactManifest: binding.checkedManifestArtifacts,
    artifactIntents: binding.checkedManifestArtifacts.map((artifact) => ({
      ...artifact,
      canonical_path: `${finalRunPath}/${artifact.relative_path}`
    })),
    compiled: binding.compiled,
    desiredPointerBytes: canonicalJsonDocumentBytes(intent.plan_manifest.desired_pointer),
    expectedPriorPointerBytes: intent.plan_manifest.expected_prior_pointer === null
      ? null
      : canonicalJsonDocumentBytes(intent.plan_manifest.expected_prior_pointer)
  };
}

function validateCommitLockBytes(bytes) {
  const intent = parseCanonicalDocumentBytes(bytes);
  const layout = layoutFromCommitIntent(intent);
  return layout === null ? null : { intent, layout };
}

function absolutePath(context, repoPath) {
  return repoPath === "" ? context.rootDir :
    join(context.rootDir, ...repoPath.split("/"));
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileFacts(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, nlink: stat.nlink };
}

function sameFileFacts(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink;
}

function validLinkCount(stat) {
  return Number.isSafeInteger(stat.nlink) && stat.nlink > 0;
}

async function maybeLstat(context, repoPath, conflictCode, conflictPath = repoPath) {
  try {
    return await fs.promises.lstat(absolutePath(context, repoPath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw mapFsFailure(context, error, "lstat", repoPath, conflictCode, conflictPath);
  }
}

async function closeHandle(context, handle, path, primaryFailure = null) {
  try {
    await handle.close();
  } catch (error) {
    if (primaryFailure === null) {
      throw mapFsFailure(context, error, "close", path);
    }
  }
  if (primaryFailure !== null) throw primaryFailure;
}

async function inspectDirectory(context, repoPath, conflictCode) {
  const statBefore = await maybeLstat(context, repoPath, conflictCode);
  if (statBefore === null) return null;
  if (!statBefore.isDirectory() || statBefore.isSymbolicLink() ||
      !validLinkCount(statBefore)) failExpected(context, conflictCode, repoPath);
  let handle = null;
  let primaryFailure = null;
  try {
    handle = await fsCall(
      context,
      "open",
      repoPath,
      () => fs.promises.open(absolutePath(context, repoPath), DIRECTORY_FLAGS),
      conflictCode
    );
    const handleStat = await fsCall(context, "fstat", repoPath, () => handle.stat());
    const statAfter = await maybeLstat(context, repoPath, conflictCode);
    if (statAfter === null || !handleStat.isDirectory() || !statAfter.isDirectory() ||
        statAfter.isSymbolicLink() || !validLinkCount(handleStat) ||
        !sameIdentity(identity(statBefore), identity(handleStat)) ||
        !sameIdentity(identity(handleStat), identity(statAfter))) {
      failExpected(context, conflictCode, repoPath);
    }
    return identity(handleStat);
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (handle !== null) await closeHandle(context, handle, repoPath, primaryFailure);
  }
  throw primaryFailure;
}

function rememberFixedAncestor(context, repoPath, provenIdentity) {
  if (provenIdentity === null) return null;
  const expectedIdentity = context.fixedAncestorProofs.get(repoPath);
  if (expectedIdentity !== undefined &&
      !sameIdentity(expectedIdentity, provenIdentity)) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
  if (expectedIdentity === undefined) {
    context.fixedAncestorProofs.set(repoPath, provenIdentity);
  }
  return provenIdentity;
}

async function reproveFixedAncestors(context) {
  for (const [repoPath, expectedIdentity] of context.fixedAncestorProofs) {
    const actualIdentity = await inspectDirectory(
      context,
      repoPath,
      "LOCAL_STATE_INVALID"
    );
    if (actualIdentity === null || !sameIdentity(expectedIdentity, actualIdentity)) {
      failExpected(context, "LOCAL_STATE_INVALID", repoPath);
    }
    if (context.privateDirectoryProofs?.has(repoPath)) {
      const stat = await maybeLstat(context, repoPath, "LOCAL_STATE_INVALID");
      if (stat === null || !stat.isDirectory() || stat.isSymbolicLink() ||
          (stat.mode & 0o7777) !== 0o700 ||
          !sameIdentity(expectedIdentity, identity(stat))) {
        failExpected(context, "LOCAL_STATE_INVALID", repoPath);
      }
    }
  }
}

async function inspectLeaf(context, repoPath, conflictCode, maxBytes, syncFile = false) {
  const parentPath = dirname(repoPath).split("\\").join("/");
  const parentIdentity = await inspectDirectory(context, parentPath, conflictCode);
  if (parentIdentity === null) return null;
  const statBefore = await maybeLstat(context, repoPath, conflictCode);
  if (statBefore === null) return null;
  if (!statBefore.isFile() || statBefore.isSymbolicLink() ||
      !validLinkCount(statBefore) || statBefore.size > maxBytes) {
    failExpected(context, conflictCode, repoPath);
  }

  let handle = null;
  let primaryFailure = null;
  try {
    try {
      handle = await fs.promises.open(absolutePath(context, repoPath), READ_FLAGS);
    } catch (error) {
      const parentAfterFailure = await inspectDirectory(context, parentPath, conflictCode);
      if (parentAfterFailure === null || !sameIdentity(parentIdentity, parentAfterFailure)) {
        failExpected(context, conflictCode, parentPath);
      }
      const leafAfterFailure = await maybeLstat(context, repoPath, conflictCode);
      if (leafAfterFailure === null || !leafAfterFailure.isFile() ||
          leafAfterFailure.isSymbolicLink() ||
          !sameIdentity(identity(statBefore), identity(leafAfterFailure))) {
        failExpected(context, conflictCode, repoPath);
      }
      throw mapFsFailure(context, error, "open", repoPath, conflictCode);
    }
    const handleStatBefore = await fsCall(context, "fstat", repoPath, () => handle.stat());
    const parentAfterOpen = await inspectDirectory(context, parentPath, conflictCode);
    if (parentAfterOpen === null || !sameIdentity(parentIdentity, parentAfterOpen)) {
      failExpected(context, conflictCode, parentPath);
    }
    if (!handleStatBefore.isFile() || !validLinkCount(handleStatBefore) ||
        !sameFileFacts(fileFacts(statBefore), fileFacts(handleStatBefore)) ||
        handleStatBefore.size > maxBytes) failExpected(context, conflictCode, repoPath);

    const bytes = Buffer.allocUnsafe(handleStatBefore.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await fsCall(
        context,
        "read",
        repoPath,
        () => handle.read(bytes, offset, bytes.length - offset, offset)
      );
      if (result.bytesRead === 0) failExpected(context, conflictCode, repoPath);
      offset += result.bytesRead;
    }

    if (syncFile) {
      await mutationFsCall(context, "fsync", repoPath, () => handle.sync());
    }

    const handleStatAfter = await fsCall(context, "fstat", repoPath, () => handle.stat());
    const statAfter = await maybeLstat(context, repoPath, conflictCode);
    const parentAfter = await inspectDirectory(context, parentPath, conflictCode);
    if (parentAfter === null || !sameIdentity(parentIdentity, parentAfter)) {
      failExpected(context, conflictCode, parentPath);
    }
    if (statAfter === null || !statAfter.isFile() || statAfter.isSymbolicLink() ||
        !sameFileFacts(fileFacts(handleStatBefore), fileFacts(handleStatAfter)) ||
        !sameFileFacts(fileFacts(handleStatAfter), fileFacts(statAfter))) {
      failExpected(context, conflictCode, repoPath);
    }
    return {
      bytes: Buffer.from(bytes),
      facts: fileFacts(handleStatAfter),
      parent: parentIdentity
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (handle !== null) await closeHandle(context, handle, repoPath, primaryFailure);
  }
  throw primaryFailure;
}

async function readDirectoryNames(
  context,
  repoPath,
  conflictCode,
  expectedIdentity = null
) {
  const before = await inspectDirectory(context, repoPath, conflictCode);
  if (before === null) return null;
  if (expectedIdentity !== null && !sameIdentity(expectedIdentity, before)) {
    failExpected(context, conflictCode, repoPath);
  }
  const names = await fsCall(
    context,
    "readdir",
    repoPath,
    () => fs.promises.readdir(absolutePath(context, repoPath)),
    conflictCode
  );
  const after = await inspectDirectory(context, repoPath, conflictCode);
  if (after === null || !sameIdentity(before, after) ||
      (expectedIdentity !== null && !sameIdentity(expectedIdentity, after))) {
    failExpected(context, conflictCode, repoPath);
  }
  return names.sort(compareAscii);
}

async function reproveScannedDirectories(
  context,
  scan,
  conflictCode,
  beforePath = null
) {
  for (const [path, expectedIdentity] of [...scan.directories.entries()]
    .sort(([left], [right]) => compareAscii(left, right))) {
    if (beforePath !== null && compareAscii(path, beforePath) >= 0) continue;
    const actualIdentity = await inspectDirectory(context, path, conflictCode);
    if (actualIdentity === null || !sameIdentity(expectedIdentity, actualIdentity)) {
      failExpected(context, conflictCode, path);
    }
  }
}

function proveScannedLeafParent(context, scan, leafPath, leaf, conflictCode) {
  const parentPath = dirname(leafPath).split("\\").join("/");
  const expectedParent = scan.directories.get(parentPath);
  if (expectedParent === undefined || leaf === null ||
      !sameIdentity(expectedParent, leaf.parent)) {
    failExpected(context, conflictCode, parentPath);
  }
}

async function scanTree(context, rootPath, conflictCode, expectedKinds) {
  const rootIdentity = await inspectDirectory(context, rootPath, conflictCode);
  if (rootIdentity === null) return null;
  const entries = [];
  const conflicts = [];
  const directories = new Map([[rootPath, rootIdentity]]);
  async function visit(path, expectedIdentity) {
    const names = await readDirectoryNames(
      context,
      path,
      conflictCode,
      expectedIdentity
    );
    if (names === null) failExpected(context, conflictCode, path);
    for (const name of names) {
      const childPath = `${path}/${name}`;
      const stat = await maybeLstat(context, childPath, conflictCode);
      if (stat === null) failExpected(context, conflictCode, childPath);
      const kind = stat.isDirectory() && !stat.isSymbolicLink()
        ? "directory"
        : stat.isFile() && !stat.isSymbolicLink()
          ? "file"
          : "other";
      const expectedKind = expectedKinds.get(childPath);
      if (expectedKind === undefined || kind !== expectedKind) {
        conflicts.push(childPath);
        continue;
      }
      entries.push({ path: childPath, kind });
      if (expectedKind === "directory") {
        const childIdentity = identity(stat);
        directories.set(childPath, childIdentity);
        await visit(childPath, childIdentity);
      }
    }
  }
  await visit(rootPath, rootIdentity);
  entries.sort((left, right) => compareAscii(left.path, right.path));
  conflicts.sort(compareAscii);
  const scan = {
    entries,
    directories,
    structuralConflict: conflicts[0] ?? null
  };
  await reproveScannedDirectories(
    context,
    scan,
    conflictCode,
    scan.structuralConflict
  );
  return scan;
}

function entriesBeforeStructuralConflict(scan) {
  if (scan === null || scan.structuralConflict === null) return scan?.entries ?? null;
  return scan.entries.filter((entry) =>
    compareAscii(entry.path, scan.structuralConflict) < 0);
}

async function failDeferredStructuralConflict(context, scan, conflictCode) {
  if (scan === null || scan.structuralConflict === null) return;
  await reproveScannedDirectories(
    context,
    scan,
    conflictCode,
    scan.structuralConflict
  );
  failExpected(context, conflictCode, scan.structuralConflict);
}

function requiredFinalDirectories(layout) {
  const directories = new Set([layout.finalRunPath]);
  for (const artifact of layout.artifactIntents) {
    let parent = dirname(artifact.canonical_path).split("\\").join("/");
    while (parent.startsWith(`${layout.finalRunPath}/`)) {
      directories.add(parent);
      parent = dirname(parent).split("\\").join("/");
    }
  }
  return directories;
}

function stagingExpectedKinds(layout) {
  return new Map([
    [layout.intentPath, "file"],
    [layout.intentCandidatePath, "file"]
  ]);
}

function finalExpectedKinds(layout, requiredDirectories) {
  const kinds = new Map();
  for (const path of requiredDirectories) {
    if (path !== layout.finalRunPath) kinds.set(path, "directory");
  }
  for (const artifact of layout.artifactIntents) {
    kinds.set(artifact.canonical_path, "file");
    kinds.set(artifact.temp_path, "file");
  }
  return kinds;
}

function classifyPlannedBytes(actual, planned) {
  if (actual.length > planned.length) return "invalid";
  if (!planned.subarray(0, actual.length).equals(actual)) return "invalid";
  return actual.length === planned.length ? "full" : "prefix";
}

function makeLeafExpectation(scan, repoPath, leaf) {
  const parentPath = dirname(repoPath).split("\\").join("/");
  return {
    present: leaf !== null,
    leaf,
    parent: scan?.directories.get(parentPath) ?? null
  };
}

function makePresentLeafExpectation(repoPath, leaf) {
  return makeLeafExpectation({ directories: new Map([
    [dirname(repoPath).split("\\").join("/"), leaf.parent]
  ]) }, repoPath, leaf);
}

async function reproveLeafExpectation(
  context,
  repoPath,
  plannedBytes,
  conflictCode,
  expectation
) {
  const parentPath = dirname(repoPath).split("\\").join("/");
  if (expectation.parent !== null) {
    const parent = await inspectDirectory(context, parentPath, conflictCode);
    if (parent === null || !sameIdentity(expectation.parent, parent)) {
      failExpected(context, conflictCode, parentPath);
    }
  }
  const current = await inspectLeaf(
    context,
    repoPath,
    conflictCode,
    plannedBytes.length
  );
  if (!expectation.present) {
    if (current !== null) failExpected(context, conflictCode, repoPath);
    return null;
  }
  if (expectation.leaf === null || current === null ||
      classifyPlannedBytes(current.bytes, plannedBytes) === "invalid" ||
      !current.bytes.equals(expectation.leaf.bytes) ||
      !sameFileFacts(expectation.leaf.facts, current.facts)) {
    failExpected(context, conflictCode, repoPath);
  }
  if (!sameIdentity(expectation.leaf.parent, current.parent) ||
      (expectation.parent !== null &&
        !sameIdentity(expectation.parent, current.parent))) {
    failExpected(context, conflictCode, parentPath);
  }
  return current;
}

async function preflight(context, layout) {
  const local = await inspectDirectory(context, ".local", "LOCAL_STATE_INVALID");
  rememberFixedAncestor(context, ".local", local);
  if (local !== null) {
    rememberFixedAncestor(
      context,
      ".local/tmp",
      await inspectDirectory(context, ".local/tmp", "LOCAL_STATE_INVALID")
    );
  }

  const stagingScan = await scanTree(
    context,
    layout.stagingPath,
    "STAGING_CONFLICT",
    stagingExpectedKinds(layout)
  );
  const stagingEntries = entriesBeforeStructuralConflict(stagingScan);
  let intentLeaf = null;
  let candidateLeaf = null;
  if (stagingEntries !== null) {
    for (const entry of stagingEntries) {
      if (entry.path !== layout.intentPath && entry.path !== layout.intentCandidatePath) {
        failExpected(context, "STAGING_CONFLICT", entry.path);
      }
      if (entry.kind !== "file") failExpected(context, "STAGING_CONFLICT", entry.path);
      if (entry.path === layout.intentPath) {
        intentLeaf = await inspectLeaf(
          context,
          entry.path,
          "STAGING_CONFLICT",
          layout.intentBytes.length
        );
        proveScannedLeafParent(
          context,
          stagingScan,
          entry.path,
          intentLeaf,
          "STAGING_CONFLICT"
        );
        if (intentLeaf === null || !intentLeaf.bytes.equals(layout.intentBytes)) {
          failExpected(context, "STAGING_CONFLICT", entry.path);
        }
      } else {
        candidateLeaf = await inspectLeaf(
          context,
          entry.path,
          "STAGING_CONFLICT",
          layout.intentBytes.length
        );
        proveScannedLeafParent(
          context,
          stagingScan,
          entry.path,
          candidateLeaf,
          "STAGING_CONFLICT"
        );
        if (candidateLeaf === null ||
            classifyPlannedBytes(candidateLeaf.bytes, layout.intentBytes) === "invalid") {
          failExpected(context, "STAGING_CONFLICT", entry.path);
        }
      }
    }
  }
  await failDeferredStructuralConflict(context, stagingScan, "STAGING_CONFLICT");

  if (local !== null) {
    const cleaned = await inspectDirectory(context, ".local/cleaned", "LOCAL_STATE_INVALID");
    rememberFixedAncestor(context, ".local/cleaned", cleaned);
    if (cleaned !== null) {
      rememberFixedAncestor(
        context,
        RUNS_ROOT,
        await inspectDirectory(context, RUNS_ROOT, "LOCAL_STATE_INVALID")
      );
    }
  }

  const requiredDirectories = requiredFinalDirectories(layout);
  const finalScan = await scanTree(
    context,
    layout.finalRunPath,
    "RUN_CONFLICT",
    finalExpectedKinds(layout, requiredDirectories)
  );
  const finalEntries = entriesBeforeStructuralConflict(finalScan);
  const canonicalByPath = new Map();
  const tempByPath = new Map();
  for (const artifact of layout.artifactIntents) {
    canonicalByPath.set(artifact.canonical_path, artifact);
    tempByPath.set(artifact.temp_path, artifact);
  }
  const canonicalStates = new Map();
  const tempStates = new Map();
  if (finalEntries !== null) {
    for (const entry of finalEntries) {
      if (requiredDirectories.has(entry.path)) {
        if (entry.kind !== "directory") failExpected(context, "RUN_CONFLICT", entry.path);
        continue;
      }
      const artifact = canonicalByPath.get(entry.path) ?? tempByPath.get(entry.path);
      if (artifact === undefined || entry.kind !== "file") {
        failExpected(context, "RUN_CONFLICT", entry.path);
      }
      const planned = context.layout.artifactBytes.get(artifact.relative_path);
      const leaf = await inspectLeaf(
        context,
        entry.path,
        "RUN_CONFLICT",
        planned.length
      );
      proveScannedLeafParent(context, finalScan, entry.path, leaf, "RUN_CONFLICT");
      if (leaf === null) failExpected(context, "RUN_CONFLICT", entry.path);
      const state = classifyPlannedBytes(leaf.bytes, planned);
      if (canonicalByPath.has(entry.path)) {
        if (state !== "full") failExpected(context, "RUN_CONFLICT", entry.path);
        canonicalStates.set(entry.path, leaf);
      } else {
        if (state === "invalid") failExpected(context, "RUN_CONFLICT", entry.path);
        tempStates.set(entry.path, { ...leaf, state });
      }
    }
  }
  await failDeferredStructuralConflict(context, finalScan, "RUN_CONFLICT");

  if (intentLeaf === null && (canonicalStates.size > 0 || tempStates.size > 0)) {
    const complete = canonicalStates.size === layout.artifactIntents.length &&
      tempStates.size === 0;
    if (!complete) {
      const path = [...canonicalStates.keys(), ...tempStates.keys()].sort(compareAscii)[0];
      failExpected(context, "RUN_CONFLICT", path);
    }
  }
  if (stagingScan !== null) {
    await reproveScannedDirectories(context, stagingScan, "STAGING_CONFLICT");
  }
  if (finalScan !== null) {
    await reproveScannedDirectories(context, finalScan, "RUN_CONFLICT");
  }
  const stagingExpectations = new Map([
    [layout.intentPath, makeLeafExpectation(stagingScan, layout.intentPath, intentLeaf)],
    [
      layout.intentCandidatePath,
      makeLeafExpectation(stagingScan, layout.intentCandidatePath, candidateLeaf)
    ]
  ]);
  const canonicalExpectations = new Map();
  const tempExpectations = new Map();
  for (const artifact of layout.artifactIntents) {
    canonicalExpectations.set(
      artifact.canonical_path,
      makeLeafExpectation(
        finalScan,
        artifact.canonical_path,
        canonicalStates.get(artifact.canonical_path) ?? null
      )
    );
    tempExpectations.set(
      artifact.temp_path,
      makeLeafExpectation(
        finalScan,
        artifact.temp_path,
        tempStates.get(artifact.temp_path) ?? null
      )
    );
  }
  return {
    intentLeaf,
    candidateLeaf,
    canonicalStates,
    tempStates,
    stagingExpectations,
    canonicalExpectations,
    tempExpectations,
    stagingScan,
    finalScan
  };
}

function isCompleteFinalAdoption(layout, state) {
  return state.intentLeaf === null &&
    state.canonicalStates.size === layout.artifactIntents.length &&
    state.tempStates.size === 0;
}

async function reproveCompleteFinalAdoption(context, layout, state) {
  if (!isCompleteFinalAdoption(layout, state) || state.finalScan === null) {
    failExpected(context, "RUN_CONFLICT", layout.finalRunPath);
  }
  const requiredDirectories = requiredFinalDirectories(layout);
  const scan = await scanTree(
    context,
    layout.finalRunPath,
    "RUN_CONFLICT",
    finalExpectedKinds(layout, requiredDirectories)
  );
  if (scan === null) failExpected(context, "RUN_CONFLICT", layout.finalRunPath);

  const expectedPaths = new Set(
    [...requiredDirectories]
      .filter((path) => path !== layout.finalRunPath)
      .concat(layout.artifactIntents.map((artifact) => artifact.canonical_path))
  );
  const artifactByCanonicalPath = new Map(layout.artifactIntents.map((artifact) =>
    [artifact.canonical_path, artifact]));
  for (const entry of entriesBeforeStructuralConflict(scan)) {
    if (requiredDirectories.has(entry.path)) {
      const expectedIdentity = state.finalScan.directories.get(entry.path);
      const currentIdentity = scan.directories.get(entry.path);
      if (expectedIdentity === undefined || currentIdentity === undefined ||
          !sameIdentity(expectedIdentity, currentIdentity)) {
        failExpected(context, "RUN_CONFLICT", entry.path);
      }
      continue;
    }
    const artifact = artifactByCanonicalPath.get(entry.path);
    if (artifact === undefined || entry.kind !== "file") {
      failExpected(context, "RUN_CONFLICT", entry.path);
    }
    const expectedLeaf = state.canonicalStates.get(entry.path);
    const planned = layout.artifactBytes.get(artifact.relative_path);
    const currentLeaf = await inspectLeaf(
      context,
      entry.path,
      "RUN_CONFLICT",
      planned.length
    );
    if (expectedLeaf === undefined || currentLeaf === null ||
        !currentLeaf.bytes.equals(planned) ||
        !sameFileFacts(expectedLeaf.facts, currentLeaf.facts)) {
      failExpected(context, "RUN_CONFLICT", entry.path);
    }
    proveScannedLeafParent(context, scan, entry.path, currentLeaf, "RUN_CONFLICT");
  }
  await failDeferredStructuralConflict(context, scan, "RUN_CONFLICT");

  const actualPaths = new Set(scan.entries.map(({ path }) => path));
  const topologyDifference = [...new Set([...expectedPaths, ...actualPaths])]
    .sort(compareAscii)
    .find((path) => expectedPaths.has(path) !== actualPaths.has(path));
  if (topologyDifference !== undefined) {
    failExpected(context, "RUN_CONFLICT", topologyDifference);
  }

  for (const [path, expectedIdentity] of [...state.finalScan.directories.entries()]
    .sort(([left], [right]) => compareAscii(left, right))) {
    const currentIdentity = scan.directories.get(path);
    if (currentIdentity === undefined || !sameIdentity(expectedIdentity, currentIdentity)) {
      failExpected(context, "RUN_CONFLICT", path);
    }
  }

  for (const artifact of layout.artifactIntents) {
    const expectedLeaf = state.canonicalStates.get(artifact.canonical_path);
    const planned = layout.artifactBytes.get(artifact.relative_path);
    const currentLeaf = await inspectLeaf(
      context,
      artifact.canonical_path,
      "RUN_CONFLICT",
      planned.length
    );
    if (expectedLeaf === undefined || currentLeaf === null ||
        !currentLeaf.bytes.equals(planned) ||
        !sameFileFacts(expectedLeaf.facts, currentLeaf.facts)) {
      failExpected(context, "RUN_CONFLICT", artifact.canonical_path);
    }
    if (!sameIdentity(expectedLeaf.parent, currentLeaf.parent)) {
      failExpected(
        context,
        "RUN_CONFLICT",
        dirname(artifact.canonical_path).split("\\").join("/")
      );
    }
    proveScannedLeafParent(
      context,
      scan,
      artifact.canonical_path,
      currentLeaf,
      "RUN_CONFLICT"
    );
  }
  await reproveScannedDirectories(context, scan, "RUN_CONFLICT");
}

async function syncDirectory(context, repoPath, conflictCode) {
  const statBefore = await maybeLstat(context, repoPath, conflictCode);
  if (statBefore === null || !statBefore.isDirectory() || statBefore.isSymbolicLink() ||
      !validLinkCount(statBefore)) {
    failExpected(context, conflictCode, repoPath);
  }
  let handle = null;
  let primaryFailure = null;
  try {
    handle = await fsCall(
      context,
      "open",
      repoPath,
      () => fs.promises.open(absolutePath(context, repoPath), DIRECTORY_FLAGS),
      conflictCode
    );
    const handleStatBefore = await fsCall(
      context,
      "fstat",
      repoPath,
      () => handle.stat()
    );
    const pathBeforeSync = await maybeLstat(context, repoPath, conflictCode);
    if (pathBeforeSync === null || !handleStatBefore.isDirectory() ||
        !pathBeforeSync.isDirectory() || pathBeforeSync.isSymbolicLink() ||
        !validLinkCount(handleStatBefore) || !validLinkCount(pathBeforeSync) ||
        !sameIdentity(identity(statBefore), identity(handleStatBefore)) ||
        !sameIdentity(identity(handleStatBefore), identity(pathBeforeSync))) {
      failExpected(context, conflictCode, repoPath);
    }
    await mutationFsCall(context, "fsync", repoPath, () => handle.sync());
    const handleStatAfter = await fsCall(
      context,
      "fstat",
      repoPath,
      () => handle.stat()
    );
    const pathAfterSync = await maybeLstat(context, repoPath, conflictCode);
    if (pathAfterSync === null || !handleStatAfter.isDirectory() ||
        !pathAfterSync.isDirectory() || pathAfterSync.isSymbolicLink() ||
        !validLinkCount(handleStatAfter) || !validLinkCount(pathAfterSync) ||
        !sameIdentity(identity(handleStatBefore), identity(handleStatAfter)) ||
        !sameIdentity(identity(handleStatAfter), identity(pathAfterSync))) {
      failExpected(context, conflictCode, repoPath);
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (handle !== null) await closeHandle(context, handle, repoPath, primaryFailure);
  }
  if (primaryFailure !== null) throw primaryFailure;
}

async function ensureDirectory(context, repoPath, conflictCode) {
  const existing = await inspectDirectory(context, repoPath, conflictCode);
  if (existing !== null) return existing;
  const parentPath = dirname(repoPath).split("\\").join("/");
  const parentIdentity = parentPath === "."
    ? await inspectDirectory(context, "", "LOCAL_STATE_INVALID")
    : await inspectDirectory(context, parentPath, conflictCode);
  if (parentIdentity === null) failExpected(context, conflictCode, parentPath);
  await mutationFsCall(
    context,
    "mkdir",
    repoPath,
    () => fs.promises.mkdir(absolutePath(context, repoPath), { mode: 0o700 }),
    conflictCode,
    repoPath,
    true
  );
  await syncDirectory(context, parentPath === "." ? "" : parentPath, conflictCode);
  const parentAfter = parentPath === "."
    ? await inspectDirectory(context, "", "LOCAL_STATE_INVALID")
    : await inspectDirectory(context, parentPath, conflictCode);
  if (parentAfter === null || !sameIdentity(parentIdentity, parentAfter)) {
    failExpected(context, conflictCode, parentPath === "." ? null : parentPath);
  }
  const created = await inspectDirectory(context, repoPath, conflictCode);
  if (created === null) {
    failExpected(context, conflictCode, repoPath);
  }
  return created;
}

async function unlinkProvenLeaf(
  context,
  repoPath,
  plannedBytes,
  conflictCode,
  expectedFacts = null
) {
  const before = await inspectLeaf(context, repoPath, conflictCode, plannedBytes.length);
  if (before === null || classifyPlannedBytes(before.bytes, plannedBytes) === "invalid" ||
      (expectedFacts !== null && !sameFileFacts(expectedFacts, before.facts))) {
    failExpected(context, conflictCode, repoPath);
  }
  const parentPath = dirname(repoPath).split("\\").join("/");
  await syncDirectory(context, parentPath, conflictCode);
  const beforeUnlink = await inspectLeaf(
    context,
    repoPath,
    conflictCode,
    plannedBytes.length
  );
  if (beforeUnlink === null ||
      classifyPlannedBytes(beforeUnlink.bytes, plannedBytes) === "invalid" ||
      !sameFileFacts(before.facts, beforeUnlink.facts) ||
      !sameIdentity(before.parent, beforeUnlink.parent) ||
      (expectedFacts !== null && !sameFileFacts(expectedFacts, beforeUnlink.facts))) {
    failExpected(context, conflictCode, repoPath);
  }
  const parentBeforeUnlink = await inspectDirectory(context, parentPath, conflictCode);
  if (parentBeforeUnlink === null || !sameIdentity(beforeUnlink.parent, parentBeforeUnlink)) {
    failExpected(context, conflictCode, parentPath);
  }
  await mutationFsCall(
    context,
    "unlink",
    repoPath,
    () => fs.promises.unlink(absolutePath(context, repoPath)),
    conflictCode,
    repoPath,
    true
  );
  const parentAfterUnlink = await inspectDirectory(context, parentPath, conflictCode);
  if (parentAfterUnlink === null || !sameIdentity(before.parent, parentAfterUnlink)) {
    failExpected(context, conflictCode, parentPath);
  }
  if (await maybeLstat(context, repoPath, conflictCode) !== null) {
    failExpected(context, conflictCode, repoPath);
  }
  await syncDirectory(context, parentPath, conflictCode);
  const parentAfterSync = await inspectDirectory(context, parentPath, conflictCode);
  if (parentAfterSync === null || !sameIdentity(before.parent, parentAfterSync)) {
    failExpected(context, conflictCode, parentPath);
  }
}

async function syncProvenLeaf(
  context,
  repoPath,
  plannedBytes,
  conflictCode,
  expectedLeaf
) {
  const proven = await inspectLeaf(
    context,
    repoPath,
    conflictCode,
    plannedBytes.length,
    true
  );
  if (proven === null || !proven.bytes.equals(plannedBytes) ||
      !sameFileFacts(expectedLeaf.facts, proven.facts) ||
      !sameIdentity(expectedLeaf.parent, proven.parent)) {
    failExpected(context, conflictCode, repoPath);
  }
  return proven;
}

async function createCompleteTemp(context, repoPath, bytes, conflictCode) {
  const parentPath = dirname(repoPath).split("\\").join("/");
  const parentIdentity = await inspectDirectory(context, parentPath, conflictCode);
  if (parentIdentity === null) failExpected(context, conflictCode, parentPath);
  let handle = null;
  let createdFacts = null;
  let primaryFailure = null;
  try {
    try {
      handle = await mutationFsCall(
        context,
        "open",
        repoPath,
        () => fs.promises.open(absolutePath(context, repoPath), CREATE_FLAGS, 0o600),
        conflictCode,
        repoPath,
        true
      );
    } catch (error) {
      throw mapFsFailure(context, error, "open", repoPath, conflictCode);
    }
    let offset = 0;
    while (offset < bytes.length) {
      const result = await mutationFsCall(
        context,
        "write",
        repoPath,
        () => handle.write(bytes, offset, bytes.length - offset, offset),
        null,
        repoPath,
        true
      );
      if (result.bytesWritten <= 0) failExpected(context, conflictCode, repoPath);
      offset += result.bytesWritten;
    }
    const stat = await fsCall(context, "fstat", repoPath, () => handle.stat());
    if (!stat.isFile() || !validLinkCount(stat) || stat.size !== bytes.length) {
      failExpected(context, conflictCode, repoPath);
    }
    createdFacts = fileFacts(stat);
    await mutationFsCall(context, "fsync", repoPath, () => handle.sync());
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (handle !== null) await closeHandle(context, handle, repoPath, primaryFailure);
  }
  if (primaryFailure !== null) throw primaryFailure;
  const leaf = await inspectLeaf(context, repoPath, conflictCode, bytes.length);
  const parentAfter = await inspectDirectory(context, parentPath, conflictCode);
  if (parentAfter === null || !sameIdentity(parentIdentity, parentAfter)) {
    failExpected(context, conflictCode, parentPath);
  }
  if (leaf === null || !leaf.bytes.equals(bytes) || createdFacts === null ||
      !sameFileFacts(createdFacts, leaf.facts)) {
    failExpected(context, conflictCode, repoPath);
  }
  return leaf;
}

async function ensureCompleteTemp(
  context,
  repoPath,
  bytes,
  conflictCode,
  expectation
) {
  const existing = await reproveLeafExpectation(
    context,
    repoPath,
    bytes,
    conflictCode,
    expectation
  );
  if (existing !== null) {
    const state = classifyPlannedBytes(existing.bytes, bytes);
    if (state === "invalid") failExpected(context, conflictCode, repoPath);
    if (state === "full") {
      return syncProvenLeaf(context, repoPath, bytes, conflictCode, existing);
    }
    await unlinkProvenLeaf(
      context,
      repoPath,
      bytes,
      conflictCode,
      existing.facts
    );
  }
  return createCompleteTemp(context, repoPath, bytes, conflictCode);
}

async function publishHardLink(
  context,
  sourcePath,
  destinationPath,
  bytes,
  conflictCode,
  sourceExpectation,
  destinationExpectation
) {
  const source = await reproveLeafExpectation(
    context,
    sourcePath,
    bytes,
    conflictCode,
    sourceExpectation
  );
  if (source === null || !source.bytes.equals(bytes)) {
    failExpected(context, conflictCode, sourcePath);
  }
  const sourceParentPath = dirname(sourcePath).split("\\").join("/");
  const destinationParentPath = dirname(destinationPath).split("\\").join("/");
  const destinationParent = await inspectDirectory(
    context,
    destinationParentPath,
    conflictCode
  );
  if (destinationParent === null) {
    failExpected(context, conflictCode, destinationParentPath);
  }
  if (await reproveLeafExpectation(
    context,
    destinationPath,
    bytes,
    conflictCode,
    destinationExpectation
  ) !== null) {
    failExpected(context, conflictCode, destinationPath);
  }
  await mutationFsCall(
    context,
    "link",
    destinationPath,
    () => fs.promises.link(
      absolutePath(context, sourcePath),
      absolutePath(context, destinationPath)
    ),
    conflictCode,
    destinationPath,
    true
  );
  const sourceAfter = await inspectLeaf(context, sourcePath, conflictCode, bytes.length);
  const destination = await inspectLeaf(
    context,
    destinationPath,
    conflictCode,
    bytes.length
  );
  if (sourceAfter === null || !sourceAfter.bytes.equals(bytes) ||
      !sameIdentity(source.facts, sourceAfter.facts)) {
    failExpected(context, conflictCode, sourcePath);
  }
  if (!sameIdentity(source.parent, sourceAfter.parent)) {
    failExpected(context, conflictCode, sourceParentPath);
  }
  if (destination === null || !destination.bytes.equals(bytes) ||
      !sameIdentity(source.facts, destination.facts)) {
    failExpected(context, conflictCode, destinationPath);
  }
  if (!sameIdentity(destinationParent, destination.parent)) {
    failExpected(context, conflictCode, destinationParentPath);
  }
  await syncDirectory(context, destinationParentPath, conflictCode);
  const sourceAfterSync = await inspectLeaf(context, sourcePath, conflictCode, bytes.length);
  const destinationAfterSync = await inspectLeaf(
    context,
    destinationPath,
    conflictCode,
    bytes.length
  );
  if (sourceAfterSync === null || !sourceAfterSync.bytes.equals(bytes) ||
      !sameIdentity(source.facts, sourceAfterSync.facts)) {
    failExpected(context, conflictCode, sourcePath);
  }
  if (!sameIdentity(source.parent, sourceAfterSync.parent)) {
    failExpected(context, conflictCode, sourceParentPath);
  }
  if (destinationAfterSync === null || !destinationAfterSync.bytes.equals(bytes) ||
      !sameIdentity(source.facts, destinationAfterSync.facts)) {
    failExpected(context, conflictCode, destinationPath);
  }
  if (!sameIdentity(destinationParent, destinationAfterSync.parent)) {
    failExpected(context, conflictCode, destinationParentPath);
  }
  await unlinkProvenLeaf(
    context,
    sourcePath,
    bytes,
    conflictCode,
    sourceAfterSync.facts
  );
  const destinationAfterCleanup = await inspectLeaf(
    context,
    destinationPath,
    conflictCode,
    bytes.length
  );
  if (destinationAfterCleanup === null || !destinationAfterCleanup.bytes.equals(bytes) ||
      !sameIdentity(sourceAfterSync.facts, destinationAfterCleanup.facts)) {
    failExpected(context, conflictCode, destinationPath);
  }
  if (!sameIdentity(destinationParent, destinationAfterCleanup.parent)) {
    failExpected(context, conflictCode, destinationParentPath);
  }
  return destinationAfterCleanup;
}

async function reproveExistingIntent(context, layout, state) {
  const current = await inspectLeaf(
    context,
    layout.intentPath,
    "STAGING_CONFLICT",
    layout.intentBytes.length
  );
  if (current === null || !current.bytes.equals(layout.intentBytes) ||
      !sameFileFacts(state.intentLeaf.facts, current.facts)) {
    failExpected(context, "STAGING_CONFLICT", layout.intentPath);
  }
  if (!sameIdentity(state.intentLeaf.parent, current.parent)) {
    failExpected(context, "STAGING_CONFLICT", layout.stagingPath);
  }
  if (state.stagingScan !== null) {
    proveScannedLeafParent(
      context,
      state.stagingScan,
      layout.intentPath,
      current,
      "STAGING_CONFLICT"
    );
    await reproveScannedDirectories(context, state.stagingScan, "STAGING_CONFLICT");
  }
  return current;
}

async function ensureIntent(context, layout, state) {
  const intentExpectation = state.stagingExpectations.get(layout.intentPath);
  const candidateExpectation = state.stagingExpectations.get(
    layout.intentCandidatePath
  );
  if (state.intentLeaf !== null) {
    const intent = await reproveExistingIntent(context, layout, state);
    const candidate = await reproveLeafExpectation(
      context,
      layout.intentCandidatePath,
      layout.intentBytes,
      "STAGING_CONFLICT",
      candidateExpectation
    );
    if (candidate !== null) {
      if (!candidate.bytes.equals(layout.intentBytes) ||
          !sameIdentity(intent.facts, candidate.facts) ||
          !sameIdentity(intent.parent, candidate.parent)) {
        failExpected(context, "STAGING_CONFLICT", layout.intentCandidatePath);
      }
      await syncDirectory(context, layout.stagingPath, "STAGING_CONFLICT");
      await unlinkProvenLeaf(
        context,
        layout.intentCandidatePath,
        layout.intentBytes,
        "STAGING_CONFLICT",
        candidate.facts
      );
      const retainedIntent = await inspectLeaf(
        context,
        layout.intentPath,
        "STAGING_CONFLICT",
        layout.intentBytes.length
      );
      if (retainedIntent === null || !retainedIntent.bytes.equals(layout.intentBytes) ||
          !sameIdentity(intent.facts, retainedIntent.facts)) {
        failExpected(context, "STAGING_CONFLICT", layout.intentPath);
      }
      if (!sameIdentity(intent.parent, retainedIntent.parent)) {
        failExpected(context, "STAGING_CONFLICT", layout.stagingPath);
      }
      return retainedIntent;
    }
    return intent;
  }
  if (await reproveLeafExpectation(
    context,
    layout.intentPath,
    layout.intentBytes,
    "STAGING_CONFLICT",
    intentExpectation
  ) !== null) {
    failExpected(context, "STAGING_CONFLICT", layout.intentPath);
  }
  const candidate = await ensureCompleteTemp(
    context,
    layout.intentCandidatePath,
    layout.intentBytes,
    "STAGING_CONFLICT",
    candidateExpectation
  );
  return publishHardLink(
    context,
    layout.intentCandidatePath,
    layout.intentPath,
    layout.intentBytes,
    "STAGING_CONFLICT",
    makePresentLeafExpectation(layout.intentCandidatePath, candidate),
    intentExpectation
  );
}

async function ensureStagingDirectories(context, layout) {
  rememberFixedAncestor(
    context,
    ".local",
    await ensureDirectory(context, ".local", "LOCAL_STATE_INVALID")
  );
  rememberFixedAncestor(
    context,
    ".local/tmp",
    await ensureDirectory(context, ".local/tmp", "LOCAL_STATE_INVALID")
  );
  await ensureDirectory(context, layout.stagingPath, "STAGING_CONFLICT");
}

async function ensureFinalDirectories(context, layout) {
  rememberFixedAncestor(
    context,
    ".local/cleaned",
    await ensureDirectory(context, ".local/cleaned", "LOCAL_STATE_INVALID")
  );
  rememberFixedAncestor(
    context,
    RUNS_ROOT,
    await ensureDirectory(context, RUNS_ROOT, "LOCAL_STATE_INVALID")
  );
  await ensureDirectory(context, layout.finalRunPath, "RUN_CONFLICT");
  const directories = requiredFinalDirectories(layout);
  directories.delete(layout.finalRunPath);
  for (const path of [...directories].sort(compareAscii)) {
    await ensureDirectory(context, path, "RUN_CONFLICT");
  }
}

async function stageArtifacts(context, layout, state) {
  const observations = [];
  for (const artifact of layout.artifactIntents) {
    const bytes = layout.artifactBytes.get(artifact.relative_path);
    const canonicalExpectation = state.canonicalExpectations.get(
      artifact.canonical_path
    );
    const tempExpectation = state.tempExpectations.get(artifact.temp_path);
    const canonical = await reproveLeafExpectation(
      context,
      artifact.canonical_path,
      bytes,
      "RUN_CONFLICT",
      canonicalExpectation
    );
    const temp = await reproveLeafExpectation(
      context,
      artifact.temp_path,
      bytes,
      "RUN_CONFLICT",
      tempExpectation
    );
    observations.push({
      artifact,
      bytes,
      canonicalExpectation,
      tempExpectation,
      canonical,
      temp
    });
  }
  if (state.finalScan !== null) {
    await reproveScannedDirectories(context, state.finalScan, "RUN_CONFLICT");
  }

  const missing = [];
  for (const observation of observations) {
    const {
      artifact,
      bytes,
      canonicalExpectation,
      tempExpectation
    } = observation;
    const canonical = await reproveLeafExpectation(
      context,
      artifact.canonical_path,
      bytes,
      "RUN_CONFLICT",
      canonicalExpectation
    );
    const temp = await reproveLeafExpectation(
      context,
      artifact.temp_path,
      bytes,
      "RUN_CONFLICT",
      tempExpectation
    );
    if (canonical !== null) {
      if (!canonical.bytes.equals(bytes)) {
        failExpected(context, "RUN_CONFLICT", artifact.canonical_path);
      }
      if (temp !== null) {
        if (classifyPlannedBytes(temp.bytes, bytes) === "invalid") {
          failExpected(context, "RUN_CONFLICT", artifact.temp_path);
        }
        await unlinkProvenLeaf(
          context,
          artifact.temp_path,
          bytes,
          "RUN_CONFLICT",
          temp.facts
        );
      }
      const retainedCanonical = await inspectLeaf(
        context,
        artifact.canonical_path,
        "RUN_CONFLICT",
        bytes.length
      );
      if (retainedCanonical === null || !retainedCanonical.bytes.equals(bytes) ||
          !sameIdentity(canonical.facts, retainedCanonical.facts) ||
          !sameIdentity(canonical.parent, retainedCanonical.parent)) {
        failExpected(context, "RUN_CONFLICT", artifact.canonical_path);
      }
      context.expectedFinalLeaves.set(
        artifact.canonical_path,
        retainedCanonical
      );
    } else {
      const completeTemp = await ensureCompleteTemp(
        context,
        artifact.temp_path,
        bytes,
        "RUN_CONFLICT",
        tempExpectation
      );
      missing.push({
        artifact,
        bytes,
        completeTemp,
        canonicalExpectation
      });
    }
  }

  for (const { artifact, bytes, completeTemp, canonicalExpectation } of missing) {
    const canonical = await publishHardLink(
      context,
      artifact.temp_path,
      artifact.canonical_path,
      bytes,
      "RUN_CONFLICT",
      makePresentLeafExpectation(artifact.temp_path, completeTemp),
      canonicalExpectation
    );
    context.expectedFinalLeaves.set(
      artifact.canonical_path,
      canonical
    );
  }
}

function proveExpectedFinalLeaf(context, repoPath, leaf, conflictCode) {
  const expected = context.expectedFinalLeaves.get(repoPath);
  if (expected === undefined || leaf === null ||
      !sameFileFacts(expected.facts, leaf.facts)) {
    failExpected(context, conflictCode, repoPath);
  }
  if (!sameIdentity(expected.parent, leaf.parent)) {
    failExpected(
      context,
      conflictCode,
      dirname(repoPath).split("\\").join("/")
    );
  }
}

async function verifyFinalState(context, layout) {
  const stagingScan = await scanTree(
    context,
    layout.stagingPath,
    "STAGING_CONFLICT",
    stagingExpectedKinds(layout)
  );
  const stagingEntries = entriesBeforeStructuralConflict(stagingScan);
  let intent = null;
  if (stagingEntries !== null) {
    for (const entry of stagingEntries) {
      if (entry.path !== layout.intentPath || entry.kind !== "file") {
        failExpected(context, "STAGING_CONFLICT", entry.path);
      }
      intent = await inspectLeaf(
        context,
        layout.intentPath,
        "STAGING_CONFLICT",
        layout.intentBytes.length
      );
      if (intent === null || !intent.bytes.equals(layout.intentBytes)) {
        failExpected(context, "STAGING_CONFLICT", layout.intentPath);
      }
      proveExpectedFinalLeaf(
        context,
        layout.intentPath,
        intent,
        "STAGING_CONFLICT"
      );
      proveScannedLeafParent(
        context,
        stagingScan,
        layout.intentPath,
        intent,
        "STAGING_CONFLICT"
      );
    }
  }
  await failDeferredStructuralConflict(context, stagingScan, "STAGING_CONFLICT");
  if (stagingEntries === null || stagingEntries.length !== 1 || intent === null) {
    failExpected(context, "STAGING_CONFLICT", layout.stagingPath);
  }

  const requiredDirectories = requiredFinalDirectories(layout);
  const canonicalPaths = new Set();
  for (const artifact of layout.artifactIntents) {
    canonicalPaths.add(artifact.canonical_path);
  }
  const finalScan = await scanTree(
    context,
    layout.finalRunPath,
    "RUN_CONFLICT",
    finalExpectedKinds(layout, requiredDirectories)
  );
  const entries = entriesBeforeStructuralConflict(finalScan);
  if (entries === null) failExpected(context, "RUN_CONFLICT", layout.finalRunPath);
  for (const entry of entries) {
    if (requiredDirectories.has(entry.path)) {
      if (entry.kind !== "directory") failExpected(context, "RUN_CONFLICT", entry.path);
    } else if (!canonicalPaths.has(entry.path) || entry.kind !== "file") {
      failExpected(context, "RUN_CONFLICT", entry.path);
    } else {
      const artifact = layout.artifactIntents.find((candidate) =>
        candidate.canonical_path === entry.path);
      const bytes = layout.artifactBytes.get(artifact.relative_path);
      const leaf = await inspectLeaf(
        context,
        entry.path,
        "RUN_CONFLICT",
        bytes.length
      );
      if (leaf === null || leaf.bytes.length !== artifact.size_bytes ||
          sha256(leaf.bytes) !== artifact.sha256 || !leaf.bytes.equals(bytes)) {
        failExpected(context, "RUN_CONFLICT", entry.path);
      }
      proveExpectedFinalLeaf(context, entry.path, leaf, "RUN_CONFLICT");
      proveScannedLeafParent(
        context,
        finalScan,
        entry.path,
        leaf,
        "RUN_CONFLICT"
      );
    }
  }
  await failDeferredStructuralConflict(context, finalScan, "RUN_CONFLICT");
  for (const artifact of layout.artifactIntents) {
    const bytes = layout.artifactBytes.get(artifact.relative_path);
    const leaf = await inspectLeaf(
      context,
      artifact.canonical_path,
      "RUN_CONFLICT",
      bytes.length
    );
    if (leaf === null || leaf.bytes.length !== artifact.size_bytes ||
        sha256(leaf.bytes) !== artifact.sha256 || !leaf.bytes.equals(bytes)) {
      failExpected(context, "RUN_CONFLICT", artifact.canonical_path);
    }
    proveExpectedFinalLeaf(
      context,
      artifact.canonical_path,
      leaf,
      "RUN_CONFLICT"
    );
    proveScannedLeafParent(
      context,
      finalScan,
      artifact.canonical_path,
      leaf,
      "RUN_CONFLICT"
    );
  }
  await syncDirectory(context, layout.stagingPath, "STAGING_CONFLICT");
  await syncDirectory(context, layout.finalRunPath, "RUN_CONFLICT");
  requiredDirectories.delete(layout.finalRunPath);
  for (const directory of [...requiredDirectories].sort(compareAscii)) {
    await syncDirectory(context, directory, "RUN_CONFLICT");
  }
  await reproveScannedDirectories(context, stagingScan, "STAGING_CONFLICT");
  await reproveScannedDirectories(context, finalScan, "RUN_CONFLICT");
}

function publicationRequiredDirectories(layout) {
  const directories = new Set([layout.finalRunPath]);
  for (const artifact of layout.artifactIntents) {
    let parent = dirname(artifact.canonical_path).split("\\").join("/");
    while (parent.startsWith(`${layout.finalRunPath}/`)) {
      directories.add(parent);
      parent = dirname(parent).split("\\").join("/");
    }
  }
  return directories;
}

function publicationExpectedKinds(layout, requiredDirectories) {
  const kinds = new Map();
  for (const path of requiredDirectories) {
    if (path !== layout.finalRunPath) kinds.set(path, "directory");
  }
  for (const artifact of layout.artifactIntents) {
    kinds.set(artifact.canonical_path, "file");
  }
  return kinds;
}

async function verifyImmutableRun(context) {
  const { layout } = context;
  const local = await inspectDirectory(context, ".local", "LOCAL_STATE_INVALID");
  if (local === null) failExpected(context, "RUN_CONFLICT", layout.finalRunPath);
  rememberFixedAncestor(context, ".local", local);
  const cleaned = await inspectDirectory(
    context,
    ".local/cleaned",
    "LOCAL_STATE_INVALID"
  );
  if (cleaned === null) failExpected(context, "RUN_CONFLICT", layout.finalRunPath);
  rememberFixedAncestor(context, ".local/cleaned", cleaned);
  const runs = await inspectDirectory(context, RUNS_ROOT, "LOCAL_STATE_INVALID");
  if (runs === null) failExpected(context, "RUN_CONFLICT", layout.finalRunPath);
  rememberFixedAncestor(context, RUNS_ROOT, runs);

  const requiredDirectories = publicationRequiredDirectories(layout);
  const scan = await scanTree(
    context,
    layout.finalRunPath,
    "RUN_CONFLICT",
    publicationExpectedKinds(layout, requiredDirectories)
  );
  if (scan === null) failExpected(context, "RUN_CONFLICT", layout.finalRunPath);
  await failDeferredStructuralConflict(context, scan, "RUN_CONFLICT");

  const expectedPaths = new Set([
    ...[...requiredDirectories].filter((path) => path !== layout.finalRunPath),
    ...layout.artifactIntents.map((artifact) => artifact.canonical_path)
  ]);
  const actualPaths = new Set(scan.entries.map(({ path }) => path));
  const difference = [...new Set([...expectedPaths, ...actualPaths])]
    .sort(compareAscii)
    .find((path) => expectedPaths.has(path) !== actualPaths.has(path));
  if (difference !== undefined) failExpected(context, "RUN_CONFLICT", difference);

  for (const directory of [...requiredDirectories].sort(compareAscii)) {
    const directoryIdentity = scan.directories.get(directory);
    if (directoryIdentity === undefined) {
      failExpected(context, "RUN_CONFLICT", directory);
    }
    rememberFixedAncestor(context, directory, directoryIdentity);
  }
  const verifiedLeaves = new Map();
  for (const artifact of layout.artifactIntents) {
    const leaf = await inspectLeaf(
      context,
      artifact.canonical_path,
      "RUN_CONFLICT",
      artifact.size_bytes
    );
    if (leaf === null || leaf.bytes.length !== artifact.size_bytes ||
        sha256(leaf.bytes) !== artifact.sha256) {
      failExpected(context, "RUN_CONFLICT", artifact.canonical_path);
    }
    proveScannedLeafParent(
      context,
      scan,
      artifact.canonical_path,
      leaf,
      "RUN_CONFLICT"
    );
    verifiedLeaves.set(artifact.canonical_path, leaf);
  }
  await reproveScannedDirectories(context, scan, "RUN_CONFLICT");
  context.verifiedRunLeaves = verifiedLeaves;
}

async function reproveVerifiedRun(context) {
  if (!(context.verifiedRunLeaves instanceof Map)) {
    failExpected(context, "RUN_CONFLICT", context.layout.finalRunPath);
  }
  const expectedLeaves = context.verifiedRunLeaves;
  await verifyImmutableRun(context);
  for (const artifact of context.layout.artifactIntents) {
    const expected = expectedLeaves.get(artifact.canonical_path);
    const current = context.verifiedRunLeaves.get(artifact.canonical_path);
    if (expected === undefined || current === null ||
        current === undefined ||
        current.bytes.length !== artifact.size_bytes ||
        sha256(current.bytes) !== artifact.sha256 ||
        !sameFileFacts(expected.facts, current.facts) ||
        !sameIdentity(expected.parent, current.parent)) {
      failExpected(context, "RUN_CONFLICT", artifact.canonical_path);
    }
  }
}

async function inspectPrivateLeaf(context, repoPath, maxBytes) {
  const leaf = await inspectLeaf(
    context,
    repoPath,
    "LOCAL_STATE_INVALID",
    maxBytes
  );
  if (leaf === null) return null;
  const stat = await maybeLstat(context, repoPath, "LOCAL_STATE_INVALID");
  const parentPath = dirname(repoPath).split("\\").join("/");
  const parent = await inspectDirectory(
    context,
    parentPath,
    "LOCAL_STATE_INVALID"
  );
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() ||
      (stat.mode & 0o7777) !== 0o600 ||
      !sameIdentity(leaf.facts, identity(stat)) || parent === null ||
      !sameIdentity(leaf.parent, parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
  return leaf;
}

async function createPrivateTemp(context, repoPath, bytes) {
  const created = await createCompleteTemp(
    context,
    repoPath,
    bytes,
    "LOCAL_STATE_INVALID"
  );
  const proven = await inspectPrivateLeaf(context, repoPath, bytes.length);
  if (proven === null || !proven.bytes.equals(bytes) ||
      !sameIdentity(created.facts, proven.facts)) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
  return proven;
}

async function directMutation(
  context,
  operation,
  repoPath,
  finalProof,
  action
) {
  await reproveFixedAncestors(context);
  if (typeof context.mutationAuthority === "function") {
    await context.mutationAuthority();
  }
  await finalProof();
  try {
    const result = await action();
    context.persistentWritesOccurred = true;
    return result;
  } catch (error) {
    failIo(context, operation, repoPath);
  }
}

async function tryNoClobberLink(
  context,
  sourcePath,
  destinationPath,
  bytes,
  expectedSource,
  ownershipLock = null,
  beforeLinkProof = null
) {
  await reproveFixedAncestors(context);
  await reprovePrivateLeaf(
    context,
    sourcePath,
    bytes,
    expectedSource
  );
  if (ownershipLock !== null) {
    await reproveOwnedCommitLock(context, ownershipLock);
  }
  if (typeof context.mutationAuthority === "function") {
    await context.mutationAuthority();
  }
  if (beforeLinkProof !== null) await beforeLinkProof(expectedSource);
  try {
    await fs.promises.link(
      absolutePath(context, sourcePath),
      absolutePath(context, destinationPath)
    );
    context.persistentWritesOccurred = true;
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    failIo(context, "link", destinationPath);
  }
}

async function unlinkPrivateLeaf(
  context,
  repoPath,
  bytes,
  expectedIdentity,
  ownershipLock = null
) {
  await directMutation(
    context,
    "unlink",
    repoPath,
    async () => {
      const before = await inspectPrivateLeaf(
        context,
        repoPath,
        bytes.length
      );
      if (before === null || !before.bytes.equals(bytes) ||
          !sameIdentity(expectedIdentity, before.facts)) {
        failExpected(context, "LOCAL_STATE_INVALID", repoPath);
      }
      if (ownershipLock !== null) {
        await reproveOwnedCommitLock(context, ownershipLock);
      }
    },
    () => fs.promises.unlink(absolutePath(context, repoPath))
  );
  if (await maybeLstat(context, repoPath, "LOCAL_STATE_INVALID") !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
}

async function finishNoClobberPublication(
  context,
  sourcePath,
  destinationPath,
  bytes,
  source,
  parentPath,
  ownershipLock = null,
  postLinkProof = null
) {
  await syncDirectory(context, parentPath, "LOCAL_STATE_INVALID");
  const sourceAfter = await inspectPrivateLeaf(context, sourcePath, bytes.length);
  const destination = await inspectPrivateLeaf(
    context,
    destinationPath,
    bytes.length
  );
  if (sourceAfter === null || destination === null ||
      !sourceAfter.bytes.equals(bytes) || !destination.bytes.equals(bytes) ||
      !sameIdentity(source.facts, sourceAfter.facts) ||
      !sameIdentity(source.facts, destination.facts)) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  if (postLinkProof !== null) {
    await postLinkProof(sourceAfter, destination);
  }
  await unlinkPrivateLeaf(
    context,
    sourcePath,
    bytes,
    sourceAfter.facts,
    ownershipLock
  );
  const retained = await inspectPrivateLeaf(context, destinationPath, bytes.length);
  if (retained === null || !retained.bytes.equals(bytes) ||
      !sameIdentity(destination.facts, retained.facts)) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  await syncDirectory(context, parentPath, "LOCAL_STATE_INVALID");
  return inspectPrivateLeaf(context, destinationPath, bytes.length);
}

async function publishFreshNoClobberFile(
  context,
  candidatePath,
  destinationPath,
  bytes,
  parentPath,
  ownershipLock = null,
  beforeLinkProof = null,
  postLinkProof = null
) {
  const candidate = await createPrivateTemp(context, candidatePath, bytes);
  const linked = await tryNoClobberLink(
    context,
    candidatePath,
    destinationPath,
    bytes,
    candidate,
    ownershipLock,
    beforeLinkProof
  );
  if (!linked) return { linked: false, candidate };
  return {
    linked: true,
    leaf: await finishNoClobberPublication(
      context,
      candidatePath,
      destinationPath,
      bytes,
      candidate,
      parentPath,
      ownershipLock,
      postLinkProof
    )
  };
}

async function ensurePublicationDirectories(context) {
  await ensurePrivatePublicationDirectory(context, STATE_DIRECTORY);
  await ensurePrivatePublicationDirectory(context, TRANSITIONS_DIRECTORY);
}

async function provePrivatePublicationDirectory(context, repoPath) {
  const proven = await inspectDirectory(context, repoPath, "LOCAL_STATE_INVALID");
  const stat = await maybeLstat(context, repoPath, "LOCAL_STATE_INVALID");
  if (proven === null || stat === null || !stat.isDirectory() ||
      stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700 ||
      !sameIdentity(proven, identity(stat))) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
  rememberFixedAncestor(context, repoPath, proven);
  context.privateDirectoryProofs.add(repoPath);
  return proven;
}

async function ensurePrivatePublicationDirectory(context, repoPath) {
  await ensureDirectory(context, repoPath, "LOCAL_STATE_INVALID");
  return provePrivatePublicationDirectory(context, repoPath);
}

async function failIfCommitLockAlreadyExists(context) {
  const state = await inspectDirectory(
    context,
    STATE_DIRECTORY,
    "LOCAL_STATE_INVALID"
  );
  if (state === null) return;
  await provePrivatePublicationDirectory(context, STATE_DIRECTORY);
  const existing = await maybeLstat(
    context,
    COMMIT_LOCK_PATH,
    "LOCAL_STATE_INVALID"
  );
  if (existing === null) return;
  const leaf = await inspectPrivateLeaf(
    context,
    COMMIT_LOCK_PATH,
    MAX_COMMIT_LOCK_BYTES
  );
  if (leaf === null || validateCommitLockBytes(leaf.bytes) === null) {
    failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
  }
  failExpected(context, "CLEANING_COMMIT_LOCKED", COMMIT_LOCK_PATH);
}

function makeCommitLock(context) {
  const ownerPid = process.pid;
  const ownerNonce = randomBytes(16).toString("hex");
  const intent = {
    schema_version: SCHEMA_VERSION,
    owner_pid: ownerPid,
    owner_nonce: ownerNonce,
    plan_manifest: canonicalClone(context.layout.manifest),
    plan_manifest_sha256: context.layout.planManifestSha256,
    expected_prior_pointer_sha256:
      context.layout.manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: context.layout.manifest.desired_pointer_sha256,
    desired_pointer: canonicalClone(context.layout.manifest.desired_pointer),
    run_sha256: context.layout.runSha256
  };
  const bytes = canonicalJsonDocumentBytes(intent);
  return {
    ownerPid,
    ownerNonce,
    intent,
    bytes,
    sha256: sha256(bytes),
    candidatePath: `${STATE_DIRECTORY}/.cleaning-commit.${ownerPid}.${ownerNonce}.tmp`
  };
}

async function acquireCommitLock(context) {
  const existing = await maybeLstat(
    context,
    COMMIT_LOCK_PATH,
    "LOCAL_STATE_INVALID"
  );
  if (existing !== null) {
    const leaf = await inspectPrivateLeaf(
      context,
      COMMIT_LOCK_PATH,
      MAX_COMMIT_LOCK_BYTES
    );
    if (leaf === null || validateCommitLockBytes(leaf.bytes) === null) {
      failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
    }
    failExpected(context, "CLEANING_COMMIT_LOCKED", COMMIT_LOCK_PATH);
  }

  const lock = makeCommitLock(context);
  const publication = await publishFreshNoClobberFile(
    context,
    lock.candidatePath,
    COMMIT_LOCK_PATH,
    lock.bytes,
    STATE_DIRECTORY
  );
  if (!publication.linked) {
    const fixed = await inspectPrivateLeaf(
      context,
      COMMIT_LOCK_PATH,
      MAX_COMMIT_LOCK_BYTES
    );
    if (fixed !== null && sameIdentity(publication.candidate.facts, fixed.facts) &&
        fixed.bytes.equals(lock.bytes)) {
      lock.leaf = await finishNoClobberPublication(
        context,
        lock.candidatePath,
        COMMIT_LOCK_PATH,
        lock.bytes,
        publication.candidate,
        STATE_DIRECTORY
      );
      return lock;
    }
    const validCompetingLock = fixed !== null &&
      validateCommitLockBytes(fixed.bytes) !== null;
    await unlinkPrivateLeaf(
      context,
      lock.candidatePath,
      lock.bytes,
      publication.candidate.facts
    );
    await syncDirectory(context, STATE_DIRECTORY, "LOCAL_STATE_INVALID");
    if (!validCompetingLock) {
      failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
    }
    failExpected(context, "CLEANING_COMMIT_LOCKED", COMMIT_LOCK_PATH);
  }
  lock.leaf = publication.leaf;
  return lock;
}

async function reproveOwnedCommitLock(context, lock) {
  const current = await inspectPrivateLeaf(
    context,
    COMMIT_LOCK_PATH,
    lock.bytes.length
  );
  if (current === null || !current.bytes.equals(lock.bytes) ||
      !sameIdentity(lock.leaf.facts, current.facts)) {
    failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
  }
  return current;
}

async function reprovePrivateLeaf(
  context,
  repoPath,
  bytes,
  expectedLeaf
) {
  const current = await inspectPrivateLeaf(context, repoPath, bytes.length);
  if (current === null || !current.bytes.equals(bytes) ||
      !sameFileFacts(expectedLeaf.facts, current.facts) ||
      !sameIdentity(expectedLeaf.parent, current.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
  return current;
}

async function readPointerLeaf(context) {
  const leaf = await inspectPrivateLeaf(context, CURRENT_POINTER, MAX_POINTER_BYTES);
  if (leaf === null) return null;
  const pointer = parseCanonicalDocumentBytes(leaf.bytes);
  if (pointer === null || !isValidCleaningPointerValue(pointer)) {
    failExpected(context, "LOCAL_STATE_INVALID", CURRENT_POINTER);
  }
  return leaf;
}

function pointerKind(layout, pointerLeaf) {
  if (pointerLeaf === null) {
    return layout.expectedPriorPointerBytes === null ? "expected_prior" : "stale";
  }
  if (layout.expectedPriorPointerBytes !== null &&
      pointerLeaf.bytes.equals(layout.expectedPriorPointerBytes)) {
    return "expected_prior";
  }
  if (pointerLeaf.bytes.equals(layout.desiredPointerBytes)) return "desired";
  return "stale";
}

async function reprovePointerLeaf(context, expectedLeaf) {
  const current = await readPointerLeaf(context);
  if (expectedLeaf === null) {
    if (current !== null) failExpected(context, "STALE_POINTER_TRANSITION", CURRENT_POINTER);
    return null;
  }
  if (current === null || !current.bytes.equals(expectedLeaf.bytes)) {
    failExpected(context, "STALE_POINTER_TRANSITION", CURRENT_POINTER);
  }
  if (!sameFileFacts(current.facts, expectedLeaf.facts) ||
      !sameIdentity(current.parent, expectedLeaf.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", CURRENT_POINTER);
  }
  return current;
}

async function publishPointer(context, lock, expectedPointerLeaf) {
  const tempPath = `${STATE_DIRECTORY}/.current-cleaning.${lock.ownerPid}.${lock.ownerNonce}.tmp`;
  const candidate = await createPrivateTemp(
    context,
    tempPath,
    context.layout.desiredPointerBytes
  );
  await directMutation(
    context,
    "rename",
    CURRENT_POINTER,
    async () => {
      await reproveVerifiedRun(context);
      await reprovePointerLeaf(context, expectedPointerLeaf);
      await reprovePrivateLeaf(
        context,
        tempPath,
        context.layout.desiredPointerBytes,
        candidate
      );
      await reproveOwnedCommitLock(context, lock);
    },
    () => fs.promises.rename(
      absolutePath(context, tempPath),
      absolutePath(context, CURRENT_POINTER)
    )
  );
  const pointer = await inspectPrivateLeaf(
    context,
    CURRENT_POINTER,
    context.layout.desiredPointerBytes.length
  );
  if (pointer === null || !pointer.bytes.equals(context.layout.desiredPointerBytes) ||
      !sameIdentity(candidate.facts, pointer.facts) ||
      await maybeLstat(context, tempPath, "LOCAL_STATE_INVALID") !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", CURRENT_POINTER);
  }
  await syncDirectory(context, STATE_DIRECTORY, "LOCAL_STATE_INVALID");
  return pointer;
}

function completionRecord(layout, commitLockSha256) {
  return {
    schema_version: SCHEMA_VERSION,
    record_kind: "completion",
    commit_lock_sha256: commitLockSha256,
    plan_manifest_sha256: layout.planManifestSha256,
    expected_prior_pointer_sha256:
      layout.manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: layout.manifest.desired_pointer_sha256,
    desired_pointer: canonicalClone(layout.manifest.desired_pointer)
  };
}

function retirementRecord(
  layout,
  commitLockSha256,
  observedPointerSha256
) {
  return {
    schema_version: SCHEMA_VERSION,
    record_kind: "retirement",
    plan_manifest_sha256: layout.planManifestSha256,
    commit_lock_sha256: commitLockSha256,
    expected_prior_pointer_sha256:
      layout.manifest.expected_prior_pointer_sha256,
    desired_pointer_sha256: layout.manifest.desired_pointer_sha256,
    observed_pointer_sha256: observedPointerSha256,
    reason: "stale_pointer"
  };
}

async function publishTerminalRecord(context, lock, record, destinationPath) {
  await reproveOwnedCommitLock(context, lock);
  const bytes = canonicalJsonDocumentBytes(record);
  const existing = await maybeLstat(
    context,
    destinationPath,
    "LOCAL_STATE_INVALID"
  );
  if (existing !== null) {
    const leaf = await inspectPrivateLeaf(context, destinationPath, bytes.length);
    if (leaf === null || !leaf.bytes.equals(bytes)) {
      failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
    }
    await syncDirectory(context, TRANSITIONS_DIRECTORY, "LOCAL_STATE_INVALID");
    return {
      path: destinationPath,
      bytes,
      leaf: await reprovePrivateLeaf(context, destinationPath, bytes, leaf)
    };
  }
  const name = destinationPath.slice(destinationPath.lastIndexOf("/") + 1);
  const candidatePath = `${TRANSITIONS_DIRECTORY}/.${name}.${lock.ownerPid}.${lock.ownerNonce}.tmp`;
  const publication = await publishFreshNoClobberFile(
    context,
    candidatePath,
    destinationPath,
    bytes,
    TRANSITIONS_DIRECTORY,
    lock
  );
  if (publication.linked) {
    return {
      path: destinationPath,
      bytes,
      leaf: publication.leaf
    };
  }

  const destination = await inspectPrivateLeaf(context, destinationPath, bytes.length);
  if (destination === null || !destination.bytes.equals(bytes)) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  await unlinkPrivateLeaf(
    context,
    candidatePath,
    bytes,
    publication.candidate.facts,
    lock
  );
  await syncDirectory(context, TRANSITIONS_DIRECTORY, "LOCAL_STATE_INVALID");
  return {
    path: destinationPath,
    bytes,
    leaf: await reprovePrivateLeaf(context, destinationPath, bytes, destination)
  };
}

async function releaseCommitLock(context, lock, terminal) {
  await directMutation(
    context,
    "unlink",
    COMMIT_LOCK_PATH,
    async () => {
      await reprovePrivateLeaf(
        context,
        terminal.path,
        terminal.bytes,
        terminal.leaf
      );
      await reproveOwnedCommitLock(context, lock);
    },
    () => fs.promises.unlink(absolutePath(context, COMMIT_LOCK_PATH))
  );
  if (await maybeLstat(
    context,
    COMMIT_LOCK_PATH,
    "LOCAL_STATE_INVALID"
  ) !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
  }
  await syncDirectory(context, STATE_DIRECTORY, "LOCAL_STATE_INVALID");
}

function publicationSuccessResult(context, kind) {
  return deepFreeze({
    ok: true,
    value: {
      kind,
      plan_manifest_sha256: context.layout.planManifestSha256,
      run_sha256: context.layout.runSha256,
      desired_pointer: canonicalClone(context.layout.manifest.desired_pointer),
      registered_source_count: context.layout.manifest.registered_source_count,
      persistent_writes_occurred: context.persistentWritesOccurred
    }
  });
}

async function runPublish(context) {
  try {
    await verifyImmutableRun(context);
    await failIfCommitLockAlreadyExists(context);
    await ensurePublicationDirectories(context);
    const lock = await acquireCommitLock(context);
    const pointerBefore = await readPointerLeaf(context);
    const kind = pointerKind(context.layout, pointerBefore);
    if (kind === "stale") {
      await reproveOwnedCommitLock(context, lock);
      await reprovePointerLeaf(context, pointerBefore);
      const retirement = retirementRecord(
        context.layout,
        lock.sha256,
        pointerBefore === null ? null : sha256(pointerBefore.bytes)
      );
      const observedSuffix = retirement.observed_pointer_sha256 ?? "absent";
      const retirementPath = `${TRANSITIONS_DIRECTORY}/retire-${lock.sha256}-${observedSuffix}.json`;
      const terminal = await publishTerminalRecord(
        context,
        lock,
        retirement,
        retirementPath
      );
      await reprovePointerLeaf(context, pointerBefore);
      await releaseCommitLock(context, lock, terminal);
      return expectedResult(
        "STALE_POINTER_TRANSITION",
        CURRENT_POINTER,
        context.persistentWritesOccurred
      );
    }

    await verifyImmutableRun(context);
    const desiredPointerLeaf = kind === "expected_prior"
      ? await publishPointer(context, lock, pointerBefore)
      : pointerBefore;
    const completion = completionRecord(context.layout, lock.sha256);
    const completionPath = `${TRANSITIONS_DIRECTORY}/complete-${lock.sha256}-${context.layout.manifest.desired_pointer_sha256}.json`;
    const terminal = await publishTerminalRecord(
      context,
      lock,
      completion,
      completionPath
    );
    await reproveVerifiedRun(context);
    await reprovePointerLeaf(context, desiredPointerLeaf);
    await releaseCommitLock(context, lock, terminal);
    return publicationSuccessResult(
      context,
      kind === "desired" ? "already_current" : "published"
    );
  } catch (error) {
    if (error instanceof StageFailure) return error.result;
    throw error;
  }
}

function recoverySuccessResult(context) {
  return deepFreeze({
    ok: true,
    value: {
      kind: "no_unresolved_target",
      selected_target_commit_lock_sha256: null,
      current_fixed_commit_lock_sha256: null,
      active_lease_path: null,
      final_pointer: null,
      transition_record_path: null,
      commit_lock_cleanup: "already_absent",
      persistent_writes_occurred: context.persistentWritesOccurred
    }
  });
}

async function readRecoveryFixedLock(context) {
  const leaf = await inspectPrivateLeaf(
    context,
    COMMIT_LOCK_PATH,
    MAX_COMMIT_LOCK_BYTES
  );
  if (leaf === null) return null;
  const validated = validateCommitLockBytes(leaf.bytes);
  if (validated === null) {
    failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
  }
  return {
    ...validated,
    bytes: leaf.bytes,
    sha256: sha256(leaf.bytes),
    leaf
  };
}

async function reproveRecoveryFixedLock(context, fixed) {
  return reprovePrivateLeaf(
    context,
    COMMIT_LOCK_PATH,
    fixed.bytes,
    fixed.leaf
  );
}

function originalRecoveryOwnerIsAlive(context, ownerPid) {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
  }
}

function parseRecoveryOwnerPid(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const ownerPid = Number(value);
  return Number.isSafeInteger(ownerPid) && ownerPid > 0 &&
    String(ownerPid) === value ? ownerPid : null;
}

function decodeStrictBase64(value) {
  if (typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    return null;
  }
  return bytes.toString("base64") === value ? bytes : null;
}

function makeRecoveryTargetDocumentBytes(lockBytes) {
  return canonicalJsonDocumentBytes({
    schema_version: SCHEMA_VERSION,
    record_kind: "recovery_target",
    target_commit_lock_sha256: sha256(lockBytes),
    target_commit_lock_bytes_base64: lockBytes.toString("base64")
  });
}

function validateRecoveryTargetDocument(
  bytes,
  directoryCommitLockSha256,
  currentFixedBytes = null
) {
  const value = parseCanonicalDocumentBytes(bytes);
  const fields = ownDataFields(value, RECOVERY_TARGET_KEYS);
  if (fields === null || fields.schema_version !== SCHEMA_VERSION ||
      fields.record_kind !== "recovery_target" ||
      !isSha256(fields.target_commit_lock_sha256)) return null;
  const lockBytes = decodeStrictBase64(
    fields.target_commit_lock_bytes_base64
  );
  if (lockBytes === null || lockBytes.length > MAX_COMMIT_LOCK_BYTES ||
      sha256(lockBytes) !== fields.target_commit_lock_sha256 ||
      fields.target_commit_lock_sha256 !== directoryCommitLockSha256 ||
      (currentFixedBytes !== null && !lockBytes.equals(currentFixedBytes))) {
    return null;
  }
  const validatedLock = validateCommitLockBytes(lockBytes);
  if (validatedLock === null) return null;
  return {
    value,
    bytes,
    lockBytes,
    validatedLock
  };
}

function makeRecoveryLeaseDocumentBytes({
  targetCommitLockSha256,
  previousLeaseSha256,
  generation,
  ownerPid,
  ownerNonce
}) {
  return canonicalJsonDocumentBytes({
    schema_version: SCHEMA_VERSION,
    record_kind: "recovery_lease",
    target_commit_lock_sha256: targetCommitLockSha256,
    previous_lease_sha256: previousLeaseSha256,
    generation,
    owner_pid: ownerPid,
    owner_nonce: ownerNonce
  });
}

function validateRecoveryLeaseDocument(bytes, targetCommitLockSha256) {
  const value = parseCanonicalDocumentBytes(bytes);
  const fields = ownDataFields(value, RECOVERY_LEASE_KEYS);
  if (fields === null || fields.schema_version !== SCHEMA_VERSION ||
      fields.record_kind !== "recovery_lease" ||
      fields.target_commit_lock_sha256 !== targetCommitLockSha256 ||
      !(fields.previous_lease_sha256 === null ||
        isSha256(fields.previous_lease_sha256)) ||
      !isNonNegativeInteger(fields.generation) ||
      !Number.isSafeInteger(fields.owner_pid) || fields.owner_pid <= 0 ||
      typeof fields.owner_nonce !== "string" ||
      !/^[0-9a-f]{32}$/.test(fields.owner_nonce)) return null;
  return {
    value: fields,
    bytes,
    sha256: sha256(bytes)
  };
}

async function readRecoveryPrivateLeaf(
  context,
  scan,
  targetPath,
  targetIdentity,
  repoPath,
  maxBytes
) {
  const leaf = await inspectPrivateLeaf(context, repoPath, maxBytes);
  if (leaf === null) failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  if (!sameIdentity(targetIdentity, leaf.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", targetPath);
  }
  scan.leaves.set(repoPath, { bytes: leaf.bytes, leaf });
  return leaf;
}

function firstRecoveryNameDifference(expectedNames, actualNames) {
  const expected = new Set(expectedNames);
  const actual = new Set(actualNames);
  return [...new Set([...expectedNames, ...actualNames])]
    .sort(compareAscii)
    .find((name) => expected.has(name) !== actual.has(name)) ?? null;
}

async function reproveRecoveryScan(context, scan) {
  for (const repoPath of [...scan.absentPaths].sort(compareAscii)) {
    if (await maybeLstat(
      context,
      repoPath,
      "LOCAL_STATE_INVALID"
    ) !== null) {
      failExpected(context, "LOCAL_STATE_INVALID", repoPath);
    }
  }
  for (const [repoPath, proof] of [...scan.directories.entries()]
    .sort(([left], [right]) => compareAscii(left, right))) {
    const currentIdentity = await provePrivatePublicationDirectory(
      context,
      repoPath
    );
    if (!sameIdentity(proof.identity, currentIdentity)) {
      failExpected(context, "LOCAL_STATE_INVALID", repoPath);
    }
    const currentNames = await readDirectoryNames(
      context,
      repoPath,
      "LOCAL_STATE_INVALID",
      proof.identity
    );
    if (currentNames === null) {
      failExpected(context, "LOCAL_STATE_INVALID", repoPath);
    }
    const difference = firstRecoveryNameDifference(proof.names, currentNames);
    if (difference !== null) {
      failExpected(context, "LOCAL_STATE_INVALID", `${repoPath}/${difference}`);
    }
  }
  for (const [repoPath, proof] of [...scan.leaves.entries()]
    .sort(([left], [right]) => compareAscii(left, right))) {
    await reprovePrivateLeaf(context, repoPath, proof.bytes, proof.leaf);
  }
  for (const [repoPath, proof] of [...scan.directories.entries()]
    .sort(([left], [right]) => compareAscii(left, right))) {
    const currentIdentity = await provePrivatePublicationDirectory(
      context,
      repoPath
    );
    if (!sameIdentity(proof.identity, currentIdentity)) {
      failExpected(context, "LOCAL_STATE_INVALID", repoPath);
    }
  }
}

async function scanRecoveryTerminalOutcome(
  context,
  scan,
  targetPath,
  targetCommitLockSha256,
  layout
) {
  if (scan.transitionSnapshot === null) {
    const transitionStat = await maybeLstat(
      context,
      TRANSITIONS_DIRECTORY,
      "LOCAL_STATE_INVALID"
    );
    if (transitionStat === null) {
      scan.absentPaths.add(TRANSITIONS_DIRECTORY);
      scan.transitionSnapshot = { present: false };
    } else {
      const identity = await provePrivatePublicationDirectory(
        context,
        TRANSITIONS_DIRECTORY
      );
      const names = await readDirectoryNames(
        context,
        TRANSITIONS_DIRECTORY,
        "LOCAL_STATE_INVALID",
        identity
      );
      if (names === null) {
        failExpected(context, "LOCAL_STATE_INVALID", TRANSITIONS_DIRECTORY);
      }
      scan.directories.set(TRANSITIONS_DIRECTORY, { identity, names });
      scan.transitionSnapshot = { present: true, identity, names };
    }
  } else {
    await reproveRecoveryScan(context, scan);
  }

  if (!scan.transitionSnapshot.present) return "absent";
  const transitionIdentity = scan.transitionSnapshot.identity;
  const transitionNames = scan.transitionSnapshot.names;

  const completionPrefix = `complete-${targetCommitLockSha256}-`;
  const retirementPrefix = `retire-${targetCommitLockSha256}-`;
  const cBoundNames = transitionNames.filter((name) =>
    name.startsWith(completionPrefix) || name.startsWith(retirementPrefix));
  if (cBoundNames.length === 0) return "absent";

  let allExact = true;
  for (const name of cBoundNames) {
    const repoPath = `${TRANSITIONS_DIRECTORY}/${name}`;
    const leaf = await inspectPrivateLeaf(
      context,
      repoPath,
      MAX_TRANSITION_RECORD_BYTES
    );
    if (leaf === null || !sameIdentity(transitionIdentity, leaf.parent)) {
      failExpected(context, "LOCAL_STATE_INVALID", repoPath);
    }
    scan.leaves.set(repoPath, { bytes: leaf.bytes, leaf });

    let expectedBytes = null;
    if (name.startsWith(completionPrefix)) {
      const expectedName =
        `${completionPrefix}${layout.manifest.desired_pointer_sha256}.json`;
      if (name === expectedName) {
        expectedBytes = canonicalJsonDocumentBytes(
          completionRecord(layout, targetCommitLockSha256)
        );
      }
    } else {
      const suffix = name.slice(
        retirementPrefix.length,
        -".json".length
      );
      if (name.endsWith(".json") &&
          (suffix === "absent" || isSha256(suffix))) {
        expectedBytes = canonicalJsonDocumentBytes(
          retirementRecord(
            layout,
            targetCommitLockSha256,
            suffix === "absent" ? null : suffix
          )
        );
      }
    }
    if (expectedBytes === null || !leaf.bytes.equals(expectedBytes)) {
      allExact = false;
    }
  }

  if (cBoundNames.length !== 1 || !allExact) {
    failExpected(context, "RECOVERY_TARGET_AMBIGUOUS", targetPath);
  }
  return "exact";
}

async function validateRecoveryLeaseCandidates(
  context,
  scan,
  targetPath,
  targetIdentity,
  targetCommitLockSha256,
  candidates,
  canonicalLeasesByHash
) {
  for (const candidate of candidates) {
    const leaf = await readRecoveryPrivateLeaf(
      context,
      scan,
      targetPath,
      targetIdentity,
      candidate.path,
      MAX_RECOVERY_LEASE_BYTES
    );
    let previousLeaseSha256 = null;
    let generation = 0;
    if (candidate.anchor !== "root") {
      const parent = canonicalLeasesByHash.get(candidate.anchor);
      if (parent === undefined) {
        failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
      }
      previousLeaseSha256 = candidate.anchor;
      generation = parent.value.generation + 1;
    }
    const expectedBytes = makeRecoveryLeaseDocumentBytes({
      targetCommitLockSha256,
      previousLeaseSha256,
      generation,
      ownerPid: candidate.ownerPid,
      ownerNonce: candidate.ownerNonce
    });
    if (classifyPlannedBytes(leaf.bytes, expectedBytes) === "invalid") {
      failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
    }
    candidate.leaf = leaf;
    candidate.expectedBytes = expectedBytes;
    candidate.nodePath = candidate.anchor === "root"
      ? `${targetPath}/lease-root.json`
      : `${targetPath}/lease-after-${candidate.anchor}.json`;
  }
}

async function scanRecoveryTargetDirectory(
  context,
  scan,
  targetCommitLockSha256,
  targetPath,
  targetIdentity,
  names,
  currentFixed
) {
  let targetEntry = null;
  let rootEntry = null;
  const targetCandidates = [];
  const childEntries = [];
  const leaseCandidates = [];

  for (const name of names) {
    const path = `${targetPath}/${name}`;
    if (name === "target.json") {
      targetEntry = { name, path };
      continue;
    }
    if (name === "lease-root.json") {
      rootEntry = { name, path };
      continue;
    }
    const targetCandidateMatch = RECOVERY_TARGET_CANDIDATE_RE.exec(name);
    if (targetCandidateMatch !== null) {
      const ownerPid = parseRecoveryOwnerPid(targetCandidateMatch[1]);
      if (ownerPid === null) {
        failExpected(context, "LOCAL_STATE_INVALID", path);
      }
      targetCandidates.push({ path, ownerPid, ownerNonce: targetCandidateMatch[2] });
      continue;
    }
    const childMatch = RECOVERY_LEASE_CHILD_RE.exec(name);
    if (childMatch !== null) {
      childEntries.push({ name, path, anchor: childMatch[1] });
      continue;
    }
    const leaseCandidateMatch = RECOVERY_LEASE_CANDIDATE_RE.exec(name);
    if (leaseCandidateMatch !== null) {
      const ownerPid = parseRecoveryOwnerPid(leaseCandidateMatch[2]);
      if (ownerPid === null) {
        failExpected(context, "LOCAL_STATE_INVALID", path);
      }
      leaseCandidates.push({
        path,
        anchor: leaseCandidateMatch[1],
        ownerPid,
        ownerNonce: leaseCandidateMatch[3]
      });
      continue;
    }
    failExpected(context, "LOCAL_STATE_INVALID", path);
  }

  let target = null;
  let expectedTargetBytes = currentFixed === null
    ? null
    : makeRecoveryTargetDocumentBytes(currentFixed.bytes);
  if (targetEntry !== null) {
    const leaf = await readRecoveryPrivateLeaf(
      context,
      scan,
      targetPath,
      targetIdentity,
      targetEntry.path,
      MAX_RECOVERY_TARGET_BYTES
    );
    target = validateRecoveryTargetDocument(
      leaf.bytes,
      targetCommitLockSha256,
      currentFixed?.bytes ?? null
    );
    if (target === null) {
      failExpected(context, "LOCAL_STATE_INVALID", targetEntry.path);
    }
    target.path = targetEntry.path;
    target.leaf = leaf;
    expectedTargetBytes = target.bytes;
  }

  for (const candidate of targetCandidates) {
    const leaf = await readRecoveryPrivateLeaf(
      context,
      scan,
      targetPath,
      targetIdentity,
      candidate.path,
      expectedTargetBytes?.length ?? MAX_RECOVERY_TARGET_BYTES
    );
    if (expectedTargetBytes !== null &&
        classifyPlannedBytes(leaf.bytes, expectedTargetBytes) === "invalid") {
      failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
    }
    candidate.leaf = leaf;
    candidate.expectedBytes = expectedTargetBytes;
    candidate.nodePath = `${targetPath}/target.json`;
  }

  if (target === null) {
    if (rootEntry !== null || childEntries.length > 0) {
      failExpected(context, "LOCAL_STATE_INVALID", targetPath);
    }
    if (leaseCandidates.length > 0) {
      failExpected(context, "LOCAL_STATE_INVALID", leaseCandidates[0].path);
    }
    return {
      target: null,
      targetIdentity,
      targetCandidates,
      leaseCandidates,
      rootPresent: false,
      rootLease: null,
      leaseChain: [],
      tip: null
    };
  }

  const children = new Map();
  for (const entry of childEntries) {
    const leaf = await readRecoveryPrivateLeaf(
      context,
      scan,
      targetPath,
      targetIdentity,
      entry.path,
      MAX_RECOVERY_LEASE_BYTES
    );
    const validatedLease = validateRecoveryLeaseDocument(
      leaf.bytes,
      targetCommitLockSha256
    );
    if (validatedLease === null) {
      failExpected(context, "LOCAL_STATE_INVALID", entry.path);
    }
    const lease = { ...validatedLease, path: entry.path, leaf };
    children.set(entry.name, { ...entry, lease });
  }

  const canonicalLeasesByHash = new Map();
  if (rootEntry === null) {
    if (children.size > 0) {
      failExpected(context, "LOCAL_STATE_INVALID", targetPath);
    }
    await validateRecoveryLeaseCandidates(
      context,
      scan,
      targetPath,
      targetIdentity,
      targetCommitLockSha256,
      leaseCandidates,
      canonicalLeasesByHash
    );
    return {
      target,
      targetIdentity,
      targetCandidates,
      leaseCandidates,
      rootPresent: false,
      rootLease: null,
      leaseChain: [],
      tip: null
    };
  }

  const rootLeaf = await readRecoveryPrivateLeaf(
    context,
    scan,
    targetPath,
    targetIdentity,
    rootEntry.path,
    MAX_RECOVERY_LEASE_BYTES
  );
  const validatedRootLease = validateRecoveryLeaseDocument(
    rootLeaf.bytes,
    targetCommitLockSha256
  );
  if (validatedRootLease === null ||
      validatedRootLease.value.previous_lease_sha256 !== null ||
      validatedRootLease.value.generation !== 0) {
    failExpected(context, "LOCAL_STATE_INVALID", rootEntry.path);
  }
  const rootLease = {
    ...validatedRootLease,
    path: rootEntry.path,
    leaf: rootLeaf
  };
  canonicalLeasesByHash.set(rootLease.sha256, rootLease);

  const consumedChildren = new Set();
  const leaseChain = [rootLease];
  let parent = rootLease;
  while (true) {
    const childName = `lease-after-${parent.sha256}.json`;
    const child = children.get(childName);
    if (child === undefined) break;
    if (child.lease.value.previous_lease_sha256 !== parent.sha256 ||
        child.lease.value.generation !== parent.value.generation + 1) {
      failExpected(context, "LOCAL_STATE_INVALID", child.path);
    }
    if (canonicalLeasesByHash.has(child.lease.sha256)) {
      failExpected(context, "RECOVERY_TARGET_AMBIGUOUS", targetPath);
    }
    consumedChildren.add(childName);
    canonicalLeasesByHash.set(child.lease.sha256, child.lease);
    parent = child.lease;
    leaseChain.push(parent);
  }
  if ([...children.keys()].some((name) => !consumedChildren.has(name))) {
    failExpected(context, "RECOVERY_TARGET_AMBIGUOUS", targetPath);
  }

  await validateRecoveryLeaseCandidates(
    context,
    scan,
    targetPath,
    targetIdentity,
    targetCommitLockSha256,
    leaseCandidates,
    canonicalLeasesByHash
  );
  return {
    target,
    targetIdentity,
    targetCandidates,
    leaseCandidates,
    rootPresent: true,
    rootLease,
    leaseChain,
    tip: parent
  };
}

async function scanRecoveryNamespace(context, currentFixed) {
  const rootStat = await maybeLstat(
    context,
    RECOVERY_ROOT,
    "LOCAL_STATE_INVALID"
  );
  if (rootStat === null) {
    if (await maybeLstat(
      context,
      RECOVERY_ROOT,
      "LOCAL_STATE_INVALID"
    ) !== null) {
      failExpected(context, "LOCAL_STATE_INVALID", RECOVERY_ROOT);
    }
    return { present: false };
  }

  const rootIdentity = await provePrivatePublicationDirectory(
    context,
    RECOVERY_ROOT
  );
  const rootNames = await readDirectoryNames(
    context,
    RECOVERY_ROOT,
    "LOCAL_STATE_INVALID",
    rootIdentity
  );
  if (rootNames === null) {
    failExpected(context, "LOCAL_STATE_INVALID", RECOVERY_ROOT);
  }
  const scan = {
    present: true,
    absentPaths: new Set(),
    transitionSnapshot: null,
    directories: new Map([[RECOVERY_ROOT, {
      identity: rootIdentity,
      names: rootNames
    }]]),
    leaves: new Map(),
    targets: []
  };

  for (const name of rootNames) {
    const targetPath = `${RECOVERY_ROOT}/${name}`;
    if (!RECOVERY_TARGET_DIRECTORY_RE.test(name)) {
      failExpected(context, "LOCAL_STATE_INVALID", targetPath);
    }
    const targetIdentity = await provePrivatePublicationDirectory(
      context,
      targetPath
    );
    const targetNames = await readDirectoryNames(
      context,
      targetPath,
      "LOCAL_STATE_INVALID",
      targetIdentity
    );
    if (targetNames === null) {
      failExpected(context, "LOCAL_STATE_INVALID", targetPath);
    }
    scan.directories.set(targetPath, {
      identity: targetIdentity,
      names: targetNames
    });
    const isCurrent = currentFixed !== null && currentFixed.sha256 === name;
    const targetState = await scanRecoveryTargetDirectory(
      context,
      scan,
      name,
      targetPath,
      targetIdentity,
      targetNames,
      isCurrent ? currentFixed : null
    );
    let terminalOutcome = null;
    if (targetState.target !== null && targetState.rootPresent) {
      terminalOutcome = await scanRecoveryTerminalOutcome(
        context,
        scan,
        targetPath,
        name,
        targetState.target.validatedLock.layout
      );
    }
    scan.targets.push({
      path: targetPath,
      isCurrent,
      targetState,
      terminalOutcome
    });
    if (!isCurrent) {
      if (currentFixed !== null) {
        await reproveRecoveryFixedLock(context, currentFixed);
      }
      await reproveRecoveryScan(context, scan);
      if (currentFixed !== null) {
        await reproveRecoveryFixedLock(context, currentFixed);
      }
      if (targetState.target === null || !targetState.rootPresent ||
          terminalOutcome !== "exact") {
        failExpected(context, "RECOVERY_UNRESOLVED_TARGET", targetPath);
      }
    }
  }

  await reproveRecoveryScan(context, scan);
  return scan;
}

function isRecoveryFixedIdentityDrift(error) {
  return error instanceof StageFailure &&
    error.result?.ok === false &&
    error.result.error?.kind === "expected" &&
    error.result.error.code === "LOCAL_STATE_INVALID" &&
    error.result.error.path === COMMIT_LOCK_PATH;
}

async function scanRecoveryNamespaceGuarded(context, currentFixed) {
  try {
    return await scanRecoveryNamespace(context, currentFixed);
  } catch (error) {
    if (!(error instanceof StageFailure) || currentFixed === null) throw error;
    try {
      await reproveRecoveryFixedLock(context, currentFixed);
    } catch (reproofError) {
      if (!(reproofError instanceof StageFailure)) throw reproofError;
      if (isRecoveryFixedIdentityDrift(reproofError)) throw reproofError;
    }
    throw error;
  }
}

async function reproveRecoveryNamespace(context, scan) {
  if (!scan.present) {
    if (await maybeLstat(
      context,
      RECOVERY_ROOT,
      "LOCAL_STATE_INVALID"
    ) !== null) {
      failExpected(context, "LOCAL_STATE_INVALID", RECOVERY_ROOT);
    }
    return;
  }
  await reproveRecoveryScan(context, scan);
}

function currentRecoveryTarget(scan) {
  if (!scan.present) return null;
  return scan.targets.find((target) => target.isCurrent) ?? null;
}

function recoveryOwnerIsAlive(context, ownerPid, path) {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    failExpected(context, "LOCAL_STATE_INVALID", path);
  }
}

function makeRecoveryActor() {
  return {
    ownerPid: process.pid,
    ownerNonce: randomBytes(16).toString("hex")
  };
}

async function ensureRecoveryDirectory(context, repoPath) {
  const parentPath = dirname(repoPath).split("\\").join("/");
  const normalizedParent = parentPath === "." ? "" : parentPath;
  const parentIdentity = await inspectDirectory(
    context,
    normalizedParent,
    "LOCAL_STATE_INVALID"
  );
  if (parentIdentity === null) {
    failExpected(context, "LOCAL_STATE_INVALID", normalizedParent);
  }
  const existing = await inspectDirectory(
    context,
    repoPath,
    "LOCAL_STATE_INVALID"
  );
  if (existing === null) {
    await reproveFixedAncestors(context);
    if (typeof context.mutationAuthority === "function") {
      await context.mutationAuthority();
    }
    try {
      await fs.promises.mkdir(absolutePath(context, repoPath), { mode: 0o700 });
      context.persistentWritesOccurred = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
          failExpected(context, "LOCAL_STATE_INVALID", repoPath);
        }
        failIo(context, "mkdir", repoPath);
      }
    }
  }
  const childIdentity = await provePrivatePublicationDirectory(
    context,
    repoPath
  );
  if (existing !== null && !sameIdentity(existing, childIdentity)) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
  const parentBeforeSync = await inspectDirectory(
    context,
    normalizedParent,
    "LOCAL_STATE_INVALID"
  );
  if (parentBeforeSync === null ||
      !sameIdentity(parentIdentity, parentBeforeSync)) {
    failExpected(context, "LOCAL_STATE_INVALID", normalizedParent);
  }
  await syncDirectory(
    context,
    normalizedParent,
    "LOCAL_STATE_INVALID"
  );
  const parentAfterSync = await inspectDirectory(
    context,
    normalizedParent,
    "LOCAL_STATE_INVALID"
  );
  const childAfterSync = await provePrivatePublicationDirectory(
    context,
    repoPath
  );
  if (parentAfterSync === null ||
      !sameIdentity(parentIdentity, parentAfterSync)) {
    failExpected(context, "LOCAL_STATE_INVALID", normalizedParent);
  }
  if (!sameIdentity(childIdentity, childAfterSync)) {
    failExpected(context, "LOCAL_STATE_INVALID", repoPath);
  }
  return childAfterSync;
}

function sameRecoveryLeaseProof(left, right) {
  return left.path === right.path && left.bytes.equals(right.bytes) &&
    sameFileFacts(left.leaf.facts, right.leaf.facts) &&
    sameIdentity(left.leaf.parent, right.leaf.parent);
}

function sameRecoveryLeaseChain(left, right) {
  return left.length === right.length && left.every((lease, index) =>
    sameRecoveryLeaseProof(lease, right[index]));
}

function reproveRecoveryTargetProof(context, expected, actual) {
  if (actual === null || actual === undefined ||
      !actual.bytes.equals(expected.bytes) ||
      !sameFileFacts(actual.leaf.facts, expected.leaf.facts) ||
      !sameIdentity(actual.leaf.parent, expected.leaf.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", expected.path);
  }
}

function reproveRecoveryLeaseChainProof(
  context,
  expected,
  actual,
  targetPath
) {
  if (actual === null || actual === undefined) {
    failExpected(context, "LOCAL_STATE_INVALID", targetPath);
  }
  const sharedLength = Math.min(expected.length, actual.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (!sameRecoveryLeaseProof(expected[index], actual[index])) {
      const path = expected[index].path === actual[index].path
        ? expected[index].path
        : [expected[index].path, actual[index].path].sort(compareAscii)[0];
      failExpected(context, "LOCAL_STATE_INVALID", path);
    }
  }
  if (expected.length !== actual.length) {
    failExpected(
      context,
      "LOCAL_STATE_INVALID",
      (expected[sharedLength] ?? actual[sharedLength]).path
    );
  }
}

async function refreshCurrentRecoveryTarget(context, fixed) {
  const scan = await scanRecoveryNamespaceGuarded(context, fixed);
  await reproveRecoveryFixedLock(context, fixed);
  await reproveRecoveryNamespace(context, scan);
  await reproveRecoveryFixedLock(context, fixed);
  return { scan, current: currentRecoveryTarget(scan) };
}

async function reproveRecoveryTargetPublicationAuthority(
  context,
  fixed,
  targetPath,
  targetIdentity,
  candidatePath,
  destinationPath,
  candidateProof
) {
  await reproveRecoveryFixedLock(context, fixed);
  const refreshed = await refreshCurrentRecoveryTarget(context, fixed);
  const state = refreshed.current?.targetState;
  if (state === null || state === undefined ||
      !sameIdentity(targetIdentity, state.targetIdentity)) {
    failExpected(context, "LOCAL_STATE_INVALID", targetPath);
  }
  if (state.target !== null || await maybeLstat(
    context,
    destinationPath,
    "LOCAL_STATE_INVALID"
  ) !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  if (state.rootPresent || state.leaseCandidates.length !== 0) {
    const path = state.rootLease?.path ?? state.leaseCandidates[0]?.path ??
      targetPath;
    failExpected(context, "LOCAL_STATE_INVALID", path);
  }
  const candidate = state.targetCandidates.find((entry) =>
    entry.path === candidatePath);
  if (state.targetCandidates.length !== 1 || candidate === undefined ||
      !candidate.leaf.bytes.equals(candidateProof.bytes) ||
      !sameFileFacts(candidate.leaf.facts, candidateProof.facts) ||
      !sameIdentity(candidate.leaf.parent, candidateProof.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", candidatePath);
  }
  await reproveRecoveryFixedLock(context, fixed);
}

async function reproveRecoveryLeasePublicationAuthority(
  context,
  fixed,
  expectedTarget,
  expectedChain,
  candidatePath,
  destinationPath,
  expectedDeadTip,
  candidateProof
) {
  await reproveRecoveryFixedLock(context, fixed);
  const refreshed = await refreshCurrentRecoveryTarget(context, fixed);
  const state = refreshed.current?.targetState;
  const target = state?.target;
  const chain = state?.leaseChain;
  const candidate = state?.leaseCandidates.find((entry) =>
    entry.path === candidatePath);
  reproveRecoveryTargetProof(context, expectedTarget, target);
  reproveRecoveryLeaseChainProof(
    context,
    expectedChain,
    chain,
    expectedTarget.path.slice(0, expectedTarget.path.lastIndexOf("/"))
  );
  if (candidate === undefined ||
      !candidate.leaf.bytes.equals(candidateProof.bytes) ||
      !sameFileFacts(candidate.leaf.facts, candidateProof.facts) ||
      !sameIdentity(candidate.leaf.parent, candidateProof.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", candidatePath);
  }
  if (await maybeLstat(
    context,
    destinationPath,
    "LOCAL_STATE_INVALID"
  ) !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  const otherCandidates = state.leaseCandidates
    .filter((entry) => entry.path !== candidatePath)
    .sort((left, right) => compareAscii(left.path, right.path));
  for (const otherCandidate of otherCandidates) {
    if (recoveryOwnerIsAlive(
      context,
      otherCandidate.ownerPid,
      otherCandidate.path
    )) {
      failExpected(
        context,
        "CLEANING_RECOVERY_LOCKED",
        otherCandidate.path
      );
    }
    failExpected(context, "LOCAL_STATE_INVALID", otherCandidate.path);
  }
  if (expectedDeadTip !== null && recoveryOwnerIsAlive(
    context,
    expectedDeadTip.value.owner_pid,
    expectedDeadTip.path
  )) {
    failExpected(context, "CLEANING_RECOVERY_LOCKED", expectedDeadTip.path);
  }
  await reproveRecoveryFixedLock(context, fixed);
}

async function reprovePublishedRecoveryTarget(
  context,
  fixed,
  targetIdentity,
  candidatePath,
  destinationPath,
  candidateProof,
  destinationProof
) {
  await reproveRecoveryFixedLock(context, fixed);
  const refreshed = await refreshCurrentRecoveryTarget(context, fixed);
  const state = refreshed.current?.targetState;
  if (state === null || state === undefined ||
      !sameIdentity(targetIdentity, state.targetIdentity)) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  const target = state.target;
  if (target === null || target.path !== destinationPath ||
      !target.bytes.equals(destinationProof.bytes) ||
      !sameFileFacts(target.leaf.facts, destinationProof.facts) ||
      !sameIdentity(target.leaf.parent, destinationProof.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  const candidate = state.targetCandidates.find((entry) =>
    entry.path === candidatePath);
  if (state.targetCandidates.length !== 1 || candidate === undefined ||
      !candidate.leaf.bytes.equals(candidateProof.bytes) ||
      !sameFileFacts(candidate.leaf.facts, candidateProof.facts) ||
      !sameIdentity(candidate.leaf.parent, candidateProof.parent) ||
      !sameIdentity(candidate.leaf.facts, target.leaf.facts)) {
    failExpected(context, "LOCAL_STATE_INVALID", candidatePath);
  }
  if (state.rootPresent || state.leaseCandidates.length !== 0) {
    failExpected(
      context,
      "LOCAL_STATE_INVALID",
      state.rootLease?.path ?? state.leaseCandidates[0]?.path ?? destinationPath
    );
  }
  await reproveRecoveryFixedLock(context, fixed);
}

async function reprovePublishedRecoveryLease(
  context,
  fixed,
  expectedTarget,
  expectedChain,
  candidatePath,
  destinationPath,
  candidateProof,
  destinationProof
) {
  await reproveRecoveryFixedLock(context, fixed);
  const refreshed = await refreshCurrentRecoveryTarget(context, fixed);
  const state = refreshed.current?.targetState;
  reproveRecoveryTargetProof(context, expectedTarget, state?.target);
  const chain = state?.leaseChain;
  if (chain === null || chain === undefined ||
      chain.length !== expectedChain.length + 1) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  reproveRecoveryLeaseChainProof(
    context,
    expectedChain,
    chain.slice(0, -1),
    expectedTarget.path.slice(0, expectedTarget.path.lastIndexOf("/"))
  );
  const published = chain.at(-1);
  if (published.path !== destinationPath ||
      !published.bytes.equals(destinationProof.bytes) ||
      !sameFileFacts(published.leaf.facts, destinationProof.facts) ||
      !sameIdentity(published.leaf.parent, destinationProof.parent)) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  const candidate = state.leaseCandidates.find((entry) =>
    entry.path === candidatePath);
  if (candidate === undefined ||
      !candidate.leaf.bytes.equals(candidateProof.bytes) ||
      !sameFileFacts(candidate.leaf.facts, candidateProof.facts) ||
      !sameIdentity(candidate.leaf.parent, candidateProof.parent) ||
      !sameIdentity(candidate.leaf.facts, published.leaf.facts)) {
    failExpected(context, "LOCAL_STATE_INVALID", candidatePath);
  }
  const otherCandidates = state.leaseCandidates
    .filter((entry) => entry.path !== candidatePath)
    .sort((left, right) => compareAscii(left.path, right.path));
  for (const otherCandidate of otherCandidates) {
    if (recoveryOwnerIsAlive(
      context,
      otherCandidate.ownerPid,
      otherCandidate.path
    )) {
      failExpected(
        context,
        "CLEANING_RECOVERY_LOCKED",
        otherCandidate.path
      );
    }
    failExpected(context, "LOCAL_STATE_INVALID", otherCandidate.path);
  }
  const successorPath =
    `${expectedTarget.path.slice(0, expectedTarget.path.lastIndexOf("/"))}` +
    `/lease-after-${published.sha256}.json`;
  if (await maybeLstat(
    context,
    successorPath,
    "LOCAL_STATE_INVALID"
  ) !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", successorPath);
  }
  await reproveRecoveryFixedLock(context, fixed);
}

async function publishRecoveryExactFile(
  context,
  candidatePath,
  destinationPath,
  bytes,
  parentPath,
  maxBytes,
  beforeLinkProof = null,
  postLinkProof = null
) {
  const existing = await inspectPrivateLeaf(context, destinationPath, maxBytes);
  if (existing !== null) {
    if (!existing.bytes.equals(bytes)) {
      failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
    }
    return existing;
  }
  const publication = await publishFreshNoClobberFile(
    context,
    candidatePath,
    destinationPath,
    bytes,
    parentPath,
    null,
    beforeLinkProof,
    postLinkProof
  );
  if (publication.linked) return publication.leaf;
  const winner = await inspectPrivateLeaf(context, destinationPath, maxBytes);
  if (winner === null || !winner.bytes.equals(bytes)) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  await unlinkPrivateLeaf(
    context,
    candidatePath,
    bytes,
    publication.candidate.facts
  );
  await syncDirectory(context, parentPath, "LOCAL_STATE_INVALID");
  return reprovePrivateLeaf(context, destinationPath, bytes, winner);
}

async function publishRecoveryLeaseNode(
  context,
  candidatePath,
  destinationPath,
  bytes,
  targetPath,
  targetCommitLockSha256,
  previousLeaseSha256,
  generation,
  beforeLinkProof,
  postLinkProof
) {
  const publication = await publishFreshNoClobberFile(
    context,
    candidatePath,
    destinationPath,
    bytes,
    targetPath,
    null,
    beforeLinkProof,
    postLinkProof
  );
  if (publication.linked) return publication.leaf;
  const winnerLeaf = await inspectPrivateLeaf(
    context,
    destinationPath,
    MAX_RECOVERY_LEASE_BYTES
  );
  const winner = winnerLeaf === null
    ? null
    : validateRecoveryLeaseDocument(
      winnerLeaf.bytes,
      targetCommitLockSha256
    );
  if (winner === null ||
      winner.value.previous_lease_sha256 !== previousLeaseSha256 ||
      winner.value.generation !== generation) {
    failExpected(context, "LOCAL_STATE_INVALID", destinationPath);
  }
  if (winnerLeaf.bytes.equals(bytes) &&
      !sameIdentity(winnerLeaf.facts, publication.candidate.facts)) {
    failExpected(context, "CLEANING_RECOVERY_LOCKED", destinationPath);
  }
  await unlinkPrivateLeaf(
    context,
    candidatePath,
    bytes,
    publication.candidate.facts
  );
  await syncDirectory(context, targetPath, "LOCAL_STATE_INVALID");
  return reprovePrivateLeaf(
    context,
    destinationPath,
    winnerLeaf.bytes,
    winnerLeaf
  );
}

function recoveryCandidates(state) {
  return [
    ...state.targetCandidates,
    ...state.leaseCandidates
  ].sort((left, right) => compareAscii(left.path, right.path));
}

function sameRecoveryCandidateProof(left, right) {
  return left.path === right.path && left.ownerPid === right.ownerPid &&
    left.ownerNonce === right.ownerNonce &&
    left.nodePath === right.nodePath &&
    left.leaf.bytes.equals(right.leaf.bytes) &&
    sameFileFacts(left.leaf.facts, right.leaf.facts) &&
    sameIdentity(left.leaf.parent, right.leaf.parent);
}

function reproveRecoveryCandidateSet(context, expected, actual) {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const difference = [...new Set([
    ...expectedByPath.keys(),
    ...actualByPath.keys()
  ])].sort(compareAscii).find((path) =>
    !expectedByPath.has(path) || !actualByPath.has(path));
  if (difference !== undefined) {
    failExpected(context, "LOCAL_STATE_INVALID", difference);
  }
  for (const expectedCandidate of expected) {
    const actualCandidate = actualByPath.get(expectedCandidate.path);
    if (actualCandidate === undefined ||
        !sameRecoveryCandidateProof(expectedCandidate, actualCandidate)) {
      failExpected(context, "LOCAL_STATE_INVALID", expectedCandidate.path);
    }
  }
}

function failIfRecoveryCandidateOwnerAlive(context, candidates) {
  for (const candidate of candidates) {
    if (recoveryOwnerIsAlive(context, candidate.ownerPid, candidate.path)) {
      failExpected(context, "CLEANING_RECOVERY_LOCKED", candidate.path);
    }
  }
}

async function validateAndCleanRecoveryCandidates(context, fixed, refreshed) {
  const state = refreshed.current?.targetState;
  if (state === null || state === undefined) return refreshed;
  const candidates = recoveryCandidates(state);
  failIfRecoveryCandidateOwnerAlive(context, candidates);

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const expectedRemaining = candidates.slice(index);
    await reproveRecoveryFixedLock(context, fixed);
    const beforeCleanup = await refreshCurrentRecoveryTarget(context, fixed);
    const beforeState = beforeCleanup.current?.targetState;
    if (beforeState === null || beforeState === undefined) {
      failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
    }
    const beforeCandidates = recoveryCandidates(beforeState);
    reproveRecoveryCandidateSet(context, expectedRemaining, beforeCandidates);
    failIfRecoveryCandidateOwnerAlive(context, beforeCandidates);
    const currentCandidate = beforeCandidates.find((entry) =>
      entry.path === candidate.path).leaf;
    const nodeBefore = await inspectPrivateLeaf(
      context,
      candidate.nodePath,
      candidate.expectedBytes?.length ?? MAX_RECOVERY_TARGET_BYTES
    );
    const sameNode = nodeBefore !== null &&
      sameIdentity(nodeBefore.facts, currentCandidate.facts);
    if (((nodeBefore === null || !sameNode) &&
          currentCandidate.facts.nlink !== 1) ||
        (sameNode && currentCandidate.facts.nlink < 2)) {
      failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
    }
    await directMutation(
      context,
      "unlink",
      candidate.path,
      async () => {
        await reproveRecoveryFixedLock(context, fixed);
        const finalScan = await refreshCurrentRecoveryTarget(context, fixed);
        const finalState = finalScan.current?.targetState;
        if (finalState === null || finalState === undefined) {
          failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
        }
        const finalCandidates = recoveryCandidates(finalState);
        reproveRecoveryCandidateSet(
          context,
          expectedRemaining,
          finalCandidates
        );
        failIfRecoveryCandidateOwnerAlive(context, finalCandidates);
        const candidateFinal = finalCandidates.find((entry) =>
          entry.path === candidate.path).leaf;
        const nodeFinal = await inspectPrivateLeaf(
          context,
          candidate.nodePath,
          candidate.expectedBytes?.length ?? MAX_RECOVERY_TARGET_BYTES
        );
        if (candidateFinal === null ||
            !candidateFinal.bytes.equals(currentCandidate.bytes) ||
            !sameFileFacts(candidateFinal.facts, currentCandidate.facts)) {
          failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
        }
        if (nodeBefore === null) {
          if (nodeFinal !== null || candidateFinal.facts.nlink !== 1) {
            failExpected(context, "LOCAL_STATE_INVALID", candidate.nodePath);
          }
        } else if (nodeFinal === null ||
            !nodeFinal.bytes.equals(nodeBefore.bytes) ||
            !sameFileFacts(nodeFinal.facts, nodeBefore.facts) ||
            sameIdentity(nodeFinal.facts, candidateFinal.facts) !== sameNode) {
          failExpected(context, "LOCAL_STATE_INVALID", candidate.nodePath);
        }
      },
      () => fs.promises.unlink(absolutePath(context, candidate.path))
    );
    if (await maybeLstat(
      context,
      candidate.path,
      "LOCAL_STATE_INVALID"
    ) !== null) {
      failExpected(context, "LOCAL_STATE_INVALID", candidate.path);
    }
    await syncDirectory(context, state.target === null
      ? dirname(candidate.path).split("\\").join("/")
      : dirname(state.target.path).split("\\").join("/"),
    "LOCAL_STATE_INVALID");
    const nodeAfter = await inspectPrivateLeaf(
      context,
      candidate.nodePath,
      nodeBefore?.bytes.length ??
        (candidate.expectedBytes?.length ?? MAX_RECOVERY_TARGET_BYTES)
    );
    if ((nodeBefore === null && nodeAfter !== null) ||
        (nodeBefore !== null && (nodeAfter === null ||
          !nodeAfter.bytes.equals(nodeBefore.bytes) ||
          (sameNode
            ? (!sameIdentity(nodeAfter.facts, nodeBefore.facts) ||
              nodeAfter.facts.nlink !== nodeBefore.facts.nlink - 1)
            : !sameFileFacts(nodeAfter.facts, nodeBefore.facts))))) {
      failExpected(context, "LOCAL_STATE_INVALID", candidate.nodePath);
    }
  }
  return refreshCurrentRecoveryTarget(context, fixed);
}

async function ensureCurrentRecoveryTarget(context, fixed, actor) {
  await ensureRecoveryDirectory(context, RECOVERY_ROOT);
  const targetPath = `${RECOVERY_ROOT}/${fixed.sha256}`;
  await ensureRecoveryDirectory(context, targetPath);
  let refreshed = await refreshCurrentRecoveryTarget(context, fixed);
  if (refreshed.current === null) {
    failExpected(context, "LOCAL_STATE_INVALID", targetPath);
  }
  const expectedBytes = makeRecoveryTargetDocumentBytes(fixed.bytes);
  if (refreshed.current.targetState.target === null) {
    const candidatePath =
      `${targetPath}/.target.${actor.ownerPid}.${actor.ownerNonce}.tmp`;
    await publishRecoveryExactFile(
      context,
      candidatePath,
      `${targetPath}/target.json`,
      expectedBytes,
      targetPath,
      MAX_RECOVERY_TARGET_BYTES,
      (candidateProof) => reproveRecoveryTargetPublicationAuthority(
        context,
        fixed,
        targetPath,
        refreshed.current.targetState.targetIdentity,
        candidatePath,
        `${targetPath}/target.json`,
        candidateProof
      ),
      (candidateProof, destinationProof) =>
        reprovePublishedRecoveryTarget(
          context,
          fixed,
          refreshed.current.targetState.targetIdentity,
          candidatePath,
          `${targetPath}/target.json`,
          candidateProof,
          destinationProof
        )
    );
    refreshed = await refreshCurrentRecoveryTarget(context, fixed);
  }
  const target = refreshed.current.targetState.target;
  if (target === null || !target.bytes.equals(expectedBytes)) {
    failExpected(context, "LOCAL_STATE_INVALID", `${targetPath}/target.json`);
  }
  return { ...refreshed, targetPath, target };
}

async function acquireRecoveryLease(context, fixed, actor) {
  const targetPath = `${RECOVERY_ROOT}/${fixed.sha256}`;
  for (let attempts = 0; attempts < 128; attempts += 1) {
    const refreshed = await refreshCurrentRecoveryTarget(context, fixed);
    const state = refreshed.current?.targetState;
    if (state?.target === null || state?.target === undefined) {
      failExpected(context, "LOCAL_STATE_INVALID", `${targetPath}/target.json`);
    }
    if (refreshed.current.terminalOutcome === "exact") {
      failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
    }

    let previousLeaseSha256 = null;
    let generation = 0;
    let destinationPath = `${targetPath}/lease-root.json`;
    let candidateAnchor = "root";
    if (state.rootPresent) {
      const tip = state.tip;
      if (tip.value.owner_pid === actor.ownerPid &&
          tip.value.owner_nonce === actor.ownerNonce) {
        return {
          actor,
          targetPath,
          target: state.target,
          chain: state.leaseChain,
          tip
        };
      }
      if (recoveryOwnerIsAlive(context, tip.value.owner_pid, tip.path)) {
        failExpected(context, "CLEANING_RECOVERY_LOCKED", tip.path);
      }
      previousLeaseSha256 = tip.sha256;
      generation = tip.value.generation + 1;
      candidateAnchor = tip.sha256;
      destinationPath = `${targetPath}/lease-after-${tip.sha256}.json`;
    }

    const bytes = makeRecoveryLeaseDocumentBytes({
      targetCommitLockSha256: fixed.sha256,
      previousLeaseSha256,
      generation,
      ownerPid: actor.ownerPid,
      ownerNonce: actor.ownerNonce
    });
    const candidatePath =
      `${targetPath}/.lease-${candidateAnchor}.${actor.ownerPid}.${actor.ownerNonce}.tmp`;
    const expectedTarget = state.target;
    const expectedChain = state.leaseChain;
    const expectedDeadTip = state.rootPresent ? state.tip : null;
    await publishRecoveryLeaseNode(
      context,
      candidatePath,
      destinationPath,
      bytes,
      targetPath,
      fixed.sha256,
      previousLeaseSha256,
      generation,
      async (candidateProof) => {
        await reproveRecoveryLeasePublicationAuthority(
          context,
          fixed,
          expectedTarget,
          expectedChain,
          candidatePath,
          destinationPath,
          expectedDeadTip,
          candidateProof
        );
        if (generation === 0 && originalRecoveryOwnerIsAlive(
          context,
          fixed.intent.owner_pid
        )) {
          failExpected(context, "RECOVERY_OWNER_ALIVE", COMMIT_LOCK_PATH);
        }
      },
      (candidateProof, destinationProof) =>
        reprovePublishedRecoveryLease(
          context,
          fixed,
          expectedTarget,
          expectedChain,
          candidatePath,
          destinationPath,
          candidateProof,
          destinationProof
        )
    );
  }
  failExpected(context, "RECOVERY_TARGET_AMBIGUOUS", targetPath);
}

async function reproveActiveRecoveryAuthority(context, fixed, authority) {
  await reproveRecoveryFixedLock(context, fixed);
  const refreshed = await refreshCurrentRecoveryTarget(context, fixed);
  const state = refreshed.current?.targetState;
  const target = state?.target;
  const tip = state?.tip;
  const chain = state?.leaseChain;
  reproveRecoveryTargetProof(context, authority.target, target);
  reproveRecoveryLeaseChainProof(
    context,
    authority.chain,
    chain,
    authority.targetPath
  );
  if (tip === null || tip === undefined ||
      tip.path !== authority.tip.path || !tip.bytes.equals(authority.tip.bytes) ||
      !sameFileFacts(tip.leaf.facts, authority.tip.leaf.facts) ||
      !sameIdentity(tip.leaf.parent, authority.tip.leaf.parent) ||
      tip.value.owner_pid !== authority.actor.ownerPid ||
      tip.value.owner_nonce !== authority.actor.ownerNonce) {
    failExpected(context, "LOCAL_STATE_INVALID", authority.tip.path);
  }
  const successorPath =
    `${authority.targetPath}/lease-after-${authority.tip.sha256}.json`;
  if (await maybeLstat(
    context,
    successorPath,
    "LOCAL_STATE_INVALID"
  ) !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", successorPath);
  }
  await reproveRecoveryFixedLock(context, fixed);
  return { refreshed, target, tip };
}

async function publishRecoveryRetirement(
  context,
  fixed,
  authority,
  pointerLeaf
) {
  await ensurePrivatePublicationDirectory(context, TRANSITIONS_DIRECTORY);
  const observedPointerSha256 = pointerLeaf === null
    ? null
    : sha256(pointerLeaf.bytes);
  const record = retirementRecord(
    fixed.layout,
    fixed.sha256,
    observedPointerSha256
  );
  const observedSuffix = observedPointerSha256 ?? "absent";
  const path =
    `${TRANSITIONS_DIRECTORY}/retire-${fixed.sha256}-${observedSuffix}.json`;
  const bytes = canonicalJsonDocumentBytes(record);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const candidatePath =
    `${TRANSITIONS_DIRECTORY}/.${name}.${authority.actor.ownerPid}.${authority.actor.ownerNonce}.tmp`;
  const leaf = await publishRecoveryExactFile(
    context,
    candidatePath,
    path,
    bytes,
    TRANSITIONS_DIRECTORY,
    MAX_TRANSITION_RECORD_BYTES
  );
  return { path, bytes, leaf };
}

async function releaseRecoveredFixedLock(
  context,
  fixed,
  authority,
  terminal
) {
  await directMutation(
    context,
    "unlink",
    COMMIT_LOCK_PATH,
    async () => {
      await reprovePrivateLeaf(
        context,
        terminal.path,
        terminal.bytes,
        terminal.leaf
      );
      await reproveRecoveryFixedLock(context, fixed);
      await reproveActiveRecoveryAuthority(context, fixed, authority);
    },
    () => fs.promises.unlink(absolutePath(context, COMMIT_LOCK_PATH))
  );
  context.mutationAuthority = null;
  if (await maybeLstat(
    context,
    COMMIT_LOCK_PATH,
    "LOCAL_STATE_INVALID"
  ) !== null) {
    failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
  }
  await syncDirectory(context, STATE_DIRECTORY, "LOCAL_STATE_INVALID");
}

function staleRecoverySuccessResult(
  context,
  fixed,
  authority,
  pointerLeaf,
  terminal
) {
  return deepFreeze({
    ok: true,
    value: {
      kind: "stale_lock_retired",
      selected_target_commit_lock_sha256: fixed.sha256,
      current_fixed_commit_lock_sha256: fixed.sha256,
      active_lease_path: authority.tip.path,
      final_pointer: pointerLeaf === null
        ? null
        : parseCanonicalDocumentBytes(pointerLeaf.bytes),
      transition_record_path: terminal.path,
      commit_lock_cleanup: "unlinked_and_fsynced",
      persistent_writes_occurred: context.persistentWritesOccurred
    }
  });
}

function recoveredRecoverySuccessResult(
  context,
  fixed,
  authority,
  pointerLeaf,
  terminal
) {
  return deepFreeze({
    ok: true,
    value: {
      kind: "recovered",
      selected_target_commit_lock_sha256: fixed.sha256,
      current_fixed_commit_lock_sha256: fixed.sha256,
      active_lease_path: authority.tip.path,
      final_pointer: pointerLeaf === null
        ? null
        : parseCanonicalDocumentBytes(pointerLeaf.bytes),
      transition_record_path: terminal.path,
      commit_lock_cleanup: "unlinked_and_fsynced",
      persistent_writes_occurred: context.persistentWritesOccurred
    }
  });
}

async function publishRecoveryCompletion(context, fixed, authority) {
  await ensurePrivatePublicationDirectory(context, TRANSITIONS_DIRECTORY);
  const completion = completionRecord(fixed.layout, fixed.sha256);
  const path = `${TRANSITIONS_DIRECTORY}/complete-${fixed.sha256}-${fixed.layout.manifest.desired_pointer_sha256}.json`;
  const bytes = canonicalJsonDocumentBytes(completion);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const candidatePath =
    `${TRANSITIONS_DIRECTORY}/.${name}.${authority.actor.ownerPid}.${authority.actor.ownerNonce}.tmp`;
  const leaf = await publishRecoveryExactFile(
    context,
    candidatePath,
    path,
    bytes,
    TRANSITIONS_DIRECTORY,
    MAX_TRANSITION_RECORD_BYTES
  );
  return { path, bytes, leaf };
}

async function runRecovery(context) {
  try {
    const local = await inspectDirectory(
      context,
      ".local",
      "LOCAL_STATE_INVALID"
    );
    if (local === null) {
      failExpected(context, "LOCAL_STATE_MISSING", STATE_DIRECTORY);
    }
    await provePrivatePublicationDirectory(context, ".local");

    const state = await inspectDirectory(
      context,
      STATE_DIRECTORY,
      "LOCAL_STATE_INVALID"
    );
    if (state === null) {
      failExpected(context, "LOCAL_STATE_MISSING", STATE_DIRECTORY);
    }
    await provePrivatePublicationDirectory(context, STATE_DIRECTORY);

    const fixed = await readRecoveryFixedLock(context);
    let ownerAlive = null;
    if (fixed !== null) {
      context.layout = fixed.layout;
      context.currentFixedCommitLockSha256 = fixed.sha256;
      await verifyImmutableRun(context);
      await reproveRecoveryFixedLock(context, fixed);
      ownerAlive = originalRecoveryOwnerIsAlive(
        context,
        fixed.intent.owner_pid
      );
    }

    const recoveryScan = await scanRecoveryNamespaceGuarded(context, fixed);
    if (fixed !== null) {
      await reproveRecoveryFixedLock(context, fixed);
      await reproveRecoveryNamespace(context, recoveryScan);
      await reproveRecoveryFixedLock(context, fixed);
      if (ownerAlive) {
        failExpected(context, "RECOVERY_OWNER_ALIVE", COMMIT_LOCK_PATH);
      }

      const actor = makeRecoveryActor();
      context.mutationAuthority = () =>
        reproveRecoveryFixedLock(context, fixed);
      await ensureRecoveryDirectory(context, RECOVERY_ROOT);
      await ensureRecoveryDirectory(
        context,
        `${RECOVERY_ROOT}/${fixed.sha256}`
      );
      let candidateScan = await refreshCurrentRecoveryTarget(context, fixed);
      candidateScan = await validateAndCleanRecoveryCandidates(
        context,
        fixed,
        candidateScan
      );
      const currentTarget = await ensureCurrentRecoveryTarget(
        context,
        fixed,
        actor
      );
      await reproveRecoveryFixedLock(context, fixed);
      if (originalRecoveryOwnerIsAlive(context, fixed.intent.owner_pid)) {
        failExpected(context, "RECOVERY_OWNER_ALIVE", COMMIT_LOCK_PATH);
      }
      if (currentTarget.current.terminalOutcome === "exact") {
        failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
      }
      const authority = await acquireRecoveryLease(context, fixed, actor);
      context.mutationAuthority = () =>
        reproveActiveRecoveryAuthority(context, fixed, authority);
      await reproveActiveRecoveryAuthority(context, fixed, authority);
      const pointerLeaf = await readPointerLeaf(context);
      const kind = pointerKind(fixed.layout, pointerLeaf);
      if (kind === "stale") {
        const terminal = await publishRecoveryRetirement(
          context,
          fixed,
          authority,
          pointerLeaf
        );
        await reprovePointerLeaf(context, pointerLeaf);
        await reproveActiveRecoveryAuthority(context, fixed, authority);
        await releaseRecoveredFixedLock(
          context,
          fixed,
          authority,
          terminal
        );
        return staleRecoverySuccessResult(
          context,
          fixed,
          authority,
          pointerLeaf,
          terminal
        );
      }
      if (kind !== "desired" && kind !== "expected_prior") {
        failExpected(context, "LOCAL_STATE_INVALID", COMMIT_LOCK_PATH);
      }

      const finalPointerLeaf = kind === "expected_prior"
        ? await publishPointer(context, fixed, pointerLeaf)
        : pointerLeaf;
      const terminal = await publishRecoveryCompletion(
        context,
        fixed,
        authority
      );
      await reproveVerifiedRun(context);
      await reprovePointerLeaf(context, finalPointerLeaf);
      await reproveActiveRecoveryAuthority(context, fixed, authority);
      await releaseRecoveredFixedLock(
        context,
        fixed,
        authority,
        terminal
      );
      return recoveredRecoverySuccessResult(
        context,
        fixed,
        authority,
        finalPointerLeaf,
        terminal
      );
    }

    await reproveRecoveryNamespace(context, recoveryScan);
    await syncDirectory(context, STATE_DIRECTORY, "LOCAL_STATE_INVALID");
    return recoverySuccessResult(context);
  } catch (error) {
    if (error instanceof StageFailure) return deepFreeze(error.result);
    throw error;
  }
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function successResult(layout, persistentWritesOccurred) {
  return deepFreeze({
    ok: true,
    value: {
      kind: "staged",
      staged_run: {
        plan_manifest: canonicalClone(layout.plan.manifest),
        plan_manifest_sha256: layout.plan.manifest_sha256,
        run_sha256: layout.runSha256,
        staging_path: layout.stagingPath,
        final_run_path: layout.finalRunPath,
        artifact_manifest: canonicalClone(layout.plan.manifest.artifact_manifest)
      },
      persistent_writes_occurred: persistentWritesOccurred
    }
  });
}

async function runStage(context) {
  try {
    const state = await preflight(context, context.layout);
    const adoptingCompleteFinal = isCompleteFinalAdoption(context.layout, state);
    await ensureStagingDirectories(context, context.layout);
    if (adoptingCompleteFinal) {
      await reproveCompleteFinalAdoption(context, context.layout, state);
    }
    const intent = await ensureIntent(context, context.layout, state);
    context.expectedFinalLeaves.set(context.layout.intentPath, intent);
    if (adoptingCompleteFinal) {
      await reproveCompleteFinalAdoption(context, context.layout, state);
    }
    await ensureFinalDirectories(context, context.layout);
    await stageArtifacts(context, context.layout, state);
    await verifyFinalState(context, context.layout);
    return successResult(context.layout, context.persistentWritesOccurred);
  } catch (error) {
    if (error instanceof StageFailure) return error.result;
    throw error;
  }
}

export function stageCleaningRun(options) {
  let validatedOptions;
  try {
    validatedOptions = validateOptions(options);
  } catch (error) {
    return Promise.reject(error);
  }
  let plan;
  try {
    plan = snapshotPlan(validatedOptions.plan);
  } catch (error) {
    return Promise.reject(error);
  }
  let layout = null;
  try {
    layout = validatePlan(plan);
  } catch {
    layout = null;
  }
  if (layout === null) {
    return Promise.resolve(expectedResult("PLAN_BINDING_MISMATCH"));
  }
  if (validatedOptions.failure !== null) {
    return Promise.resolve(validatedOptions.failure);
  }
  const context = {
    rootDir: validatedOptions.rootDir,
    layout,
    persistentWritesOccurred: false,
    fixedAncestorProofs: new Map([["", validatedOptions.rootIdentity]]),
    expectedFinalLeaves: new Map()
  };
  layout.artifactBytes = new Map(layout.artifactBytes);
  return runStage(context);
}

export function publishCleaningRun(options) {
  let validatedOptions;
  try {
    validatedOptions = validatePublishOptions(options);
  } catch (error) {
    return Promise.reject(error);
  }
  let stagedRun;
  try {
    stagedRun = snapshotStagedRun(validatedOptions.stagedRun);
  } catch (error) {
    return Promise.reject(error);
  }
  let layout = null;
  try {
    layout = validateStagedRun(stagedRun);
  } catch {
    layout = null;
  }
  if (layout === null) {
    return Promise.resolve(expectedResult("PLAN_BINDING_MISMATCH"));
  }
  if (validatedOptions.failure !== null) {
    return Promise.resolve(validatedOptions.failure);
  }
  const context = {
    rootDir: validatedOptions.rootDir,
    layout,
    persistentWritesOccurred: false,
    fixedAncestorProofs: new Map([["", validatedOptions.rootIdentity]]),
    privateDirectoryProofs: new Set()
  };
  return runPublish(context);
}

export function recoverInterruptedCleaningCommit(options) {
  let fields;
  try {
    fields = validateRecoveryOptions(options);
  } catch (error) {
    return Promise.reject(error);
  }
  if (fields.confirmation !== RECOVERY_CONFIRMATION) {
    return Promise.resolve(deepFreeze(expectedResult(
      "RECOVERY_CONFIRMATION_REQUIRED"
    )));
  }

  const anchoredRoot = anchorRecoveryRoot(fields.rootDir);
  if (anchoredRoot.failure !== null) {
    return Promise.resolve(deepFreeze(anchoredRoot.failure));
  }
  const context = {
    rootDir: anchoredRoot.rootDir,
    persistentWritesOccurred: false,
    fixedAncestorProofs: new Map([["", anchoredRoot.rootIdentity]]),
    privateDirectoryProofs: new Set()
  };
  return runRecovery(context);
}
