# B7 Recovery Lease and Stale Retirement Implementation Plan

**Goal:** 完成 B7 Tranche C 的最小完整纵切：仅在 fixed commit-lock 原 owner 已确认死亡、全部 historical targets 已通过 B2b 分类后，为 current C 持久发布 `target.json`、取得 root 或 successor recovery lease、按 owner liveness 规则清理 recognized candidate residue，并在 current pointer 为 stale 时发布 exact C-bound retirement、移除 fixed lock、fsync state directory，返回 `stale_lock_retired`。

**Architecture:** 沿用 B2b 的 ordered namespace scan 作为所有写入前的证据门。Recovery actor 使用本进程 PID 与随机 nonce；写入 authority 不是原 publisher lock ownership，而是 `fixed C exact bytes/inode + current target exact bytes/inode + complete root-to-tip chain + active tip PID/nonce + deterministic successor absent`。Target、lease 和 terminal 都使用 private same-directory candidate、file fsync、no-clobber hard-link、directory fsync、same-inode proof、candidate unlink、directory fsync。Lease nodes 与 target directory 保持 append-only audit evidence。

**Tech Stack:** Node.js 24.18.0、ES modules、`node:test`、canonical JSON、SHA-256、no-follow identity proofs、Graphify code graph。

## Global Constraints

- 按 `AGENTS.md` 直接在 `main` 工作，不创建 worktree。
- 所有 shell command 必须以 `rtk` 开头。
- 本 tranche 不 stage、commit、push、deploy，也不写项目真实 `.local/`；测试只使用 repository 外 synthetic temp roots。
- Initial original-owner gate 必须发生在任何 recovery write 前。`kill(pid, 0)` success/`EPERM` 为 alive，返回 `RECOVERY_OWNER_ALIVE` 且零写；只有 `ESRCH` 可继续，其他错误 fail closed。
- 全部 historical targets 必须先按 ASCII 顺序通过 B2a/B2b。Current C 之外的 target 不得被取得、清理或修改。
- 若 recovery directory creation 已发生，发布 root lease 前必须再次验证 fixed C 并重做 original-owner gate。
- Target candidate 精确为 `.target.<pid>.<nonce>.tmp`；lease candidate 精确为 `.lease-<root-or-parent-hash>.<pid>.<nonce>.tmp`。
- Candidate owner success/`EPERM` 时不得清理，返回 `CLEANING_RECOVERY_LOCKED`；只有 `ESRCH` 可在 exact path/inode/bytes/link-count/parent proof 后 unlink candidate 并立即 fsync target directory。
- Dead candidate 的 node absent、same inode、different inode 三种状态都只允许 unlink candidate；永不 unlink、覆盖或重写 canonical target/lease node。
- Root lease 必须是 generation 0 / previous null；successor 必须绑定 exact tip hash并 generation + 1。每个 parent 只有一个 deterministic successor path。
- 每次 pointer/terminal/fixed-lock mutation 前必须重验 current target、full chain、active tip owner 为 caller、successor absent 与 fixed C。
- Stale pointer 分支绝不 rename pointer。它只发布 C-bound retirement，随后 unlink fixed lock 并 fsync `.local/state`。
- `persistent_writes_occurred` 从第一次成功 mkdir/create/write/link/unlink 起 sticky；fsync 本身不把 false 改为 true。
- C 不删除 recovery target directory、`target.json` 或 lease nodes。

## Explicit D/E Boundary

- Tranche D：current pointer 已是 exact desired 时的 C-bound completion reuse/publication、已有 terminal 的 crash/retry cleanup、fixed lock 已 absent 的 post-terminal durability 收束。
- Tranche E：current pointer 为 exact expected prior 时的 pointer temp/rename/fsync commit、pointer race/I/O/crash matrix与最终跨进程 contention closure。
- C 不发布 completion、不 rename pointer、不把 partial success 暴露为 success。

---

### Task 1: 建立独立 RED contract

**Files:**

- Modify: `tests/corpus-cleaner.test.mjs`
- Verify: `tools/lib/clean-run-store.mjs`

增加 test-only fixtures 与 child probes，expected target/lease/retirement bytes 必须由测试独立构造，不调用 production private helper。

最小 RED 矩阵：

1. fixed owner `ESRCH`、recovery root absent、valid stale pointer：创建 exact target + generation-0 root lease，写 exact C-bound retirement，pointer bytes/inode 不变，fixed lock 被 unlink+state fsync，返回 exact `stale_lock_retired`。
2. target-only current prefix：复用 exact target，不覆盖它，取得 root lease后完成同一 stale 纵切。
3. existing dead root tip：只在 `lease-after-<root_sha256>.json` 竞争 generation 1，取得 successor 后完成 stale 纵切。
4. tip owner success/`EPERM`：返回 `CLEANING_RECOVERY_LOCKED`，不清理 tip/node；若调用前无 C mutation则 `persistent_writes_occurred:false`。
5. live target/lease candidate success/`EPERM`：返回 locked，candidate/tree 不变。
6. dead target candidate在 canonical node absent/same inode/different inode 三种状态只删除 candidate并 fsync target dir；canonical node不删除、不覆盖。
7. dead root/successor lease candidate在 node absent/same inode/different inode三种状态遵循相同规则。
8. candidate same-byte identity drift或parent replacement：precise-path `LOCAL_STATE_INVALID`，外部 referent/sentinel不变。
9. no-clobber loser验证 exact winner；winner malformed/alternate/fork fail closed，不形成第二 canonical child。
10. historical C1 resolved + fixed C2 dead：所有写入只能位于 C2 target/terminal path，C1 tree/inodes不变。
11. stale retirement前 active-tip/fixed/target/successor发生漂移：不 unlink fixed lock，不 rename pointer，返回 precise failure。
12. representative mkdir、candidate sync/link/dir-sync/cleanup、terminal link、fixed unlink/state-fsync failure具有正确 operation/path 与 sticky writes。

