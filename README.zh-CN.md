# Core — NEAR 企业隐私结算

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

Core 是面向企业间付款和企业→员工转账的开发协议。独立 vault 保管本金，共享零知识票据授权一个有流动性的 vault 直接付款。收款人可签发发票，付款人逐项审核钱包调用，证据持有人只披露所选字段。

本仓库提供 SDK、本地浏览器证明及证明 CLI、只读 API、最终记录索引和证据工具。浏览器执行支持独立配置的测试网 FT 组；原生 NEAR v2 可通过合约和 CLI 使用。服务与 Docs 默认使用英语。

[服务概览](docs/SERVICE.md) · [网页 Docs](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/docs/) · [开发路线](docs/ROADMAP.md)

[企业发票 API](docs/ORGANIZATION_INVOICES.md) 支持按组织保存和查询不可变签名发票、防止重复创建，并使用 AES-256-GCM 加密敏感内容。必须单独配置仅所有者可读的密钥文件；未配置时拒绝发票存储。现有本地发票与结账流程独立运行。

[付款管理仪表板](docs/PAYMENT_DASHBOARD.md) 支持按组织搜索发票、状态/资产/组/日期筛选、CSV/JSON 导出和基于最终化索引的对账。历史查询与需要当前密钥的结账分离，未检查、过期索引和不完整结果保持明确。

[签名付款 Webhook](docs/WEBHOOKS.md) 提供加密回调/事件、最终化索引持久队列、稳定事件 ID、HMAC 签名、重试/失败历史和接收端原子去重。Owner/Admin 可在 Organization → Webhooks 管理，须配置可信本地索引、允许的 HTTPS 地址和受保护密钥文件。

[员工/承包商批量付款](docs/PAYOUT_BATCHES.md) 支持 1–20 个独立审批公开提款请求、幂等恢复准备、逐收款人附加费用、共享加密日志、原目标单独恢复和 CSV/JSON 对账。成功或结果不明的付款不会整批重发。

## 仓库

