# B7 Historical Terminal Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for implementation, superpowers:verification-before-completion before any completion claim, and task-scoped independent review after GREEN.

**Goal:** 完成 B7 B2b 的只读 terminal classification：每个 historical target 只用自己的 commit-lock hash C 与 validated target layout，接受恰一个 exact C-bound completion 或 retirement；缺失保持 unresolved，冲突保持 ambiguous，且 current-owner alive 只在全部 historical targets 通过后返回。

**Architecture:** 让 `scanRecoveryTargetDirectory()` 返回已验证的 target/root-to-tip prefix evidence。把 B6 terminal object 构造收敛成由 `layout + C` 驱动的纯 helper，publisher 继续薄封装使用；B7 以 historical `target.json` decoded lock 自己的 validated layout 构造 exact expected bytes。`cleaning-transitions` 只读扫描按 C 隔离：unrelated attempts 和 same-plan other-C records 不进入当前 C 的 outcome set。扫描所得 directory/leaf identity 加入既有 recovery reproof；本 tranche 不发布、清理或修改任何 target、lease、pointer、terminal 或 fixed lock。

**Tech Stack:** Node.js 24.18.0、ES modules、`node:test`、canonical JSON、SHA-256、no-follow/private-leaf proofs、Graphify code graph。

## Global Constraints

- 按 `AGENTS.md` 直接在 `main` 工作，不创建 worktree。
- 所有 shell command 必须以 `rtk` 开头。
- 本任务不 stage、commit、push、deploy，也不写项目真实 `.local/`；测试只使用 synthetic temp roots。
- 继续遵守 B2a：historical missing `target.json` 的 recognized candidate content 是 opaque incomplete evidence，不能解析或借用其他 C 的 bytes。
- historical C 的唯一语义来源是它自己的 complete valid `target.json` decoded commit-lock bytes、hash C 和 validated layout；绝不使用 `context.layout` 或 fixed C2 layout 推导 C1 terminal。
- valid completion path 精确为 `complete-C-<C.desired_pointer_sha256>.json`，bytes 为 C layout 派生的 exact canonical `TransitionCompletion`。
- valid retirement path 精确为 `retire-C-<observed_sha256-or-absent>.json`，filename suffix、record field 与 C layout 派生的 exact canonical `TransitionRetirement` 必须一致。
- 恰一个 valid completion XOR 恰一个 valid retirement为 resolved；零个为 target-directory 级 `RECOVERY_UNRESOLVED_TARGET`；completion+retirement、多个 retirements、C-bound conflicting/malformed safe regular record 为 target-directory 级 `RECOVERY_TARGET_AMBIGUOUS`。
- filename/path type、exact private mode、no-follow identity、parent continuity 或 directory topology 违规仍为 precise-path `LOCAL_STATE_INVALID`；语义 malformed 与 filesystem unsafe 不混为一类。
- other-C records 不参与当前 C 的 outcome count；same-plan attempt A completion 不得使 attempt B retirement ambiguous。
- current root-to-tip chain 允许 terminal absent 或恰一个 exact C-bound terminal；current malformed/multiple C-bound outcome 必须在 `RECOVERY_OWNER_ALIVE` 前 fail closed。
- fixed owner alive 路径不得 mutation 或 repair fsync；必须先按 ASCII target-directory order 完成全部 historical classification 与 reproof。
- fixed absent 且全部 historical resolved 时沿用现有 state-dir fsync 后 `no_unresolved_target` 收束。
- 不实现 dead-owner successor lease、target/root publication、candidate cleanup、terminal publication、pointer mutation、fixed/target unlink 或 crash recovery writes；这些属于 Tranches C–E。

---

### Task 1: 以 TDD 实现 exact C-bound terminal selection

**Files:**
- Modify: `tests/corpus-cleaner.test.mjs`
- Modify: `tools/lib/clean-run-store.mjs`
- Verify: `docs/superpowers/specs/2026-07-27-brain-model-knowledge-system-design.md`

**Step 1: 增加测试 fixture 与 RED matrix**

新增 test-only canonical fixture helpers，必须独立从 lock intent/plan/C 构造 expected terminal，不调用 production private helper。

具名行为至少覆盖：

