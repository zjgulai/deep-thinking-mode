#!/usr/bin/env node
/**
 * tools/release-public-root.mjs
 *
 * Thin CLI for the public-history release pipeline.
 *
 * Commands:
 *   prepare            — validate manifest and create candidate tree
 *   inspect-candidate  — print the candidate tree details
 *   approve-candidate  — record gate approval for the candidate
 *   create-root        — create the parentless root commit
 *   inspect-root       — verify and print the root commit details
 *   approve-root       — record gate approval for the root
 *   activate-main      — compare-and-swap refs/heads/main to the root
 *   verify-active      — verify the active state after activation
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadPublicPathManifest,
  preparePublicTree,
  recordGateApproval,
  createPublicRoot,
  verifyPublicRoot,
  activatePublicRoot,
  RAW_BASELINE_OID,
} from "./lib/public-history.mjs";

const ROOT_DIR = ".";
const STATE_FILE = ".local/state/public-tree.json";

async function readState() {
  const raw = await readFile(join(ROOT_DIR, STATE_FILE), "utf8").catch(() => null);
  if (!raw) return null;
  return JSON.parse(raw);
}

function printState(state) {
  if (!state) {
    console.log("No release state found.");
    return;
  }
  console.log("Release state:");
  console.log(`  phase:           ${state.phase}`);
  console.log(`  rawBaselineOid:  ${state.rawBaselineOid}`);
  if (state.treeOid)    console.log(`  treeOid:         ${state.treeOid}`);
  if (state.rootOid)    console.log(`  rootOid:         ${state.rootOid}`);
  if (state.pathCount)  console.log(`  pathCount:       ${state.pathCount}`);
  if (state.manifestDigest) console.log(`  manifestDigest:  ${state.manifestDigest}`);
  if (state.preparedAt) console.log(`  preparedAt:      ${state.preparedAt}`);
  if (state.activatedAt) console.log(`  activatedAt:     ${state.activatedAt}`);
}

async function cmdPrepare() {
  console.log("Preparing candidate public tree...");
  console.log(`  baseline: ${RAW_BASELINE_OID}`);
  const result = await preparePublicTree({ rootDir: ROOT_DIR });
  console.log("Candidate tree prepared:");
  console.log(`  treeOid:        ${result.treeOid}`);
  console.log(`  manifestDigest: ${result.manifestDigest}`);
  console.log(`  pathCount:      ${result.pathCount}`);
  console.log(`\nNext: review the candidate tree, then run:`);
  console.log(`  node tools/release-public-root.mjs inspect-candidate`);
}

async function cmdInspectCandidate() {
  const state = await readState();
  if (!state) { console.error("No release state. Run prepare first."); process.exit(1); }
  printState(state);
  if (state.phase === "candidate_prepared") {
    console.log(`\nTo approve:`);
    console.log(`  node tools/release-public-root.mjs approve-candidate`);
  }
}

async function cmdApproveCandidate() {
  const confirmation = "I HAVE REVIEWED THE CANDIDATE TREE AND APPROVE IT";
  console.log(`Approving candidate with confirmation: "${confirmation}"`);
  const result = await recordGateApproval(confirmation, ROOT_DIR);
  console.log(`Gate approved. New phase: ${result.phase}`);
  console.log(`\nNext: node tools/release-public-root.mjs create-root`);
}

async function cmdCreateRoot() {
  const authorName  = process.env.GIT_AUTHOR_NAME  || (await gitConfig("user.name")).trim();
  const authorEmail = process.env.GIT_AUTHOR_EMAIL || (await gitConfig("user.email")).trim();

  if (!authorName || !authorEmail) {
    console.error("Cannot determine Git author. Set GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL.");
    process.exit(1);
  }

  console.log(`Creating root commit as: ${authorName} <${authorEmail}>`);
  const result = await createPublicRoot({ authorName, authorEmail, rootDir: ROOT_DIR });
  console.log(`Root commit created: ${result.rootOid}`);
  console.log(`\nNext: node tools/release-public-root.mjs inspect-root`);
}

async function cmdInspectRoot() {
  const verification = await verifyPublicRoot(ROOT_DIR);
  console.log("Root commit verified:");
  console.log(`  rootOid: ${verification.rootOid}`);
  console.log(`  treeOid: ${verification.treeOid}`);
  console.log(`  message: ${verification.message}`);
  console.log(`\nTo approve: node tools/release-public-root.mjs approve-root`);
}

async function cmdApproveRoot() {
  const confirmation = "I HAVE REVIEWED THE PUBLIC ROOT AND APPROVE IT";
  console.log(`Approving root with confirmation: "${confirmation}"`);
  const result = await recordGateApproval(confirmation, ROOT_DIR);
  console.log(`Gate approved. New phase: ${result.phase}`);
  console.log(`\nNext: node tools/release-public-root.mjs activate-main`);
}

async function cmdActivateMain() {
  console.log("Activating public root on refs/heads/main...");
  const result = await activatePublicRoot(ROOT_DIR);
  console.log(`✓ Activated. refs/heads/main → ${result.rootOid}`);
  console.log(`  phase: ${result.phase}`);
  console.log(`\nNext: push, then verify production.`);
}

async function cmdVerifyActive() {
  const state = await readState();
  if (!state) { console.error("No state."); process.exit(1); }
  if (state.phase !== "active" && state.phase !== "activation_incomplete") {
    console.error(`State phase is ${state.phase}, not active.`);
    process.exit(1);
  }
  if (state.phase === "activation_incomplete") {
    console.error("Activation incomplete. Run: git reset --mixed refs/heads/main then verify-active.");
    process.exit(1);
  }
  // Verify root is still accessible
  const verification = await verifyPublicRoot(ROOT_DIR);
  console.log("✓ Active state verified:");
  printState(state);
  console.log(`  rootVerified: ${verification.rootOid}`);
}

// helper
async function gitConfig(key) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("git", ["config", "--get", key]);
    return stdout;
  } catch {
    return "";
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────
const COMMANDS = {
  "prepare":           cmdPrepare,
  "inspect-candidate": cmdInspectCandidate,
  "approve-candidate": cmdApproveCandidate,
  "create-root":       cmdCreateRoot,
  "inspect-root":      cmdInspectRoot,
  "approve-root":      cmdApproveRoot,
  "activate-main":     cmdActivateMain,
  "verify-active":     cmdVerifyActive,
};

const cmd = process.argv[2];
if (!cmd || !COMMANDS[cmd]) {
  console.error(`Usage: node tools/release-public-root.mjs <command>`);
  console.error(`Commands: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(1);
}

COMMANDS[cmd]().catch((err) => {
  console.error(`Error [${err.code || "UNKNOWN"}]: ${err.message}`);
  process.exit(1);
});