运行：

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec --test-name-pattern='B7 C ' tests/corpus-cleaner.test.mjs
```

Expected RED：现有 production 在 original owner `ESRCH` 后仍返回 fixed-lock `LOCAL_STATE_INVALID`；stale success、lease ownership、candidate cleanup 与 durability probes失败。既有 B2a/B2b只读安全对照保持 GREEN。

---

### Task 2: 实现 durable current target 与 recovery lease ownership

**Files:**

- Modify: `tools/lib/clean-run-store.mjs`
- Modify: `tests/corpus-cleaner.test.mjs`

最小 production 结构：

1. 让 current target scan 返回 immutable target/root-to-tip/candidate evidence，而不是只返回 `rootPresent`。
2. 增加 recovery actor 与 recovery-specific authority proof；不得把 B6 publisher 的 `reproveOwnedCommitLock()` 当成 active lease proof。
3. 以 non-recursive mkdir + immediate parent fsync 确保 recovery root 与 current C directory；每个 mutation 前后重验 fixed C 和 ancestor identities。
4. 按 exact target bytes发布或复用 `target.json`；canonical target存在时永不覆盖。
5. 两阶段处理 candidates：先验证全部结构和 owner liveness；任一 live/EPERM candidate先 locked，只有全部可清理 candidate均为 ESRCH 后才逐个稳定 unlink/fsync。
6. Root absent 时竞争 generation 0；root present时验证 tip owner，alive/EPERM locked，ESRCH才竞争唯一 successor。
7. no-clobber loser清理自己的 candidate并读取 exact winner；winner有效且 alive时 locked，winner dead时只能从该 winner继续下一 generation。

成功取得 lease 后保存 active tip path/bytes/hash/leaf proof和target/full-chain proof，供 terminal 与 fixed-lock cleanup重验。

---

### Task 3: 完成 stale-pointer retirement 纵切

**Files:**

- Modify: `tools/lib/clean-run-store.mjs`
- Modify: `tests/corpus-cleaner.test.mjs`

1. 取得 active lease 后 stable no-follow读取 current pointer并按 fixed C layout分类。
2. `stale` 时使用 `retirementRecord(layout, C, observed_hash_or_null)` 构造 exact actor-neutral bytes/path。
3. 把 terminal publication抽为可接受 recovery authority callback的 durable primitive；B6 publisher既有 bytes、path和行为不得改变。
4. Terminal durable且 transitions directory fsync 后，重验 terminal、fixed C、target、full chain、active tip与successor absent。
5. 只 unlink fixed commit lock，确认 absent，再 fsync `.local/state`；此后不再写 pointer或terminal。
6. 返回 exact frozen success：

```js
{
  kind: "stale_lock_retired",
  selected_target_commit_lock_sha256: C,
  current_fixed_commit_lock_sha256: C,
  active_lease_path: activeTipPath,
  final_pointer: observedPointerOrNull,
  transition_record_path: retirementPath,
  commit_lock_cleanup: "unlinked_and_fsynced",
  persistent_writes_occurred: true
}
```

`expected_prior` 暂时 fail closed并留给 E；`desired` 若没有可安全完成的 D terminal/cleanup证据也暂时 fail closed，不得误报 C success。

---

### Task 4: 聚焦回归、独立审查与修复

运行：

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec --test-name-pattern='B7 C ' tests/corpus-cleaner.test.mjs
rtk npx --yes node@24.18.0 --test --test-reporter=spec --test-name-pattern='B7|recoverInterruptedCleaningCommit|recovery' tests/corpus-cleaner.test.mjs
rtk npx --yes node@24.18.0 --check tools/lib/clean-run-store.mjs
rtk npx --yes node@24.18.0 --check tests/corpus-cleaner.test.mjs
```

- 独立 reviewer 对照长期规格、本文和 working-tree no-index diff审查 spec compliance、mutation authority、race window 与code quality。
- Critical/Important finding必须回到同一实现修复，并由原 reviewer做 scoped re-review。
- 审查通过不等于整个 B7完成；D/E继续保持 open。

---

### Task 5: 文件级、全项目、Graphify 与边界审计

运行：

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec tests/corpus-cleaner.test.mjs
rtk npx --yes node@24.18.0 --test --test-reporter=spec
```

验收：

- focused、file、full suite均 0 fail/skip/todo；Node 24 syntax与effective whitespace clean。
- 真实 repository `.local/` 不存在，测试只修改 synthetic roots。
- 刷新 code-only Graphify，确认 recovery acquisition→active authority→retirement→fixed cleanup关系可追踪，且 graph artifacts仍被忽略并通过私有路径扫描。
- 更新主执行 ledger、B7 Task 4B report和长期开发记录。
- 最后重验 `main`、HEAD、index、remote、`.local/`、commit/push/deploy边界。
