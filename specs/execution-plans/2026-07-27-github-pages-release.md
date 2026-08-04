# GitHub Pages Safe Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the reviewed single-file knowledge site to a new GitHub repository and GitHub Pages without exposing the existing repository history, local-only files, credentials, or an unreviewed build.

**Architecture:** Finish the workflow, documentation, tests, and deterministic build before freezing a release. Build one candidate Git tree from a literal public-path manifest through an isolated temporary index, inspect it against the empty tree, and create one parentless commit object without moving `main`. Gate 4A authorizes creation of that root object; Gate 4B authorizes an activation command that re-verifies the object database, manifest, source bytes, branch, ref, backup, and state immediately before a compare-and-swap ref update. Only the activated root is pushed to an empty remote. GitHub Actions repeats every test, check, build, drift, and leak gate before it uploads exactly `site/`; production is accepted only when the decoded HTTP body is byte-for-byte identical to local `site/index.html`.

**产品与设计权威：** 发布目标是「系统化思维」：`zjgulai/deep-thinking-mode` 与 `/deep-thinking-mode/`。资料隐私、安全、来源证据和单文件离线约束以 `2026-07-27-brain-model-knowledge-system-design.md` 为准；网站和 Pages 页面表现以 `2026-07-30-systematic-thinking-site-design.md` 为准。

**Tech Stack:** Node.js 24.18, built-in `node:test`, Git plumbing, GitHub CLI and REST API, GitHub Actions, GitHub Pages.

---

## Global Constraints

- Follow the repository `AGENTS.md`: run only on `main`, do not create a worktree, prefix every shell command with `rtk`, and do not make ordinary development commits.
- The known raw baseline is exactly `f876ce90d24ed486cae4060b1a4fe7b0813e9492`. Reject any live release whose initial `HEAD` differs.
- Preserve the raw baseline before activation as `.local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle`, then run `git bundle verify` on that exact file.
- Build the workflow, README, tests, release tooling, exact public-path manifest, and final `site/index.html` before the live candidate tree is frozen.
- The live release has one approved candidate tree and one parentless root commit. Do not amend it, create a follow-up commit, or perform a “metadata-only” second commit.
- Gate 4A authorizes creation of the root commit object only. It does not authorize moving `main`, creating a remote, pushing, configuring Pages, or deploying.
- Gate 4B authorizes activation of `main` only after the root object and its exact tree have been inspected. Remote creation, push, Pages configuration, and production deployment remain independent gates.
- Any content, workflow, manifest, author, mode, path, or build change after the candidate review invalidates the candidate and both approvals. Remove the release state and restart from the final local gate; never silently regenerate a replacement.
- Never use a worktree, the real Git index to assemble the public tree, `git add .`, `git add -A`, an implicit directory pathspec, `git commit`, `git commit --amend`, `git push --force`, or `git push --force-with-lease`.
- Do not use placeholder or abbreviated object IDs. Release state and reports contain the actual lowercase 40-hex OIDs read from Git.
- Every GitHub Action `uses:` value is a full 40-character commit SHA read from the checked-in pin configuration. Tags are review annotations only.
- The deploy job runs only when `github.ref == 'refs/heads/main'`, targets the protected `github-pages` environment, and is the only job granted `pages: write` and `id-token: write`.
- A manually dispatched run on any non-`main` ref may test and build, but deployment must be skipped.
- Local validation, remote emptiness, push success, Actions success, Pages deployment success, and production-byte equality are separate gates. Evidence for one must not be used as evidence for another.

## File Map

Create or modify only the release-related files below, plus the site files named by the single-file-site plan:

- Modify: `.gitignore`
  - Ignore `.local/` release state, backups, temporary indexes, downloaded production bodies, and diagnostics.
- Create: `tools/config/public-paths.json`
  - Versioned JSON containing the complete, literal, codepoint-sorted public file list.
- Create: `tools/config/github-actions-pins.json`
  - The five reviewed Action tags and their exact full commit SHAs.
- Create: `tools/lib/public-history.mjs`
  - Path-manifest validation, temporary-index tree creation, object verification, state validation, root creation, and compare-and-swap activation.
- Create: `tools/check-public-tree.mjs`
  - Public-only CI verifier that compares a Git tree with the literal path manifest and checks modes, object types, schemas, workflow bytes, obvious credential signatures, and site membership without pretending to have private raw fingerprints.
