# B7 Incomplete Evidence Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for implementation, superpowers:verification-before-completion before any completion claim, and task-scoped independent review after GREEN.

**Goal:** 用第一性原理落实 B7 的不完整证据策略：historical target 在 `target.json` 缺失时不从 candidate bytes 猜语义，只做可观察结构验证并零写入返回 unresolved；完整对象和当前已知 C 继续严格验证。

**Architecture:** 删除只服务于 historical incomplete candidate 的增量 Base64→bytes→UTF-8/JSON/schema 推断链。`scanRecoveryTargetDirectory()` 仍统一验证 candidate filename、private regular mode、no-follow identity、parent continuity 与 topology；当 expected target bytes 不可得时，content 不参与语义分类。当 current fixed C 或 durable `target.json` 提供 exact expected bytes 时，继续使用 `classifyPlannedBytes()` 做 exact-prefix 验证。完整 `target.json` 继续由现有 canonical/schema/base64/hash/directory-C/CommitLockIntent 验证器处理。

**Tech Stack:** Node.js 24.18.0、ES modules、`node:test`、canonical JSON、SHA-256、Graphify code graph。

## Global Constraints

- 按 `AGENTS.md` 直接在 `main` 工作，不创建 worktree。
- 所有 shell command 必须以 `rtk` 开头。
- 本任务不 stage、commit、push、deploy，也不写项目真实 `.local/`；测试只使用 synthetic temp roots。
- historical target + missing `target.json` + recognized/private/regular/stable candidate：candidate bytes 为 opaque incomplete evidence，结果必须是 target-directory 级 `RECOVERY_UNRESOLVED_TARGET`、`persistent_writes_occurred:false`、tree byte-for-byte unchanged。
- filename、PID/nonce、type、exact `0600` mode、identity、parent continuity 或 topology 违规仍为 `LOCAL_STATE_INVALID`。
- current fixed C 或 durable `target.json` 已知 expected bytes 时，candidate 必须为 exact prefix；不匹配仍为 candidate-path 级 `LOCAL_STATE_INVALID`。
- durable `target.json` 仍必须通过 canonical single-LF、strict Base64、hash、directory C、exact `CommitLockIntent` 与 current fixed binding 验证。
- 不实现增量 Base64、UTF-8、canonical JSON 或 schema recognizer；删除因此不再可达的 parser/helper 与大 Buffer allocation。
- 测试验证公开行为，不 grep production source text。

---

### Task 1: 以 TDD 落实 opaque historical candidate 合同

**Files:**
- Modify: `tests/corpus-cleaner.test.mjs`
- Modify: `tools/lib/clean-run-store.mjs`
- Verify: `docs/superpowers/specs/2026-07-27-brain-model-knowledge-system-design.md`

**Step 1: 写/收敛行为测试**

- 将 historical missing-target candidate matrix 收敛为代表性内容：canonical partial、arbitrary garbage、terminal-looking invalid Base64、invalid UTF-8。四者都必须返回 target-directory 级 `RECOVERY_UNRESOLVED_TARGET`，且 tree unchanged。
- 保留并确认 unsafe mode、symlink、FIFO、socket、unknown topology 仍 fail closed。
- 增加或保留 current fixed C 的反例：recognized/private/regular candidate 若不是 exact expected target prefix，必须返回 candidate-path 级 `LOCAL_STATE_INVALID`。
- 保留完整 `target.json` 的 canonical/base64/hash/directory-C/fixed-binding 严格反例。

**Step 2: 运行 RED**

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec --test-name-pattern='B7 historical missing-target candidates|B7 current target candidate' tests/corpus-cleaner.test.mjs
```

Expected: 至少 historical arbitrary/invalid-content cases 因旧增量解析器返回 `LOCAL_STATE_INVALID` 而失败；current exact-prefix 安全反例可保持 GREEN。

**Step 3: 最小 GREEN**

- `expectedTargetBytes === null` 时不检查 candidate content semantics。
- `expectedTargetBytes !== null` 时继续 `classifyPlannedBytes(leaf.bytes, expectedTargetBytes) !== "invalid"`。
- 删除仅被 historical incomplete-content inference 使用的 helper/constants；保留完整 target validation 所需的 `decodeStrictBase64()`、`makeRecoveryTargetDocumentBytes()` 与 `validateRecoveryTargetDocument()`。

**Step 4: focused 与结构验证**

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec --test-name-pattern='B7|recoverInterruptedCleaningCommit|recovery' tests/corpus-cleaner.test.mjs
rtk npx --yes node@24.18.0 --check tools/lib/clean-run-store.mjs
rtk npx --yes node@24.18.0 --check tests/corpus-cleaner.test.mjs
```

Expected: focused 全绿，语法检查零失败、零噪声。

**Step 5: 回归验证**

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec tests/corpus-cleaner.test.mjs
rtk npx --yes node@24.18.0 --test --test-reporter=spec
```

Expected: file 与 full suite 零失败；输出无 warning/todo/skip，项目真实 `.local/` 不存在。

**Step 6: 独立审查与台账**

- 独立 reviewer 对照本计划、规格和 working-tree change package 审查 spec compliance 与 code quality。
- 若有 Critical/Important finding，回到同一 implementer 修复并做 scoped re-review。
- 审查通过后更新主执行 ledger 与 Task 4B report；仍不得把 B7 B2a 完成误报为整个 B7 完成。