1. fixed absent + historical exact completion -> `no_unresolved_target`。
2. fixed absent + historical exact retirement（含 `absent` 或一个 observed hash）-> `no_unresolved_target`。
3. historical valid target/root-chain but no C terminal -> target-directory `RECOVERY_UNRESOLVED_TARGET`。
4. exact completion + exact retirement -> target-directory `RECOVERY_TARGET_AMBIGUOUS`。
5. two exact retirements with different observed suffixes -> target-directory `RECOVERY_TARGET_AMBIGUOUS`。
6. safe regular C-bound terminal with wrong canonical bytes、wrong desired/plan binding、filename/record suffix mismatch -> target-directory `RECOVERY_TARGET_AMBIGUOUS`。
7. C-bound terminal wrong mode、symlink、FIFO 或 socket -> precise terminal path `LOCAL_STATE_INVALID`，external referent unchanged。
8. same-plan attempts A/B with different lock bytes/C: A exact completion + B exact retirement -> both resolve and fixed-absent success；A record不得计入 B。
9. fixed C2 alive + historical C1 exact terminal + valid C2 prefix -> 先验证 C1，最后 `RECOVERY_OWNER_ALIVE` at fixed lock；writes/fsyncs empty、tree unchanged。
10. fixed C2 alive + historical C1 missing terminal -> C1 directory unresolved，优先于 owner alive；C2 bytes/inode/tree unchanged。
11. current root-chain + exact current C terminal -> owner alive zero-write；current C-bound malformed/multiple outcome -> ambiguous/local-invalid before owner alive。
12. transition directory或 terminal leaf same-byte identity replacement -> precise `LOCAL_STATE_INVALID`，external state unchanged。

每个失败/owner-alive case 都断言 exact code/path、`persistent_writes_occurred:false` 与 tree unchanged；owner-alive child probe 额外断言 `writes:[]`、`fsyncs:[]`。

**Step 2: 运行 RED**

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec --test-name-pattern='B7 historical C-bound terminal|B7 current C-bound terminal|B7 same-plan terminal isolation' tests/corpus-cleaner.test.mjs
```

Expected: exact completion/retirement success、ambiguous classification、C isolation 与 current exact-terminal cases 因 production 尚未扫描 terminals 而失败；missing-terminal unresolved 可作为既有 GREEN 对照。

**Step 3: 最小 GREEN**

- 把 B6 `completionRecord()` / `retirementRecord()` 收敛为 `layout + C` 的纯构造 helper，publisher 行为与 bytes 不变。
- `scanRecoveryTargetDirectory()` 返回 complete target、root presence 与 valid root-to-tip evidence；不改变既有结构错误路径。
- 只在需要判断 C outcome 时 no-follow 打开 `cleaning-transitions`，记录 directory names/identity 和读取 leaf proofs。
- 只选择稳定的 C-bound completion/retirement names；读取每个 C-bound leaf 后按 Global Constraints 分类。
- exact expected bytes 必须从 `target.validatedLock.layout` 与 target C 构造。
- 把 transitions directory/leaf 加入既有 `reproveRecoveryScan()`；不新增 mutation API。
- non-current resolved 后继续 ASCII scan；只有 missing/ambiguous/invalid 才在对应 target 立即返回。

**Step 4: focused 与结构验证**

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec --test-name-pattern='B7|recoverInterruptedCleaningCommit|recovery' tests/corpus-cleaner.test.mjs
rtk npx --yes node@24.18.0 --check tools/lib/clean-run-store.mjs
rtk npx --yes node@24.18.0 --check tests/corpus-cleaner.test.mjs
```

Expected: focused 全绿，语法检查零失败、零噪声；B2a opaque candidate、unsafe topology 与 identity-race cases 不回归。

**Step 5: 回归验证**

```bash
rtk npx --yes node@24.18.0 --test --test-reporter=spec tests/corpus-cleaner.test.mjs
rtk npx --yes node@24.18.0 --test --test-reporter=spec
```

Expected: file 与 full suite 零失败、零 warning/todo/skip；项目真实 `.local/` 不存在。

**Step 6: 独立审查与台账**

- 独立 reviewer 对照本计划、B7 规格和 working-tree no-index diff 审查 spec compliance 与 code quality。
- 若有 Critical/Important finding，回到同一 implementer 修复并做 scoped re-review。
- 审查通过后刷新 code-only Graphify，复核 C-bound selection graph 与隐私边界，更新主执行 ledger 和 Task 4B report。
- B2b 完成不等于整个 B7 完成；Tranches C–E 仍保持未完成。