- Create: `tools/check-public-artifact.mjs`
  - Orchestrates the site HTML checker and Phase A artifact-scope verifier without shell chaining.
- Create: `tools/lib/pages-workflow.mjs`
  - Deterministically render the complete workflow bytes from the checked-in pin configuration.
- Create: `tools/release-public-root.mjs`
  - Thin CLI with `prepare`, `inspect-candidate`, `approve-candidate`, `create-root`, `inspect-root`, `approve-root`, `activate-main`, and `verify-active` commands.
- Create: `tools/verify-production.mjs`
  - Resolve the successful deployment for the activated root and compare decoded response bytes with `site/index.html`.
- Create: `tests/public-history.test.mjs`
  - Temporary-repository tests for the public-tree and root-activation invariants.
- Create: `tests/pages-workflow.test.mjs`
  - Full-file workflow snapshot and Action-pin tests.
- Create: `tests/production-verifier.test.mjs`
  - Local HTTP fixture tests for exact body-byte verification and failure diagnostics.
- Create: `.github/workflows/pages.yml`
  - Pinned, least-privilege, test-before-deploy Pages workflow.
- Modify: `README.md`
  - Local verification, release gates, manual dispatch behavior, public scope, recovery, and production verification.

## Public Tree Allowlist

`tools/config/public-paths.json` is the sole authority for membership in the public commit. It must contain the actual complete release set, including itself, as a JSON object with `version: 1` and a `paths` array. The array is not a category list or an example:

- Every entry is one literal repository-relative file path.
- Directory entries, globs, implicit recursion, pathspec magic, empty paths, absolute paths, backslashes, NUL, `.`/`..` segments, non-NFC paths, duplicate paths, and case-fold collisions are rejected.
- Paths are strictly increasing by Unicode code point, using the same explicit comparator as the site build. `localeCompare`, `Intl.Collator`, and locale-dependent sorting are forbidden.
- The manifest is converted to a NUL-delimited path list by trusted code and supplied to a temporary index. The JSON file is never passed directly as a Git pathspec.
- The recursively listed files in the candidate tree must equal the manifest array exactly: no omitted manifest path and no extra tree path.
- The `knowledge/` entries must equal `knowledge/manifest.json.public_files[].path` plus `knowledge/manifest.json` itself. The `site/` entries must equal `["site/index.html"]`. Static tooling, tests, workflow, package, README, and config paths are literal entries in the same manifest; no directory wildcard or undocumented dynamic path is allowed.
- Every leaf object must be a blob with mode `100644` or `100755`. Symlinks (`120000`), gitlinks (`160000`), non-blob leaf objects, and unexpected executable bits are rejected.
- Path checks and content checks are separate. Path checks enforce membership and normalization; content checks scan every candidate blob for actual local source values and credential signatures.
- Generate the content-deny set from live local values: the current workspace absolute path, user-home prefix, configured remote URLs, confirmed local email values that are not intended for publication, and discovered credential-like environment values. Also reject private-key headers, common access-token shapes, credential-bearing URLs, and NUL/binary content where a reviewed text file is expected.
- Never print a discovered secret. Diagnostics report only the rule, public path, byte offset or line, and a redacted digest.
- The plan documents may remain outside the public manifest. Their presence in the working directory never makes them public.

## Task 1: Build and Test the Public-History Safety Layer

**Files:**
- Modify: `.gitignore`
- Create: `tools/config/public-paths.json`
- Create: `tools/lib/public-history.mjs`
- Create: `tools/check-public-tree.mjs`
- Create: `tools/release-public-root.mjs`
- Create: `tests/public-history.test.mjs`

- [ ] **Step 1: Write the failing temporary-repository tests**

Cover these contracts:

- `loadPublicPathManifest()` rejects malformed JSON, unknown keys, non-version-1 data, empty or non-string paths, traversal, absolute paths, backslashes, pathspec magic, globs, directories, non-NFC values, duplicate values, case-fold collisions, and non-codepoint order.
- `preparePublicTree()` requires baseline `f876ce90d24ed486cae4060b1a4fe7b0813e9492`, uses a same-repository temporary index under `.local/`, writes exactly the manifest files, and leaves `HEAD`, `refs/heads/main`, the real index, and working files unchanged.
- Candidate inspection compares the recursive tree file list with the manifest and rejects extra paths, missing paths, wrong object types, modes other than `100644`/`100755`, symlinks, and gitlinks.
- Content review rejects actual workspace/home/remote values, credential-bearing URLs, private-key headers, representative token signatures, and binary NULs without echoing sensitive bytes.
- Candidate review imports Phase A `verifyPublicScope()` with `scope="git-ref"` against the candidate tree OID and the private baseline/current-pointer inputs. It first validates the pointer, then uses only its verified `catalog_path`; a raw hash, cleaned hash, or normalized private payload hit rejects the candidate. The public-only CI checker is an additional structural gate, not a substitute for this local private scan.
- Release state is written atomically with restrictive permissions and records actual values for `rawBaselineOid`, `approvedTreeOid`, `publicPathManifestSha256`, `cleanedWorktreeFingerprint`, the reviewed paths and modes, confirmed author, bundle path and digest, and phase.
- `createPublicRoot()` requires phase `candidate_approved`, the confirmed author identity, and the still-valid candidate. It creates one commit with the approved tree, fixed message, no parent, and no ref movement.
- `recordGateApproval()` accepts only the fixed confirmation strings named below, re-verifies the current state before changing its phase, and binds the approval to the full state-file SHA-256, tree/root OID, manifest digest, author, message, and source-byte fingerprint. It cannot accept a replacement OID from the command line.
- `verifyPublicRoot()` reads the commit and tree back from the object database and rejects a parent header, tree mismatch, author mismatch, message mismatch, malformed OID, missing object, manifest drift, candidate-byte drift, state tampering, or an unexpected phase.
- `activatePublicRoot()` accepts only phase `root_approved` and receives the approved tree, raw baseline, cleaned fingerprint, path-manifest digest, and root commit through validated state—not command-line OID placeholders.
- Activation rejects detached `HEAD`, a branch other than `main`, a symbolic-ref mismatch, dirty tracked candidate files, a changed real index, a changed public file, a changed manifest, invalid backup, missing object, root/tree mismatch, ref drift, and any failed re-verification.
- Activation loads the approved root OID from validated state and passes it as the new-value argument to `git update-ref refs/heads/main`, with `f876ce90d24ed486cae4060b1a4fe7b0813e9492` as the expected old value.
- A reset failure after a successful ref update is reported as `activation_incomplete`; it is never described as a rollback and does not trigger deletion of the root or an automatic reverse ref update.

- [ ] **Step 2: Run the focused test and confirm it fails for missing implementation**

```bash
rtk node --test tests/public-history.test.mjs
```

Expected: non-zero exit caused by the missing safety layer, not a test syntax or fixture error.

- [ ] **Step 3: Implement the minimum safety layer**

Use `spawn`/`execFile` argument arrays and check every exit code. Do not construct shell command strings.

`preparePublicTree()` must:

1. Confirm symbolic `HEAD` is `refs/heads/main` and resolves to the exact raw baseline.
2. Confirm the real index and working inputs have the expected pre-release fingerprint.
3. Load and validate the exact literal manifest.
4. Create and verify the full-SHA raw bundle at `.local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle`.
5. Create a fresh temporary index with `GIT_INDEX_FILE`; never point Git at the real index.
6. Add only the NUL-delimited literal manifest paths, write one candidate tree, and immediately remove the temporary index.
7. Read every candidate entry and blob back from the Git object database.
8. Re-run exact membership, path, mode, type, and redacted content-leak checks.
9. Run Phase A git-ref scope against the candidate tree with `.local/state/raw-baseline.json` and `.local/state/current-cleaning.json`; validate the pointer first and use only its verified `catalog_path`, requiring zero raw, cleaned, and normalized private-payload hits.
10. Fingerprint the current public source bytes and manifest.
11. Atomically persist `.local/state/public-tree.json` and print the actual tree OID, manifest SHA-256, path count, mode summary, private-scan input digests, leak summary, baseline OID, bundle digest, and author identity.

`createPublicRoot()` must be idempotent only for the already-recorded exact root. It must never create an alternate commit after state has recorded one.

`activatePublicRoot()` must execute this order internally, immediately before ref mutation:

1. Open and validate release state and its phase.
2. Re-read the symbolic branch and current `refs/heads/main`.
3. Re-read the root commit and candidate tree from the object database.
4. Verify the root has no parent and references the approved tree.
5. Reload the path manifest and verify its digest, order, membership, types, and modes.
6. Re-hash public working bytes and compare the cleaned fingerprint.
7. Re-run redacted content-leak checks.
8. Verify the raw baseline bundle and its digest.
9. Recheck the real index fingerprint and all expected author/message fields.
10. Perform one compare-and-swap `update-ref`.
11. Run the real-index/worktree reconciliation needed by the implementation without overwriting working files.
12. Verify the active ref, root, tree, index, worktree, manifest, and status again before recording phase `active`.

`update-ref` plus index reconciliation is not a transaction. If ref update succeeds and reconciliation fails, retain the root ref, mark `activation_incomplete`, print the exact recovery command `rtk git reset --mixed refs/heads/main`, and prohibit push until `verify-active` succeeds.

- [ ] **Step 4: Run the focused test**

```bash
rtk node --test tests/public-history.test.mjs
```

Expected: exit code 0 with zero failures.

## Task 2: Create the Exact Pages Workflow Before Freezing the Tree

**Files:**
- Create: `tools/config/github-actions-pins.json`
- Create: `tools/lib/pages-workflow.mjs`
- Create: `tools/check-public-artifact.mjs`
- Read: `tools/check-public-tree.mjs`
- Create: `tests/pages-workflow.test.mjs`
- Create: `.github/workflows/pages.yml`
- Modify: `package.json`

- [ ] **Step 1: Check in the reviewed Action pin configuration**

Use these exact values:

```json
{
  "actions/checkout": {
    "tag": "v6.1.0",
    "sha": "d23441a48e516b6c34aea4fa41551a30e30af803"
  },
  "actions/setup-node": {
    "tag": "v6.5.0",
    "sha": "249970729cb0ef3589644e2896645e5dc5ba9c38"
  },
  "actions/configure-pages": {
    "tag": "v5.0.0",
    "sha": "983d7736d9b0ae728b81ab479565c72886d7745b"
  },
  "actions/upload-pages-artifact": {
    "tag": "v4.0.0",
    "sha": "7b1f4a764d45c48632c6b24a0339c27f5614fb0b"
  },
  "actions/deploy-pages": {
    "tag": "v4.0.5",
    "sha": "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e"
  }
}
```

Tests reject non-lowercase or non-40-hex SHAs, missing or extra actions, duplicate pins, and any workflow `uses:` target that is not exactly the configured SHA. No tag, branch, abbreviated SHA, expression, or runtime-fetched value is accepted.

- [ ] **Step 2: Write a full-file workflow snapshot test**

`renderPagesWorkflow(pins)` returns the canonical complete YAML bytes. Compare those bytes with all of `.github/workflows/pages.yml`; do not assert isolated substrings.

The canonical workflow has:

- `push` restricted to `main` and an explicit `workflow_dispatch`.
- Top-level `permissions: { contents: read }`.
- `concurrency.group: pages` and `cancel-in-progress: false`.
- A `build` job on `ubuntu-latest` with pinned checkout (`fetch-depth: 1`, `persist-credentials: false`) and pinned setup-node (`node-version: 24.18.0`, `cache: npm`).
- Separate steps for `npm ci`, `npm test`, `npm run check`, `npm run build`, a failing drift gate equivalent to `git diff --exit-code -- site/index.html`, and `npm run check:public`.
- A separate public-tree step runs `node tools/check-public-tree.mjs --git-ref HEAD --manifest tools/config/public-paths.json`; it validates exact membership and modes from Git objects without requiring `.local/`.
- Pinned configure-pages and upload-pages-artifact steps; upload path is exactly `./site`.
- A `deploy` job with `needs: build` and `if: github.ref == 'refs/heads/main'`.
- `deploy.environment.name: github-pages` and its URL from the deployment step.
- Job-local `pages: write` and `id-token: write`; no other job has them.
- The pinned deploy-pages action and a stable deployment step id.

Add negative tests for tag pins, short SHAs, an unconfigured action, altered full-file YAML, changed triggers, a missing main guard, widened permissions, checkout credentials, omitted validation, artifact path other than `./site`, and a deploy job without `github-pages`.

- [ ] **Step 3: Run the focused test and confirm failure**

```bash
rtk node --test tests/pages-workflow.test.mjs
```