| 仓库 | 职责 |
| --- | --- |
| [Core](https://github.com/Company-privacy-settlement/Core) | 浏览器/Node SDK、浏览器/CLI 证明、API、SQLite 索引和证据验证 |
| [Contract](https://github.com/Company-privacy-settlement/Contract) | Rust 合约、Circom 电路、向量、WASM 与证明产物 |
| [Front](https://github.com/Company-privacy-settlement/Front) | Next.js 首页、英文 Docs、发票、票据、结算、证据与示例 KYB |

本地浏览器支持 FT 提现证明生成与取消、独立哈希固定的 WASM/zkey/验证密钥校验及证明文件重新验证。使用 `npm run prover:export` 导出已审核文件，详见[浏览器证明指南](docs/BROWSER_PROVER.md)。[发票结账](docs/INVOICE_PAYMENTS.md)支持原分组加密票据选择 → 本地证明 → 金额与费用确认 → 逐项钱包授权 → 最终付款确认，并提供所选单位绑定、取消、签名前商户密钥/状态复查与保守恢复。

## 当前功能

| 功能 | 已实现范围 |
| --- | --- |
| 隐私结算 | 原生 NEAR v2 与代币固定 NEP-141 v3 分组；固定面额，每组共 256 个票据树输出 |
| 浏览器票据 | 本地生成 FT 票据、加密文件备份与重验、公开存款计划 |
| 钱包执行 | 注册/存储/付款分别审批、加密操作日志、最终状态查询和保守恢复 |
| 发票 | 收款人 NEP-413 签名、v2 单位独立引用、兼容 v1、部分/完成/迟付/超额对账 |
| 发票库 | 可选的商户/网络隔离加密存储、搜索/打开、备份/恢复/合并 |
| 收款准备 | 分别检查账户激活与代币注册，查询实际注册最低额，不猜测激活金额 |
| 证据 | 加密完整收据、选择性字段证明、本地独立根完整性检查及单独的最终交易锚定 |
| 公开索引 | SQLite 检查点、有界全分片交易发现、已验证来源和分页记录 |
| KYB | Front 本地示例接入和 SDK 可信发行者签名检查；另有 Sumsub 集成，仍需真实审核验证 |

## 服务流程

1. 独立取得部署策略，核对网络、registry、代币、面额、费用收款人和代码/验证器哈希与 Core API 一致。
2. 在 Front **Private notes** 创建 FT 票据，下载并重新打开加密备份。API 仅接收公开承诺和根。
3. 在 **Settlements** 导入公开存款计划，连接测试网钱包，分别审批注册、存储和付款。绑定记录达到 `Active` 才表示存款完成。
4. 使用原策略和加密票据在 Front **Local proofs** 或 CLI 本地生成提现证明。结账必须绑定已签发票的收款账户及所选单位引用。
5. 在应用审核并签署公开提现计划。绑定记录为 `Complete` 才完成付款；钱包响应或超时本身不确定成功/失败。
6. 分别保管所需备份，只披露所选字段。收据完整性、交易包含、企业身份及税务受理是独立结论。

发票付款引用和任意收据根是不同流程；Evidence 根不能替换已签发票所要求的付款引用。

## 费用

存款和提现各收取**本金外加 0.15%**，按资产最小单位向下取整。收款人收到完整本金。

| 示例 | 存款 | 提现费用 | 收款本金 |
| --- | --- | --- | --- |
| 1 USDC 票据，六位小数 | 1.0015 USDC | 0.0015 USDC | 1 USDC |
| 原生 1 NEAR 票据 | 含操作存储 1.0215 NEAR | 含操作存储 0.0215 NEAR | 1 NEAR |

FT 每个适用操作另需 0.02 NEAR 存储，首次发送者 credit 在各目标合约增加 0.005 NEAR 账本押金。代币注册、账户激活和网络 gas 分开计算。需先创建并存入票据的付款人也支付存款侧费用。参见[操作指南](docs/OPERATIONS.md)与[FT 合约规范](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md)。

## 运行 Core

需要 Node.js **22.13.0+**。SDK/API/索引开发无需 Rust 或 Contract 仓库。

```bash
npm ci
npm run check
npm test
npm run build:client
```

真实组需独立审核的策略；模板占位符不能直接使用。服务不会自动加载 `.env` 文件。

```bash
export CORE_POLICY_FILE=/absolute/path/to/trusted-policy.json
export CORE_RPC_URL=https://rpc.testnet.near.org
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
```

默认监听 `127.0.0.1:3001`。`/healthz` 检查进程存活，`/readyz` 检查部署和配置的索引。附加索引前，在另一个终端以相同策略、RPC 和 `CORE_INDEX_DB` 启动工作进程。参见 [.env.example](.env.example)、[API 配置](docs/OPERATIONS.md)、[索引配置](docs/INDEXER.md)。勿向 API 发送票据秘密、钱包密钥、口令或业务文件。

## 版本化发布包

`npm run build:sdk` 构建 Node ESM/类型声明及浏览器客户端。`release:prepare` 固定干净的 Core/Contract/Front 提交，打包合约、证明材料、SDK、分组策略与 API 来源。`release:verify` 使用独立获得的清单 SHA-256 离线验证。目前仅支持沙箱/测试网开发发布，打包不执行部署或证明链上就绪。[命令与格式](docs/RELEASES.md) · [输入模板](examples/release.template.json)。

## 测试网部署工具

`deploy:plan` 绑定测试网发布包与公开输入，`deploy:preflight` 检查最终化的网络、账户、密钥、代币及成本。`deploy:execute` 每次仅执行原子初始化、FT 注册或明确确认的移除密钥步骤，并持久记录公开交易意图。`deploy:reconcile` 只查询、不重发，`deploy:verify` 验证无密钥部署。签名密钥由独立的本地所有者专用文件管理，不进入 API。[命令与演练](docs/DEPLOYMENT.md) · [输入模板](examples/deployment.template.json)。

## API 与索引器托管

`build:service` 编译运行代码，`serve:service` 完成初始同步并监督只读 API 与单一 SQLite 写入进程。Docker/Compose 提供可选 Caddy HTTPS、持久卷及重启策略，并附有 Render 配置。必须提供策略摘要、准确来源及索引就绪验证，支持在线备份和禁止覆盖的恢复。[托管与恢复](docs/HOSTING.md) · [VPS 环境示例](ops/service.env.example)。实际对外部署仍需托管目标及已部署的测试网策略。

## 企业组织访问管理

独立 Organization API 提供 NEP-413 测试网登录、组织/成员持久化、定向邀请、Owner/Admin/Operator/Viewer/Auditor 角色、访问撤销、带版本检查的所有权转移和审计历史。Front `/organization/` 管理这些权限，令牌仅保存在内存中。组织权限不授予链上签名能力或验证企业身份。使用独立 origin/数据库/RPC 配置执行 `npm run serve:organizations`。[API、角色和托管](docs/ORGANIZATIONS.md)。

[组织数据备份与恢复](docs/ORGANIZATION_BACKUPS.md)提供一致在线快照、会话/挑战废弃及隔离恢复。必须使用单独审核的当前权限文件才能激活到新的运行数据库；历史所有者、角色和待处理邀请不会自动恢复为权限。

[企业付款审批](docs/CORPORATE_PAYMENTS.md)分离创建者与另一位 Owner/Admin 审批者，固定付款、额外 0.15% 费用及前置调用。支持的钱包流程在执行前复查当前成员权限与审批，并将每个准确调用仅保留一次。这属于组织 API/SDK/应用策略；现有合约继续支持无许可的固定收款人证明执行。

## 集成 CI

三个仓库调用固定提交的同一流水线，验证 Core 类型/单元及 API/索引恢复、重建 SDK 与 Front 副本、Front 类型/单元/静态构建/桌面和移动浏览器、合约 WASM/单元、原生/FT Groth16 沙箱及开发发布包。私有仓库需要 `INTEGRATION_READ_TOKEN` 和复用工作流访问设置。[版本、步骤和 GitHub 配置](docs/CI.md)。本地验证不等于托管 Actions 成功。

## 本地合约与证明验证

将 Core、Contract、Front 放在相邻目录。Contract 需要固定 Rust **1.99.1**、WASM target 和 C/C++ 构建工具。在 Core 中：

```bash
(cd ../Contract && npm ci)
npm run contract:build
npm run zk:setup
(cd ../Contract && npm run build:test-ft)
npm run demo:ft
```

`CORE_CONTRACT_REPO` 可覆盖默认路径。Core 导入前验证 WASM/证明产物清单哈希。当前 setup 为单机开发仪式；替换时需匹配验证器、产物和新部署。生成文件不提交到 Git。

**2026-11-13 记录的验证：**Core **320 个测试**、Front **164 个浏览器用例**及类型/构建检查、实际 FT 沙盒 **14 条最终记录**。沙盒代币不是 Circle USDC 或公开网络资金。可使用上面的命令复现这些已记录的验证。

## 隐私、保管与恢复

本金不连续经过 A→B→C。共享树隐藏输入票据成员关系，所选 vault 直接付款；不同组保留独立隐私集合。收款人、签名者、金额、时间、vault 余额、nullifier 和引用仍可关联活动，vault 数量不等于测得的匿名集。无密钥 registry 协调状态，RPC/API 观测仍是信任依赖。

浏览器票据和完整收据保存在内存及下载的加密文件中；操作日志和可选发票库在不同浏览器命名空间加密持久化。锁定和历史缓存处理撤销待处理工作。已打开的钱包请求无法通过锁定撤回；持久化签名意图须显式核对。服务不能恢复丢失的票据秘密或口令。

美国/阿布扎比是未来准备层的范围，仍需确定美国州与 ADGM/本土。自主全面法律建议、完整辖区税务规则、真实 KYB 运行验证、法定申报、法币兑换及生产部署尚未实现。参见[合规范围](compliance/README.md)。

## 指南

[钱包/恢复](docs/WALLET.md) · [浏览器票据](docs/BROWSER_NOTES.md) · [收款准备](docs/RECIPIENTS.md) · [发票](docs/INVOICES.md) · [发票库](docs/INVOICE_LIBRARY.md) · [收据](docs/BROWSER_RECEIPTS.md) · [组](docs/GROUPS.md) · [隐私](docs/PRIVACY.md) · [索引](docs/INDEXER.md) · [路线](docs/ROADMAP.md)

当前托管仅限所有者；外部客户结账需要相应访问设置和独立部署/注资的组。不包含已注资公开部署。可变金额、私密跨组迁移、真实合规集成、独立安全审查及已审核多方 setup 仍待完成。

**2026-11-14 企业发票验证：**包含 22 项新增 API、加密、幂等和恢复用例的 **342 项 Core 测试**通过，编译服务重启与 CLI 恢复验证也通过。

**2026-11-14 付款仪表板验证：**包含新增 13 项 Core 和 18 项浏览器用例的 **355 项 Core 测试**与 **182 项桌面/移动浏览器用例**通过，类型、Node/浏览器 SDK 和静态构建也通过。浏览器服务/钱包测试夹具不代表公开网络实际部署。

**2026-11-14 付款 Webhook 验证：**含新增 24 项 Core 和 12 项浏览器用例的 **379 项 Core 测试**与 **194 项桌面/移动浏览器用例**通过，Node/浏览器 SDK、静态构建和编译服务恢复检查通过。使用本地索引/钱包/传输夹具，未向实际商户回调发送消息或部署公开后端。

员工与承包商批量付款验证（**2026-11-14**）：**401 项 Core 测试**、**210 项桌面/移动浏览器用例**通过，其中新增 22 项 Core 和 16 项批量付款浏览器用例。类型检查、Node/浏览器 SDK、静态 Front 构建、编译服务重启/备份/恢复及文档检查均通过。钱包、RPC 和组织服务使用本地测试环境；结果不代表已验证真实资金的公网工资支付或真实移动钱包。

Organization → Verification 新增 [Sumsub KYB/KYC 集成](docs/VERIFICATION.md)，支持企业/实益所有人审核、安全补充资料、最小状态加密、签名回调及基于审核日期的到期/撤销。启用需要签约账户、审核级别和 HTTPS 回调；开发验证使用提供方测试环境模拟，未审核真实企业。独立 `/kyb/` 示例仍不提交。

KYB/KYC 集成验证（**2026-11-14**）：**428 项 Core 测试**和 **224 项桌面/移动浏览器用例**通过，含新增 27 项 Core 和 14 项提供方流程浏览器用例。类型、Node/浏览器 SDK、静态 Front 构建、编译服务重启/备份/恢复、文档及 SDK 同步检查通过。使用本地提供方/RPC/钱包测试环境；未验证真实 Sumsub 账户、企业/个人审核、实际回调或公网后端。

[美国/阿布扎比规则引擎](docs/RULES.md)按辖区、员工/承包商/B2B 关系及适用日期选择 7 项已核对来源的组件候选规则，保留精确算式与官方依据。浏览器/CLI 本地运行；审核模式需要独立可信的 Ed25519 审批。未附专业审核批准、完整税额、自动预扣或申报。

规则引擎验证（**2026-11-14**）：**459 项 Core 测试**和 **240 项桌面/移动浏览器用例**通过，含新增 31 项 Core 和 16 项 Rules 浏览器用例。类型、Node/浏览器 SDK、静态 Front 构建、编译 CLI 导出/复核、服务重启/备份/恢复及来源/文档检查通过。审核密钥为测试数据；未进行专业税务/法律规则批准、真实纳税人评估、自动预扣或申报。

[AI 税务与程序草稿](https://github.com/Company-privacy-settlement/Core/blob/main/docs/TAX_DRAFTS.md)位于 Organization → Tax drafts：验证规则计算与选定收据值的精确绑定、带来源草稿、组织加密存储、独立审核、不可变修订、撤销及 JSON/Markdown 导出。AI 仅排列已验证语句 ID，不接收金额或证据；确定性提纲明确区分。真实 AI 启用需要私有提供商密钥与模型，有效审核需要运营方固定的签名规则策略。不附带专业规则批准、自主法律建议、法定申报或付款授权。

草稿专项验证（**2026-11-14**）通过：**488 项 Core 测试**（新增草稿 29 项）、**16 项桌面/移动草稿浏览器用例**、3 项 Front 单元、类型检查、Node/浏览器 SDK 与静态构建、编译服务/备份/恢复及文档/来源清单检查。AI 传输与审核签名使用受控测试环境，未执行真实模型调用、专业规则批准或法定申报。
