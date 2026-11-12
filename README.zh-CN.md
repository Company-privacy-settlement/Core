# Core

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

本金保留在独立金库中，共享 ZK 票据授权一个有流动性的金库直接付款；本金不会连续经过多个金库。新发票条款 v2 为每个付款单位使用不同的已签名引用，同时兼容旧版 v1。收款人、金额、时间和签名者仍然公开，金库数量不代表有效匿名集大小。参见[隐私模型与限制](docs/PRIVACY.md)。

发票通过索引直接查询引用集合，并以固定游标分页，避免扫描无关的收款历史。迟付合计与逐笔确认核对；查询失败或信任设置变化会清除旧结账状态。参见[审查发现与修复](docs/REVIEW-2026-11-12.md)。

这是 NEAR 隐私结算协议的**钱包 SDK、CLI 与集成代码**。Rust 合约、ZK 电路和合约测试保存在独立的 [Contract 仓库](https://github.com/Company-privacy-settlement/Contract) 中。仓库包含可运行的只读 HTTP API，用于已验证 vault 查询、FT 事前检查和最终确认的结算状态。签名与证明生成仍在本地客户端进行。

当前版本支持原生 NEAR **共享匿名集 v2** 和 **USDC/NEP-141 v3**。汇款本金分散保存在各 vault 中，共享 forest 管理统一的票据树和全局 nullifier。存入 A 的票据可从 B 提款；并发请求和重试也不会对同一票据重复付款。同时保留对 v1 独立池与工厂的兼容。

| 仓库 | 内容 |
| --- | --- |
| [Contract](https://github.com/Company-privacy-settlement/Contract) | `pool`、`factory`、`shared-vault`、`forest`、Circom 电路、原生测试和 WASM 构建 |
| Core（当前仓库） | 秘密票据与钱包、本地证明生成、已验证 vault 选择、选择性披露、交易凭证、KYB 签名验证、CLI 和集成演示 |

## 开发状态与运行集成

本阶段新增浏览器 FT 执行 SDK、逐笔钱包调用审核、加密操作日志及最终确认交易核对。[Front 的 `/live/` 页面](https://github.com/Company-privacy-settlement/Front) 使用独立可信的部署策略，通过 NEAR Connect 连接测试网钱包。签名结果不确定时，重启后仍会阻止重复发送并核实原交易；代币被接受与最终付款完成分开判断。详见[钱包集成与恢复](docs/WALLET.md)。秘密票据生成与证明仍使用本地 CLI。来源发现扩展、公开测试网部署和真实 KYB/税务集成仍列于[开发清单](docs/ROADMAP.md)。

新增最终确认的 registry 日志索引，将记录与检查点一起持久化到 SQLite，重启后无重复地继续，验证所提供公开交易引用的收据来源，并支持过滤及固定游标分页。设置 `CORE_INDEX_DB` 后运行 `npm run index -- once` 或 `watch`，API 以只读方式访问同一数据库。未核实的来源明确保持未关联状态，不声明企业完整交易历史。参见[索引运行与范围说明](docs/INDEXER.md)。

新增从配置起始区块枚举全部分片交易的自动发现，检查完整最终确认收据图，并保存区块内进度。Front `/live/` 展示公开索引记录、检查点时间、发现进度、未关联来源及固定过滤分页。通过 `CORE_DISCOVERY_START_HEIGHT` 启用，也继续支持公开交易引用输入。不声明覆盖起始区块之前或当前最新链状态。

新增收款人开具发票：商户 NEP-413 钱包签名、fragment 结账链接、绑定发票的提款证明，以及部分/完成/迟付/超额付款核对。Front `/invoices/` 开具和跟踪请求，`/pay/` 验证后连接现有钱包日志。业务条款保留在客户端；只读 API 核实商户密钥及公开确认金额。参见[发票架构与使用说明](docs/INVOICES.md)。

```bash
npm run cli -- ft-preflight trusted-policy.json https://rpc.testnet.near.org public-request.json
npm run cli -- settlement-status trusted-policy.json https://rpc.testnet.near.org public-reference.json
npm run cli -- settlement-wait trusted-policy.json https://rpc.testnet.near.org public-reference.json

export CORE_POLICY_FILE=/absolute/path/to/trusted-policy.json
export CORE_RPC_URL=https://rpc.testnet.near.org
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
```

API 默认监听 `127.0.0.1:3001`，需要真实且受信任的部署策略，不会回退到模拟链。提供 `/v1/vaults`、`/v1/ft/preflight` 、`/v1/settlements/status` 和 `/v1/transactions/verify`；钱包、秘密票据及签名密钥不进入服务。交易被接受或观察超时本身不代表付款完成或失败。输入格式、就绪标记和恢复行为见[运行功能与 HTTP 规范](docs/OPERATIONS.md)。

## 开始使用

需要 Node.js 22.13.0 及以上版本。合约构建使用 Contract 固定的 Rust 1.99.1 及 C/C++ 构建工具。将两个仓库检出到同级目录。

```text
workspace/
  Contract/
  Core/
```

在 Core 目录中执行：

```bash
(cd ../Contract && npm ci)
npm ci
npm run contract:build
npm run zk:setup
npm run check
npm test
npm run demo:shared
```

导出 `CORE_CONTRACT_REPO` 可指定其他 Contract 路径。Core 的构建命令会调用 Contract 构建，验证 manifest 中的 SHA-256，再复制 WASM。`zk:setup` 也在 Contract 中执行并导入经过验证的证明产物。生成文件不提交到 Git。

`npm test` 使用已提交的公开向量，无需 Contract 仓库、Rust 或可信设置即可独立运行。`npm run contract:test` / `npm run factory:test` 调用 Contract 的 v1 测试。完整合约测试通过 `(cd ../Contract && npm test)` 运行，运行前需先构建合约。

演示使用官方 NEAR sandbox 2.14.1，支持 Linux x64 和 macOS arm64。演示会验证真实 WASM、真实 Groth16 证明以及最终确认的 RPC 结果，结束后删除一次性链。报告中的交易不是测试网交易。

| 演示 | 验证内容 |
| --- | --- |
| `npm run demo:ft` | 6 位小数 FT 入金/提款、伪造代币拒绝、跨 vault 结算、防双花、未注册/冻结收款人恢复及按资产区分的最终确认凭证 |
| `npm run demo:shared` | 共享树、跨 vault 提款、并发双花防护、重复入金退款、付款失败重试、手续费及 12 条最终确认记录 |
| `npm run demo:factory` | v1 无密钥自动部署、失败退款及独立提款 |
| `npm run demo` | v1 隐私票据转移、新钱包提款及收据验证 |

v2 报告位于 `demo-output/shared-validation.json`。自动移除管理员密钥仅发生在一次性本地链中，不会执行公开网络部署或密钥移除。

## USDC / NEP-141 v3

通过 Contract 的 `new_ft` 部署**绑定代币地址与固定面额的独立 forest**。票据不会与原生 NEAR 组混用。本金保存在各 vault 地址的代币余额中，forest 仅接收提款手续费。

存入 1 USDC（1,000,000 个最小单位）时转入 **1.0015 USDC**；提款时另付 **0.0015 USDC**，收款人收到**完整的 1 USDC**。0.02 NEAR 存储费用及 gas 另计。由于 `ft_on_transfer` 无法接收附带的 NEAR，需先为代币发送者预存 storage credit。每个合约首次使用时另收一次性 0.005 NEAR 账本存储保证金，后续充值不再重复收取。未使用的 credit 可退还给其所有者。

```bash
(cd ../Contract && npm run build:test-ft)
npm run contract:build
npm run demo:ft
npm run cli -- quote-usdc 1
```

`demo:ft` 将基于官方 near-contract-standards 的测试代币部署到一次性 sandbox。它**不是 Circle 发行的 USDC，也不是真实公开网络交易**。结果位于 `demo-output/ft-validation.json`。需要已有的证明设置；创建新设置后需重新生成公开向量。

在 `SharedPolicy` 中添加官方 `tokenId` 即可验证 v3 资产组。测试网原生 USDC 地址为 `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`。请核对 [Circle 官方地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)，区分 USDC 与 USDC.e。`examples/usdc-policy.template.json` 中的 registry 和代码哈希必须替换为实际新部署的值。

`sdk/ft.ts` 提供：

- `parseUsdc`、`quoteFtFees`：不使用浮点数，精确处理 6 位小数 USDC 金额及本金之外的手续费；不将代币数量与 yoctoNEAR 相加。
- `buildFtRegistration`：使用从代币合约读取的最低存储费用，生成明确的 NEP-145 注册 payload。
- `buildStoragePrepayment`：根据实际 `get_storage_credit` 结果计算首次保证金及剩余 credit。
- `buildFtDeposit`、`buildFtWithdrawal`：生成绑定已验证目录和证明目的地的代币调用、存储目标及最终状态检查信息。

`shared-note`、`shared-deposit-args`、`shared-spend-args` CLI 也支持 v3 策略。转账前，真实钱包需在代币合约上注册接收 vault、registry、treasury 和收款人，并为代币发送者预存所需 NEAR storage credit。新的隐式钱包必须完成 NEAR 账户创建与 FT 注册才能接收 USDC。成功的 `ft_transfer_call` 仅表示代币已被接受；只有 `get_withdrawal` 返回 `Complete` 才表示付款完成。

FT 凭证使用 `SettlementBundle { version: 3, assetTokenId, ... }`。验证过程将代币身份与最终确认日志绑定，并分别汇总代币协议手续费与 NEAR 存储费用。ABI、失败恢复和重新部署要求见 [Contract USDC 规范](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md)。不支持将新二进制文件直接覆盖到已有合约状态上。

## 共享 v2 使用流程

1. 构建 Contract，使用独立验证的 forest/vault WASM 哈希与验证器哈希填写 `examples/shared-policy.json`。不要将未知合约提供的哈希作为信任依据。
2. SDK 在同一个最终确认区块上验证 registry/vault 的代码、空密钥列表、所属组、手续费及可用流动性。
3. 收款人为共享组创建秘密票据，只向发送者提供 commitment。发送者直接向已验证的 vault 入金。
4. SDK 重建共享树并在本地生成证明，将选定的付款 vault 和收款人绑定到证明中。
5. Forest 先将 nullifier 标记为已使用，再由选定 vault 支付本金。失败后保留原目的地与已使用状态，并重试相同请求。

```bash
# 安全读取密码，不要将密码放入命令行参数或仓库。
read -rs CORE_NOTE_PASSWORD
export CORE_NOTE_PASSWORD

npm run cli -- discover-shared examples/shared-policy.json https://rpc.testnet.near.org
npm run cli -- shared-note examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json
npm run cli -- receipt examples/receipt-values.json private-receipt.json
npm run cli -- shared-deposit-args examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json RECEIPT_ROOT
npm run cli -- shared-spend-args examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json examples/withdraw-action.json withdrawal-args.json
```

上述命令仅准备 payload，需要真实 NEAR 钱包签名并提交。action 未指定 `vault` 时，SDK 会从已验证的流动性中选择。请将本金收款人 `target` 和新的 `disclosureRoot` 替换为实际值。隐私转移使用 `kind: transfer`，将 `target` 设为收款人的 commitment，不指定 vault。

确认 vault 入金达到 `Active`。登记被明确拒绝后，可将本金与协议手续费退还给原发送者；网络失败可通过 `retry_deposit` 恢复。只有 forest 的 `get_withdrawal` 达到 `Complete` 才表示提款完成，不能仅凭请求事件认定已付款。规范见 [Shared v2](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/SHARED.md)。

## 手续费

入金与提款均在本金之外**加收 0.15%**，收款人获得全额本金。NEAR 按 yoctoNEAR、FT 按代币最小单位向下取整。0.02 NEAR 存储费用及 gas 另计。

以 1 NEAR 为例，入金共付 **1.0215 NEAR**；提款另付 **0.0215 NEAR**，收款人收到 **1 NEAR**。v2 将存储费用分配给 forest（0.015）和 vault（0.005），不是额外收费。转移和重试仅支付存储费用，不重复收取协议手续费。

```bash
npm run cli -- quote-fees 1000000000000000000000000
```

收款地址在初始化时通过 `fee_recipient` 固定。入金手续费由 vault 累计，成功提款的手续费由 forest 累计。只有已赚取的手续费可转入固定 treasury，本金、待付款项、退款和存储余额均受到保护。手续费转账失败后会恢复账本。

## 收据、KYB 与新钱包

```bash
npm run cli -- wallet receiver-wallet.encrypted.json
npm run cli -- disclose private-receipt.json asset,amount,reference
npm run cli -- verify-bundle bundle.json https://rpc.testnet.near.org
```

新的隐式钱包密钥在用户设备上生成，并使用 AES-256-GCM 加密备份。合约不生成或保管私钥。秘密票据丢失后，运营方也无法恢复。

收据的每个字段使用独立 salt，且**每次操作生成新的 root**。重复使用同一 root 会使操作被公开关联。v2 凭证将实际 registry 执行者的最终确认事件与 journal 对照，检查 vault、本金、手续费和已披露字段的完整性。它验证所选交易的包含关系与完整性，不证明完整历史、隐私票据间的资金流向、法定身份或税务申报已获受理。

企业 KYB 验证明确受信任发行方的 Ed25519 签名、主体 commitment、有效期及提供的撤销列表。它不执行真实企业/受益所有人审查，也不是由电路强制执行的资格策略。美国/阿布扎比税务与 AI 草稿属于后续范围，边界见 [合规说明](compliance/README.zh-CN.md)。

## 局限

共享的是密码学成员关系集合。参与者数量少、时间、金额、收款人、gas 钱包及公开数据均可能削弱隐私，因此不保证网络匿名性。共享 registry 是逻辑状态协调点，不持有运营方审批密钥；对 RPC 的信任仍然存在。

这是支持原生 NEAR v2 和 USDC/NEP-141 v3、固定面额及共享树总计 256 个输出的黑客松核心实现。不同版本与资产使用独立域，不支持自动迁移票据。不包含可变金额、跨资产桥接、法定申报、生产安全审计或分布式可信设置。网络 label 是配置值，无法自动阻止在实际主网上部署。开发设置仅用于本地链和测试网演示。