Expected: non-zero exit for missing workflow implementation only.

- [ ] **Step 4: Implement the renderer and write its exact output**

The renderer is deterministic and has no network behavior. The checked-in workflow may annotate each full SHA with its reviewed tag in a comment, but `uses:` contains the SHA.

Add `"check:public": "node tools/check-public-artifact.mjs"` to `package.json`. The orchestrator imports `checkSite()` and `verifyPublicScope({ scope: "artifact", artifactDir: "site" })`; it does not read `.local/`, spawn a shell, or claim to perform raw-fingerprint comparison in CI.

- [ ] **Step 5: Run the focused test**

```bash
rtk node --test tests/pages-workflow.test.mjs
```

Expected: exit code 0 with zero failures.

## Task 3: Finish Documentation and the Final Local Build

**Files:**
- Modify: `README.md`
- Create: `tools/verify-production.mjs`
- Create: `tests/production-verifier.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tools/config/public-paths.json`
- Generate: `site/index.html`

- [ ] **Step 1: Document the release boundary**

README must state:

- The public history is intentionally a single parentless commit assembled from the exact manifest.
- Local source history and non-manifest files are not included.
- `workflow_dispatch` on a non-`main` ref builds and validates only; production deployment is restricted to `main`.
- The exact local commands for install, test, check, build, public-tree check, and production-byte verification.
- Gate 4A, Gate 4B, remote creation, push/production, and production verification are separate approvals/evidence.
- A ref-update/index-reconciliation interruption is recovered with `rtk git reset --mixed refs/heads/main` followed by `verify-active`; it is not automatically rolled back.
- The site may be publicly reachable even if repository visibility is private, depending on GitHub account and organization settings.

- [ ] **Step 2: Test the production verifier**

Use local HTTP fixtures. Accept only status 200 whose decoded body bytes equal local `site/index.html`. Test redirects to the final Pages URL, gzip/content decoding, an HTML mismatch, same visible text with different bytes, stale content, 404, timeout, unexpected content type, and truncated response.

On mismatch, report local and remote SHA-256, lengths, final URL, status, content type, deployment commit, and first differing byte offset. Never treat matching title text, DOM text, asset names, or a manifest endpoint as a fallback success.

- [ ] **Step 3: Run the complete local gate twice**

First display local Git author values:

```bash
rtk git config --get user.name
rtk git config --get user.email
```

The user must confirm the exact author name and email before root creation. If either is absent or wrong, change only repository-local Git config after explicit confirmation; a verified GitHub no-reply address is acceptable. Record the confirmed values in release state.

Then run:

```bash
rtk npm ci
rtk npm test
rtk npm run check
rtk npm run build
rtk git diff --exit-code -- site/index.html
rtk npm run check:public
rtk npm run corpus -- verify-public --scope worktree --root . --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
rtk npm test
rtk npm run check
rtk npm run build
rtk git diff --exit-code -- site/index.html
rtk npm run check:public
rtk npm run corpus -- verify-public --scope worktree --root . --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
rtk git status --short --branch
```

Expected:

- Every command exits 0 with zero test failures.
- The two builds produce identical `site/index.html` SHA-256 values and byte lengths.
- The second build creates no diff.
- `site/` contains only `index.html`.
- The generated workflow still equals its canonical full-file rendering.
- All intended public files, including workflow, README, lockfile, test files, release tools, pin config, and the manifest itself, are present as literal entries in `tools/config/public-paths.json`.
- No file is staged and no commit has been created.

Display the full final manifest, codepoint order result, per-path mode, site SHA-256 and length, workflow SHA-256, test/check/build results, Git status, and confirmed author. Do not proceed on an unexplained file or drift.

## Task 4: Prepare and Inspect the Only Candidate Public Tree

**Files:**
- Read: `tools/config/public-paths.json`
- Read: all literal manifest paths
- Create locally: `.local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle`
- Create locally: `.local/state/public-tree.json`

- [ ] **Step 1: Prepare the candidate through the guarded CLI**

```bash
rtk node tools/release-public-root.mjs prepare --state .local/state/public-tree.json
```

The live command must create the verified raw bundle, build one tree through a temporary index, remove that index, and leave `HEAD`, `refs/heads/main`, the real index, and working files unchanged.

