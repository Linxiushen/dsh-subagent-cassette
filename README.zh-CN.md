# dsh-subagent-cassette

[![CI](https://github.com/Linxiushen/dsh-subagent-cassette/actions/workflows/ci.yml/badge.svg)](https://github.com/Linxiushen/dsh-subagent-cassette/actions/workflows/ci.yml)

[English](README.md) | 简体中文

为 DeepSeek Harness one-shot Subagent 调用提供基于拓扑的 VCR 式录制与离线回放。

`dsh-subagent-cassette` 会注册一个独立的 `SubagentProvider`。录制模式把调用委托给 `spawn` 等真实 provider，并保存最终边界结果；回放模式不调用上游 provider、模型或网络，而是严格匹配实时拓扑、可观察父上下文和请求，返回已录制的结果或基础设施错误。

> 兼容范围：当前版本精确面向 `@deepseek-ai/dsh-subagent` **`0.1.0-rc.7`** 及同版本 DSH 包族，不承诺兼容后续 RC。

## 为什么需要它

并发 sibling subagent 的完成顺序不是稳定身份。两个 child 可能按 A/B 启动、按 B/A 完成，回放时调度顺序还可能再次变化。本项目使用以下组合键匹配调用：

```text
稳定父拓扑路径
+ SHA-256（可观察父上下文的 canonical JSON）
+ SHA-256（规范化请求的 canonical JSON）
```

因此，只要 sibling 的请求不同，它们就可以改变完成顺序或回放调用顺序，而不会串换结果。这个保证有意保持严格和有限：

- 可观察父上下文和规范化请求必须能被精确复现；
- 一个 cassette 表示一个逻辑顶层 root；
- 同一 parent 和父上下文下的完全相同请求属于同一 occurrence 组；
- 如果完全相同的请求录到了不同结果，默认拒绝回放；
- 只有显式设置 `duplicatePolicy: sequence`，才会接受按 occurrence 顺序匹配这种歧义情况。

它是严格的 Subagent 边界回放，不是通用 Session 模拟器，也不声称整个 Agent 运行具备全局确定性。

## 能力

- 包装任意已注册的 one-shot provider，不替换真实 provider。
- 离线回放不需要上游 provider、模型凭据或网络。
- 按父拓扑、父上下文和请求指纹匹配并发 sibling，不依赖完成顺序。
- 录制成功、发布前启动失败、发布后基础设施失败、边界耗时，以及观察到的取消和 dispose 时点。
- 默认只存请求元数据；完整 prompt 必须显式开启。
- 对持久化数据应用常见凭据模式及自定义正则脱敏。
- 默认拒绝回放被脱敏改写过的成功结果，因为 `[REDACTED]` 已不再是原始数据。
- 使用带版本号的 JSONL 和 SHA-256 前向 hash 链。
- create、truncate、append 全程持有跨进程独占 writer lock。
- 提供只输出元数据的 `verify`、`inspect` 和严格 cassette `diff` CLI。
- 对精确回放不匹配返回结构化、metadata-safe 的诊断。
- 默认在 replay 卸载时检查 cassette 是否全部消费。

## 非目标与当前限制

- 仅支持 one-shot `SubagentProvider.start()` 边界。Continuable child、follow-up、冷恢复和 continuation manager 均不在范围内。
- 回放始终返回 `localAgent: undefined`，不会重建本地 child Agent 或 Session。
- 录制时，如果上游 run 暴露 `localAgent`，且后续嵌套调用也走 cassette provider，可以为嵌套调用建立稳定路径；离线回放仍直接返回外层边界结果，不会重新执行这棵 child 树。如果 cassette 还要求独立消费嵌套调用，最终可能出现未消费记录。
- 一个 recording provider 生命周期内只接受一个顶层 parent 身份。每个独立 root 场景应使用单独 cassette。
- 不支持模糊匹配、语义匹配或仅按 label 匹配。
- 父上下文匹配覆盖 DSH 官方 in-process provider 使用的稳定公开状态。第三方 provider 仍可能读取额外 Cordis service 或外部状态；本项目无法观察这些隐藏输入，因此回放不证明它们没有变化。
- hash 链只是完整性诊断，不是认证机制。写入者可以重算整条链；没有外部尾部锚点时，也无法证明完整有效的文件后缀没有被删除。
- 不包含 dashboard、benchmark DSL、LLM judge 或通用 DSH Session replay。

## 从源码安装

当前文档按源码或本地 tarball 安装编写，**不假设 npm 已经发布**。

环境要求：

- Node.js `22.19.x` 或 Node.js `24.x`
- pnpm `>=11.7.0 <12`
- `@deepseek-ai/cordis@4.0.1`，以及固定在 `0.1.0-rc.7` 包族的 DSH 部署

```bash
git clone https://github.com/Linxiushen/dsh-subagent-cassette.git
cd dsh-subagent-cassette
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination .artifacts
```

然后把生成的 tarball 安装到实际使用的 DSH profile，例如：

```bash
dsh plugin --profile web add ./.artifacts/dsh-subagent-cassette-0.2.0.tgz
dsh --profile web --dump-config
```

包内通过 `dsh.bundle.patch` 声明了 [`cordis.patch.yml`](cordis.patch.yml)。它只把 `cassette` 注册在真实 provider 旁边，不会修改现有调用方选择的 provider。使用自定义 bundle 流程时，可以显式合并该文件或 [`examples`](examples/) 中的 patch。

## 快速开始

### 1. 录制

把 `cassette` 和真实 provider 并列注册：

```yaml
# Cordis/DSH bundle patch
- insert:
    - id: subagent-cassette
      name: "dsh-subagent-cassette"
      config:
        mode: record
        provider: cassette
        upstreamProvider: spawn
        file: ".dsh-cassettes/repository-audit.cassette.jsonl"
        writeMode: create
        requestStorage: metadata
        redactSecrets: true
```

需要录制的 one-shot Subagent 调用必须选择 provider `cassette`；仍选择 `spawn` 的调用会绕过录制器。运行一个逻辑 root 场景，等待 Subagent run 完成，并正常卸载插件，使已经接纳的终态全部写入。

相对路径按进程工作目录解析。临时批量录制可以使用内置默认路径中的 `{timestamp}`、`{pid}` token；需要复用的测试 fixture 应使用明确文件名。

### 2. 校验、查看与比较

在源码目录执行过 `pnpm build` 后：

```bash
node dist/cli.js verify .dsh-cassettes/repository-audit.cassette.jsonl
node dist/cli.js inspect .dsh-cassettes/repository-audit.cassette.jsonl --show-calls
node dist/cli.js diff baseline.cassette.jsonl candidate.cassette.jsonl --show-calls
```

在已安装该包的部署中：

```bash
pnpm exec dsh-cassette verify .dsh-cassettes/repository-audit.cassette.jsonl
pnpm exec dsh-cassette inspect .dsh-cassettes/repository-audit.cassette.jsonl --json --show-calls
pnpm exec dsh-cassette diff baseline.cassette.jsonl candidate.cassette.jsonl --json
```

`inspect` 只输出元数据、call key、指纹、outcome 类型、stop reason 分类和耗时。stop reason 仅分为 `completed`、`aborted`、`error`、`max-tokens`、`refusal` 或 `other`；未来 DSH 出现未知值时只输出 `other`。Human 输出会转义 cassette 派生文本中的控制字符、格式字符和行分隔符，JSON 输出则使用合法 JSON 转义。它不会输出已保存的 prompt、结果正文或未知 stop reason 原值。但 label 会出现在元数据和可读 call key 中，因此 CLI 输出不一定匿名。

`diff` 只按完整稳定身份 `(parent key, parent-context fingerprint, request fingerprint, occurrence)` 对齐，分别报告新增、删除、结果变化、边界变化和录制策略漂移。Timing delta 只作信息展示，不影响等价判定。退出码 `0` 表示等价，`2` 表示存在差异或无法安全比较，`1` 表示参数、读取或格式错误。遇到歧义重复组或父上下文继承语义变化时会 fail closed，不进行猜测式对齐。

Cassette 加载也会在持久化请求边界 fail closed。metadata/full 请求视图只能包含文档列出的字段，并且每条 interaction 的 `request.storage` 必须与 header 的 `requestStorage` 策略一致。这些检查先于 replay、inspect、diff 或 append 执行。本次加固不改变 cassette 格式版本 `1`，也不改变精确的 DSH `0.1.0-rc.7` 目标。

### 3. 离线回放

指定录制得到的固定文件，并重新运行产生相同请求的场景：

```yaml
- insert:
    - id: subagent-cassette
      name: "dsh-subagent-cassette"
      config:
        mode: replay
        provider: cassette
        file: ".dsh-cassettes/repository-audit.cassette.jsonl"
        timing: instant
        duplicatePolicy: reject
        allowRedactedReplay: false
        assertConsumed: true
```

replay 会在注册 provider 前读取并校验当前完整文件，同时按策略拒绝歧义重复组和被脱敏改写的成功结果。回放调用不需要 `spawn` provider。

## 配置

| 选项 | 模式 | 默认值 | 含义 |
|---|---|---:|---|
| `mode` | 通用 | `record` | `record` 或 `replay`。 |
| `provider` | 通用 | `cassette` | 注册到 `ctx.subagents` 的名称。 |
| `file` | 通用 | 带时间戳的路径 | Cassette JSONL 路径；replay 应始终显式指定固定路径。 |
| `redactSecrets` | record | `true` | 录制时启用内置 key 和字符串脱敏；该策略写入 header，并用于 append 兼容校验。replay 使用文件中的既有数据并忽略此项。 |
| `redactionPatterns` | record | `[]` | 额外 JavaScript 正则源码，按全局、忽略大小写方式编译。若规则命中 content block 的 `type` 或图片 `mediaType`，录制会被拒绝，因为这些字段属于结构字段。replay 不会对已加载数据重新脱敏。 |
| `upstreamProvider` | record | `spawn` | 接收真实调用的 provider，不能与 `provider` 相同。 |
| `writeMode` | record | `create` | `create` 拒绝覆盖；`truncate` 替换；`append` 校验并续写兼容文件。若另一个 writer 已锁定目标，所有模式都会立即失败。 |
| `requestStorage` | record | `metadata` | `metadata` 不写 prompt 正文；`full` 写入脱敏后的规范化请求。 |
| `timing` | replay | `instant` | `instant` 不等待；`recorded` 复现录制的边界延时。 |
| `speed` | replay | `1` | `recorded` 模式下至少为 `0.001` 的有限加速倍数；`2` 表示两倍速，缩放后的延时也必须保持有限。 |
| `duplicatePolicy` | replay | `reject` | 拒绝同 parent-context/请求组的不同结果，或显式用 `sequence` 按 occurrence 匹配。 |
| `allowRedactedReplay` | replay | `false` | 允许返回包含脱敏替代值的成功结果。 |
| `assertConsumed` | replay | `true` | dispose 时如果仍有未匹配 interaction，则抛错。 |

程序化接入可以调用 `installCassette(ctx, config)` 并保存返回的 handle，参见 [`examples/programmatic.ts`](examples/programmatic.ts)。

## 指纹与存储内容

请求指纹覆盖以下字段的无损 JSON 快照：

- `label`
- `prompt`
- `agentOptions`
- `outputSchema`
- `maxDepth`
- `toolFilter`
- `persona`

指纹不包含 abort signal、易变的 parent identity 和生成的 descriptor 字段。对象 key 排序后再计算 SHA-256；数组顺序仍然有意义。

独立的父上下文指纹覆盖 parent Agent options；稳定的 session `cwd`、`origin`、delegation depth 和 preset；存在相关 DSH service 时的实时 composed preset、委派 sandbox/approval 状态；以及当 provider 的 `inheritsParentContext` 为 true 时，已完成 turn 的模型可见消息前缀及其中最近一次 system prompt 与工具 schema。易变的 Session/message id 会被移除，相关联的 tool-call id 会按结构确定性重编号；正在进行的 turn 不属于 fork 前缀。

这些是 DSH 官方 `spawn`/`fork` in-process 路径使用的公开输入。任意第三方 provider 仍可读取其他 service、文件、时钟或网络状态，因此指纹完全一致表示严格边界匹配，而不是全局确定性证明。

使用 `requestStorage: metadata` 时，prompt 和父历史不会作为请求字段写入，但 cassette 仍保存无盐的请求及父上下文指纹、prompt block/字节数、部分元数据，以及最终输出或错误。低熵 prompt 或父上下文可能被猜测并用指纹验证。所有 cassette 都应按潜在敏感文件处理。

格式字段详见[格式文档](docs/format.md)，威胁模型详见[安全文档](docs/security.md)。

## 回放语义

| 录制的边界状态 | 回放行为 |
|---|---|
| provider 在发布 run 前拒绝 | `start()` 以 `CassetteRecordedError` 拒绝。 |
| run result resolve | `result` 返回持久化结果的独立快照。 |
| run result reject | `result` 以 `CassetteRecordedError` 拒绝。 |
| 实时 signal 在 replay 发布前 abort | `start()` 以 abort 形态的 recorded error 拒绝。 |
| 实时 signal 在发布后 abort，或调用 `dispose()` | `result` 返回 `{ output: [], stopReason: "aborted" }`。 |

录制错误保留 name、message 和可选字符串 code，但不会恢复原 Error class、stack、cause 或其他自定义字段。

`timing: recorded` 会按 `speed` 缩放 start latency 和剩余 duration。它只复现边界延时，不复现内部调度或 token stream。

## 不匹配诊断

`InteractionMatcher.diagnose(request)` 使用与 replay 相同的精确分析，但不会消费 interaction，也不会预留新的 root parent。结果要么是可匹配候选，要么是以下五种 mismatch reason 之一：

- `group-exhausted`
- `parent-context-changed`
- `request-changed`
- `parent-and-request-changed`
- `parent-not-found`

`match()` 失败时，同一个结构化对象会出现在 `CassetteMismatchError.diagnostic`。候选按录制时的 admission sequence 确定性排序，并标记是否已消费。请求规范化、父上下文指纹或精确匹配失败时不会预留新 root 或 occurrence，因此修正后的调用可以重试，不会继承被污染的拓扑状态。matcher 会按显式字段白名单重新构造候选元数据，而不是直接返回已保存的 metadata 对象，因此伪造字段或未来新增字段不能通过该路径泄漏。诊断只包含 call key、指纹、occurrence 和获准的请求元数据，不包含已保存的 prompt、result 或 error 正文；候选仅用于解释失败，绝不参与模糊匹配。

## 完整性边界

JSONL 每条记录都含 canonical SHA-256 hash，每个 interaction 还指向物理上的上一条记录。校验可以发现非法 JSON、重复 object member、无法无损 canonical 化的数值、不支持的 schema/目标版本、内容修改、中间记录删除、重排、重复 call key/occurrence、很多部分写入，以及当前可见链条断裂。

它不能认证文件，不能阻止恶意编辑者重算 hash；如果没有外部预期的尾 hash 或记录数，也无法发现一个完整有效的后缀被整体删除。Cassette 仍需置于正常的源码管理或 artifact store 完整性控制下。精确保证见[格式文档](docs/format.md#integrity-and-validation)。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm check
```

`pnpm check` 包含 lint、类型检查、带覆盖率门槛的测试、构建、发行包 smoke test 和 `publint`。修改匹配逻辑或持久化格式前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [架构](docs/architecture.md)
- [Cassette 格式](docs/format.md)
- [安全模型](docs/security.md)
- [示例](examples/README.md)
- [变更记录](CHANGELOG.md)

## License

[MIT](LICENSE)