- [ ] **Step 2: Inspect from Git objects, not only working files**

```bash
rtk node tools/release-public-root.mjs inspect-candidate --state .local/state/public-tree.json
```

The report must show:

- Exact lowercase 40-hex baseline and candidate tree OIDs.
- SHA-256 of the exact `public-paths.json` bytes.
- The full recursive tree listing in codepoint order, with mode, type, blob OID, byte length, and blob SHA-256.
- Exact equality between the manifest list and tree list.
- `object_mode_violations: 0`, `symlink_or_gitlink_entries: 0`, `extra_paths: 0`, and `missing_paths: 0`.
- A tree diff against the empty tree, so every path in the root is visible.
- Site and workflow byte hashes.
- Redacted content-leak scan result.
- Raw bundle path, digest, and successful bundle verification.
- Confirmed Git author and the unchanged `main` ref.

Keep the complete report as Gate 4A evidence. Do not create another candidate tree to improve presentation.

### Gate 4A: Approval to Create the Root Object

- [ ] Ask the user to approve the displayed candidate tree OID, exact manifest digest/list, modes, site/workflow hashes, redacted leak result, raw backup, author, commit message, and no-parent requirement.

Approval authorizes only `create-root`. If any reviewed value changes, Gate 4A is void and the process returns to Task 3.

- [ ] After that exact approval is present in the task conversation, bind it to the unchanged candidate state:

```bash
rtk node tools/release-public-root.mjs approve-candidate --state .local/state/public-tree.json --confirm CREATE_APPROVED_PUBLIC_ROOT
```

The command must re-run candidate validation and write phase `candidate_approved` atomically. It must refuse if any candidate evidence differs from the report the user approved.

## Task 5: Create and Inspect the Root, Then Activate After Gate 4B

**Files:**
- Read and update locally: `.local/state/public-tree.json`
- Modify Git object database only during root creation
- Modify `refs/heads/main` and the real index only during approved activation

- [ ] **Step 1: Create the single root commit object after Gate 4A**

```bash
rtk node tools/release-public-root.mjs create-root --state .local/state/public-tree.json
```

The command must:

- Re-run candidate, manifest, byte, mode, type, leak, author, baseline, and backup verification.
- Refuse unless state records Gate 4A approval for the exact tree.
- Create one commit object with the approved tree, the confirmed author/committer, the reviewed fixed message, and no parent.
- Persist the actual root OID atomically.
- Leave `HEAD`, `refs/heads/main`, the real index, and working files unchanged.

- [ ] **Step 2: Inspect the root object**

```bash
rtk node tools/release-public-root.mjs inspect-root --state .local/state/public-tree.json
```

Show the complete decoded commit headers/message, exact root and tree OIDs, explicit parent count zero, author/committer, manifest digest/list, recursive tree/modes, diff against the empty tree, site/workflow hashes, leak result, bundle verification, and proof that `main` still points to `f876ce90d24ed486cae4060b1a4fe7b0813e9492`.

Run object verification twice. Both reports must identify the same existing root object; the second check must not call `commit-tree` or create a replacement.

### Gate 4B: Approval to Activate `main`

- [ ] Ask the user to approve the exact root commit OID and the entire inspection report. State plainly that activation moves local `main` from `f876ce90d24ed486cae4060b1a4fe7b0813e9492` to that parentless root; it does not create a remote or push.

- [ ] After that exact approval is present in the task conversation, bind it to the unchanged root state:

```bash
rtk node tools/release-public-root.mjs approve-root --state .local/state/public-tree.json --confirm ACTIVATE_APPROVED_PUBLIC_ROOT
```

The command must decode and verify the existing root again, confirm `main` still equals the raw baseline, and write phase `root_approved` atomically. It must not create a commit or move a ref.

- [ ] **Step 3: Activate with internal full re-verification and CAS**

```bash
rtk node tools/release-public-root.mjs activate-main --state .local/state/public-tree.json
```

The command must perform all twelve activation checks from Task 1 internally in the same process, then compare-and-swap `refs/heads/main` from the exact raw baseline to the exact state root. It must not trust the earlier report or accept OIDs from free-form arguments.

- [ ] **Step 4: Verify the active repository**

```bash
rtk node tools/release-public-root.mjs verify-active --state .local/state/public-tree.json
rtk git status --short --branch
```

Expected:

- `main` resolves to the inspected root.
- The root has zero parents and references the approved tree.
- Manifest, tree, modes, object types, public working bytes, site/workflow hashes, author/message, and leak scan still match.
- The raw bundle still verifies.
- No second commit exists.
- The real index is reconciled without overwriting working files.
- Any non-public local file remains untracked or ignored and is absent from the root.

If activation is incomplete, do not continue. Run only the reported recovery command, then repeat `verify-active`.

## Task 6: Verify GitHub Identity, Empty Remote, Pages, and Environment

**Files:**
- Read: `.local/state/public-tree.json`
- Remote state: target GitHub repository, Pages settings, and `github-pages` environment

- [ ] **Step 1: Resolve identity and target ownership**

```bash
rtk gh auth status
rtk gh api user --jq .login
rtk gh repo view zjgulai/deep-thinking-mode --json nameWithOwner,visibility,isEmpty,url,defaultBranchRef,isArchived,viewerPermission
rtk git ls-remote https://github.com/zjgulai/deep-thinking-mode.git
rtk git remote -v
```

Require authenticated login `zjgulai`, repository `zjgulai/deep-thinking-mode`, `isArchived=false`, write/admin permission, and zero remote refs. Display the actual visibility rather than inferring it. Explain again that Pages reachability can be public even when repository visibility is private.

- [ ] **Step 2: Bind the already-created empty target only after explicit remote approval**

The user has stated that `zjgulai/deep-thinking-mode` already exists as an empty repository. If it is missing, stop and ask the user; this plan does not create a replacement repository.

Abort if any branch, tag, release seed, default commit, archived state, owner mismatch, or insufficient permission is found. Never overwrite or force-push a non-empty repository.

Configure `origin` only after the exact URL and owner are displayed and approved:

```bash
rtk git remote add origin https://github.com/zjgulai/deep-thinking-mode.git
rtk git remote get-url origin
```

If any remote already exists, stop instead of replacing it. The re-read URL must equal the approved HTTPS URL exactly.

- [ ] **Step 3: Verify Pages build mode**

Read the Pages settings:

```bash
rtk gh api -i repos/zjgulai/deep-thinking-mode/pages
rtk gh api repos/zjgulai/deep-thinking-mode/pages --jq .build_type
```

A `404` means Pages is not configured; handle that state explicitly rather than treating it as success.

The user will select GitHub Actions in Settings → Pages. After that explicit external action, re-read settings and require the returned `build_type` to equal `workflow`. Do not accept legacy branch publishing or silently mutate the setting.

- [ ] **Step 4: Verify the deployment environment**

Require an environment named exactly `github-pages`. Its deployment branch/tag policy must allow only branch `main`; a broad “all branches and tags” policy is a failure. If the environment or exact rule is absent, stop for the user to configure it in GitHub. Do not silently weaken or auto-create protection. An optional required reviewer may be enabled by the user.

Re-read and report the effective environment protection and selected-branch rule before push:

```bash
rtk gh api repos/zjgulai/deep-thinking-mode/environments/github-pages
rtk gh api repos/zjgulai/deep-thinking-mode/environments/github-pages/deployment-branch-policies
```

- [ ] **Step 5: Repeat local active-root verification**

```bash
rtk node tools/release-public-root.mjs verify-active --state .local/state/public-tree.json
```

This verifies identity/remote/Pages work did not alter the approved local root.

## Task 7: Push and Production Deployment Gate

**Files:**
- Read: active local root and release state
- Remote mutation: push `main` once to the verified empty repository

- [ ] **Step 1: Present the final production gate**

Display together:

- Authenticated GitHub login, target owner/name, repository visibility, and exact origin URL.
- Proof that the remote has no branches or tags.
- Exact active root and tree OIDs, zero parents, manifest SHA-256 and full list, modes and types.
- Site/workflow hashes and deterministic-build evidence.
- Exact five Action pins.
- `build_type: workflow`.
- The `github-pages` environment and main-only deployment rule.
- Local test/check/build/public-check results.
- Raw bundle path/digest and successful verification.
- The exact command that will push `main`.

Ask for explicit production approval. Do not interpret Gate 4A or Gate 4B as push approval.

- [ ] **Step 2: Recheck all mutable inputs immediately before push**

```bash
rtk node tools/release-public-root.mjs verify-active --state .local/state/public-tree.json
rtk npm test
rtk npm run check
rtk npm run build
rtk git diff --exit-code -- site/index.html
rtk npm run check:public
```

Re-read remote emptiness, identity, origin, Pages build type, and environment rules after these commands. Abort on drift.

- [ ] **Step 3: Push without force**

Push the active `main` to the still-empty `origin` with the ordinary upstream-setting push:

```bash
rtk git push --set-upstream origin main
```

After push, verify remote `main` resolves to the same actual root OID from release state. Do not create a tag, release, or follow-up commit.

## Task 8: Observe Actions and Verify Exact Production Bytes

**Files:**
- Read: `.github/workflows/pages.yml`
- Read: `site/index.html`
- Create locally: `.local/state/production-index.html`
- Create locally on failure: `.local/diagnostics/`

- [ ] **Step 1: Observe the run tied to the pushed root**

Find the workflow run whose workflow path is `.github/workflows/pages.yml`, event is the actual push to `main`, and `head_sha` equals the active root OID read from state. Do not accept a run for another commit or a merely recent run.

Require:

- Build job success.
- Tests, check, build, drift, and public-tree gates all success.
- Artifact upload success from exactly `./site`.
- Deploy job success under `github-pages`.
- Pages deployment reports the same commit and a concrete page URL.

On failure, capture job/step conclusions and logs, diagnose, and stop. Any source or workflow fix requires a new explicit release cycle; do not add a second commit to this public root.

- [ ] **Step 2: Compare production body bytes**

```bash
rtk node tools/verify-production.mjs --state .local/state/public-tree.json --local site/index.html --output .local/state/production-index.html
```

The verifier must:

1. Resolve the successful Pages deployment associated with the active root.
2. Fetch its concrete page URL with bounded retries and cache bypass.
3. Follow only safe HTTPS redirects to the expected GitHub Pages host.
4. Require final status 200 and an HTML content type.
5. Read the decoded response body as bytes.
6. Compare it byte-for-byte with local `site/index.html`.
7. Report matching SHA-256 and length plus the deployment root OID and final URL.

Production passes only on exact byte equality. There is no marker, title, DOM-text, manifest, screenshot, or “visually correct” fallback.

If bytes differ, fail and report diagnostic hashes, lengths, headers, deployment/root identity, and first differing offset. Preserve the downloaded body under `.local/` for diagnosis, but never modify local source or create a commit.

- [ ] **Step 3: Final report**

Report only confirmed evidence:

- Target repository and visibility.
- Active parentless root and tree OIDs.
- Manifest digest and path count.
- Workflow run and Pages deployment identifiers.
- Pages `build_type`.
- Environment main-only rule.
- Production URL.
- Local and production SHA-256 and byte length, explicitly equal.
- Backup bundle path and digest.
- No second commit.

Do not claim publication if the workflow, deployment, or exact-byte check is incomplete.

## Completion Criteria

The release is complete only when all of the following are simultaneously true:

- The public repository contains one parentless commit and no earlier history.
- Its tree equals the reviewed literal manifest exactly.
- The only Pages artifact content is `site/index.html`.
- Every workflow action uses the reviewed full SHA.
- The deployment ran from `main` under the protected `github-pages` environment with `build_type: workflow`.
- The successful workflow and Pages deployment both identify the active root.
- The production HTML body bytes exactly equal local `site/index.html`.
- The raw baseline bundle verifies and remains outside the public tree.
- No second commit, force push, tag, or unreviewed file was created.

## Official References

- GitHub Pages custom workflows: <https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages>
- `actions/checkout` reviewed commit: <https://github.com/actions/checkout/commit/d23441a48e516b6c34aea4fa41551a30e30af803>
- `actions/setup-node` reviewed commit: <https://github.com/actions/setup-node/commit/249970729cb0ef3589644e2896645e5dc5ba9c38>
- `actions/configure-pages` reviewed commit: <https://github.com/actions/configure-pages/commit/983d7736d9b0ae728b81ab479565c72886d7745b>
- `actions/upload-pages-artifact` reviewed commit: <https://github.com/actions/upload-pages-artifact/commit/7b1f4a764d45c48632c6b24a0339c27f5614fb0b>
- `actions/deploy-pages` reviewed commit: <https://github.com/actions/deploy-pages/commit/d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e>
