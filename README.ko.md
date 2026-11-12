# Core

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

NEAR 프라이버시 정산의 **지갑 SDK·CLI·연동 코드**입니다. Rust 계약, ZK 회로, 계약 테스트는 별도 [Contract 저장소](https://github.com/Company-privacy-settlement/Contract)에 보관합니다. 검증된 vault 조회, FT 사전 점검, 최종 확정 정산 상태를 제공하는 읽기 전용 HTTP API를 포함합니다. 서명과 증명 생성은 로컬 클라이언트에서 처리합니다.

현재 버전은 native NEAR **공유 익명성 v2**와 **USDC/NEP-141 v3**를 지원합니다. 송금 원금은 각 vault에 분산 보관하고, 공통 forest가 하나의 노트 트리와 전역 nullifier를 관리합니다. A에 예치한 노트로 B에서 출금할 수 있으며, 동시 요청과 재시도에서도 한 노트를 두 번 지급하지 않습니다. v1 독립 풀과 팩토리도 호환 유지합니다.

| 저장소 | 보관 내용 |
| --- | --- |
| [Contract](https://github.com/Company-privacy-settlement/Contract) | `pool`, `factory`, `shared-vault`, `forest`, Circom 회로, native 테스트, WASM 빌드 |
| Core (현재) | 비밀 노트·지갑, 로컬 증명 생성, 검증된 vault 선택, 선택 공개, TX 증빙, KYB 서명 검증, CLI·통합 데모 |

## 개발 현황과 운영 연결

남은 작업은 [개발 목록](docs/ROADMAP.md)에 정리했습니다. 이번 단계에서는 하나의 확정 블록에서 FT 준비 상태 점검, 순서가 있는 등록·스토리지 사전 작업, 목적지에 묶인 정산 상태·복구 안내, 제한된 폴링, CLI와 읽기 전용 API를 추가했습니다. 실제 지갑·프론트 서명 연결, 영속 거래 저장·인덱싱, 실제 KYB·세무 연동은 후속 단계입니다.

```bash
npm run cli -- ft-preflight trusted-policy.json https://rpc.testnet.near.org public-request.json
npm run cli -- settlement-status trusted-policy.json https://rpc.testnet.near.org public-reference.json
npm run cli -- settlement-wait trusted-policy.json https://rpc.testnet.near.org public-reference.json

export CORE_POLICY_FILE=/absolute/path/to/trusted-policy.json
export CORE_RPC_URL=https://rpc.testnet.near.org
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
```

API 기본 주소는 `127.0.0.1:3001`이며 실제 신뢰 배포 정책이 필요합니다. 시뮬레이션으로 대체하지 않습니다. `/v1/vaults`, `/v1/ft/preflight`, `/v1/settlements/status`를 제공하며 지갑·비밀 노트·서명 키는 서비스 밖에 둡니다. 트랜잭션 수락이나 관찰 시간 초과만으로 지급 완료·실패를 판단하지 않습니다. 입력 형식, 준비 상태와 복구 동작은 [운영 기능과 HTTP 명세](docs/OPERATIONS.md)를 확인하세요.

## 실행

Node.js 22+가 필요합니다. 계약 빌드는 Contract에 고정한 Rust 1.99.1 및 C/C++ 빌드 도구를 사용합니다. 두 저장소를 형제 폴더로 체크아웃합니다.

```text
workspace/
  Contract/
  Core/
```

Core 폴더에서:

```bash
(cd ../Contract && npm ci)
npm ci
npm run contract:build
npm run zk:setup
npm run check
npm test
npm run demo:shared
```

`CORE_CONTRACT_REPO`를 export하면 다른 Contract 경로를 사용할 수 있습니다. Core 빌드 명령은 Contract의 빌드를 호출한 뒤 manifest의 SHA-256을 검증해 WASM을 복사합니다. `zk:setup`도 Contract에서 실행하고 검증한 proving artifacts를 가져옵니다. 생성 파일은 Git에 포함하지 않습니다.

`npm test`는 커밋된 공개 벡터를 사용하므로 계약 checkout·Rust·setup 없이 단독 실행할 수 있습니다. `npm run contract:test` / `npm run factory:test`는 Contract의 v1 테스트를 호출합니다. 전체 계약 검증은 `(cd ../Contract && npm test)`로 실행합니다. 계약 테스트 전에 빌드가 필요합니다.

데모는 공식 NEAR sandbox 2.14.1을 사용합니다(Linux x64 / macOS arm64). 실제 WASM, 실제 Groth16 증명, 최종 확정 RPC를 검증하며 종료 시 일회용 체인을 제거합니다. 보고서의 TX는 테스트넷 TX가 아닙니다.

| 데모 | 검증 |
| --- | --- |
| `npm run demo:ft` | 6자리 FT 입출금, 가짜 토큰 거부, 교차 vault·동시 사용 방지, 미등록/동결 수신자 복구, 자산별 확정 증빙 |
| `npm run demo:shared` | 공유 트리, 교차 출금, 동시 이중 사용 방지, 중복 예치 환불, 실패 지급 재시도, 수수료, 12개 확정 기록 |
| `npm run demo:factory` | v1 keyless 자동 배포·실패 환불·독립 출금 |
| `npm run demo` | v1 비공개 노트 이전·새 지갑 출금·영수증 검증 |

v2 보고서는 `demo-output/shared-validation.json`입니다. 자동 관리자 키 제거는 일회용 로컬 체인 안에서만 수행합니다. 공개 네트워크 배포나 키 제거는 실행하지 않습니다.

## USDC / NEP-141 v3

Contract의 `new_ft`로 **토큰 주소·고정 denomination을 묶은 별도 forest**를 배포합니다. Native NEAR 그룹과 노트를 섞지 않습니다. 원금은 각 vault 주소의 토큰 잔액에 분산하고 forest는 출금 수수료만 받습니다.

1 USDC(1,000,000 atomic units) 입금 시 **1.0015 USDC**, 출금 시 별도 **0.0015 USDC**를 받고 수신자는 **1 USDC 전액**을 받습니다. NEAR 스토리지 0.02와 가스는 별도입니다. `ft_on_transfer`에 NEAR를 첨부할 수 없으므로 토큰 송금자의 storage credit을 먼저 적립합니다. 첫 사용에는 contract별 0.005 NEAR ledger bond가 추가되고 이후에는 다시 부과하지 않습니다. 미사용 credit은 소유자에게 환불할 수 있습니다.

```bash
(cd ../Contract && npm run build:test-ft)
npm run contract:build
npm run demo:ft
npm run cli -- quote-usdc 1
```

`demo:ft`는 official near-contract-standards 기반 테스트 토큰을 일회용 sandbox에 배포합니다. **Circle 발행 USDC나 공개 네트워크 실거래가 아닙니다.** `demo-output/ft-validation.json`에서 결과를 확인합니다. 기존 proving setup이 필요하며 새 setup을 만들면 공개 벡터도 다시 생성해야 합니다.

`SharedPolicy`에 공식 `tokenId`를 추가하면 v3 자산 그룹으로 검증합니다. 테스트넷 native USDC 주소는 `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`입니다. [Circle 공식 주소](https://developers.circle.com/stablecoins/usdc-contract-addresses)를 확인하고 USDC.e와 구분하세요. `examples/usdc-policy.template.json`의 registry·코드 해시는 실제 새 배포 값으로 교체해야 합니다.

SDK `sdk/ft.ts`:

- `parseUsdc`, `quoteFtFees`: 부동소수점 없이 6자리 USDC 금액과 원금에 가산하는 수수료 계산; 토큰과 yoctoNEAR를 합산하지 않음.
- `buildFtRegistration`: 토큰에서 읽은 storage minimum으로 명시적 NEP-145 등록 payload 작성.
- `buildStoragePrepayment`: 실제 `get_storage_credit` 결과에 맞춰 첫 bond·잔여 credit을 계산.
- `buildFtDeposit`, `buildFtWithdrawal`: 검증된 catalog와 증명 목적지에 묶은 token call, storage 대상, 최종 상태 확인 방법 작성.

`shared-note`, `shared-deposit-args`, `shared-spend-args` CLI는 v3 정책도 처리합니다. 전송 전에 실제 지갑이 수신 vault/registry/treasury/수신자를 토큰에 등록하고, 토큰 송금자에게 필요한 NEAR storage credit을 적립해야 합니다. 새 implicit 지갑은 NEAR 계정 생성과 FT 등록을 모두 마쳐야 USDC를 받을 수 있습니다. 성공한 `ft_transfer_call`은 토큰 수락만 뜻하며 지급 완료는 `get_withdrawal`의 `Complete`로 판단합니다.

FT 증빙은 `SettlementBundle { version: 3, assetTokenId, ... }`를 사용합니다. 토큰 ID를 확정 로그와 함께 검증하고, 토큰 protocol fee와 NEAR storage fee를 별도 통화로 요약합니다. 상세 ABI·실패 복구·재배포 조건은 [Contract USDC 명세](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md)를 확인하세요. 기존 binary state에 덮어쓰는 업그레이드는 지원하지 않습니다.

## 공유 v2 사용 흐름

1. Contract를 빌드하고 독립적으로 확인한 forest/vault WASM 해시와 verifier 해시로 `examples/shared-policy.json`을 작성합니다. 모르는 계약에서 복사한 해시를 신뢰 기준으로 삼지 않습니다.
2. SDK가 하나의 최종 확정 블록에서 registry·vault의 코드, 빈 키 목록, 소속 그룹, 수수료와 가용 잔액을 검증합니다.
3. 수신자는 공통 그룹의 비밀 노트를 만들고 commitment만 송금자에게 전달합니다. 송금자는 검증된 vault에 직접 예치합니다.
4. SDK는 공통 트리를 재구성하고 로컬에서 증명을 생성합니다. 출금 시 선택한 vault와 수신자를 증명에 묶습니다.
5. Forest가 nullifier를 먼저 사용 처리하고 선택 vault가 원금을 직접 지급합니다. 실패 시 목적지와 사용 상태를 유지한 채 같은 요청을 재시도합니다.

```bash
# 비밀번호는 안전하게 입력하고 명령행 인자나 저장소에 넣지 않습니다.
read -rs CORE_NOTE_PASSWORD
export CORE_NOTE_PASSWORD

npm run cli -- discover-shared examples/shared-policy.json https://rpc.testnet.near.org
npm run cli -- shared-note examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json
npm run cli -- receipt examples/receipt-values.json private-receipt.json
npm run cli -- shared-deposit-args examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json RECEIPT_ROOT
npm run cli -- shared-spend-args examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json examples/withdraw-action.json withdrawal-args.json
```

위 명령은 payload를 준비합니다. 실제 NEAR 지갑이 서명·전송해야 합니다. action의 `vault`가 없으면 검증된 유동성에서 선택합니다. 원금 수신자 `target`과 새로운 `disclosureRoot`는 실제 값으로 교체합니다. Private transfer는 `kind: transfer`, `target: 수신자 commitment`를 사용하며 vault를 지정하지 않습니다.

Vault 입금이 `Active`로 등록되었는지 확인합니다. 등록 거절은 원래 송금자에게 principal + protocol fee를 환불할 수 있고, 네트워크 실패는 `retry_deposit`로 재개합니다. 출금은 forest의 `get_withdrawal`이 `Complete`여야 완료입니다. 요청 이벤트만으로 지급 완료를 판단하지 않습니다. 명세: [Shared v2](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/SHARED.md).

## 수수료

입금·출금 각각 원금의 **0.15%를 추가**로 내며 수신자는 원금 전액을 받습니다. NEAR는 yoctoNEAR, FT는 토큰 atomic units로 내림합니다. 보관 비용 0.02 NEAR와 가스는 별도입니다.

1 NEAR 기준 입금은 **1.0215 NEAR**, 출금은 별도로 **0.0215 NEAR**를 내고 수신자는 **1 NEAR**를 받습니다. v2에서 보관 비용은 forest 0.015 / vault 0.005로 배분하며 추가 요금이 아닙니다. 이전·재시도는 보관 비용만 납부하고 protocol fee를 중복 부과하지 않습니다.

```bash
npm run cli -- quote-fees 1000000000000000000000000
```

수취 주소는 초기화 시 `fee_recipient`로 고정합니다. 입금 수수료는 vault, 성공한 출금 수수료는 forest가 적립합니다. 확정 수수료만 고정 treasury로 회수하며 원금·대기 지급·환불·보관 잔액을 보호합니다. 수수료 전송 실패 시 장부를 복원합니다.

## 영수증·KYB·새 지갑

```bash
npm run cli -- wallet receiver-wallet.encrypted.json
npm run cli -- disclose private-receipt.json asset,amount,reference
npm run cli -- verify-bundle bundle.json https://rpc.testnet.near.org
```

새 implicit 지갑의 키는 사용자 기기에서 만들고 AES-256-GCM으로 암호화해 백업합니다. 계약이 비밀키를 생성·보관하지 않습니다. 비밀 노트를 잃으면 운영자도 복구할 수 없습니다.

영수증은 필드마다 독립 salt를 사용하며 **동작마다 새 root를 만듭니다**. 같은 root를 재사용하면 공개적으로 연결됩니다. v2 증빙은 실제 registry executor의 최종 확정 이벤트와 journal을 대조하고, vault·원금·수수료·공개 필드가 변조되지 않았는지 확인합니다. 선택한 TX의 포함·무결성을 검증하며 전체 이력·노트 간 자금 흐름·실명·세무 수리를 증명하지 않습니다.

기업 KYB는 신뢰한 외부 발급기관의 Ed25519 서명, subject commitment, 만료와 제공된 폐기 목록을 검증합니다. 실제 법인/실소유자 심사나 회로가 강제하는 자격 정책은 아닙니다. 미국·UAE 아부다비 세금/AI 초안은 후속 범위이며 [compliance/README.ko.md](compliance/README.ko.md)에 경계를 기록합니다.

## 한계

공유되는 것은 암호학적 membership 집합입니다. 작은 참여자 수, 시간·금액·수신자·가스 지갑·공개 자료로 추정될 수 있으므로 네트워크 익명성까지 보장하지 않습니다. 공통 registry는 논리적 상태 조정 지점이며 운영자 승인 키를 갖지 않습니다. RPC에 대한 신뢰는 남습니다.

Native NEAR v2와 USDC/NEP-141 v3, 고정 denomination, 공유 트리 총 256 output의 해커톤 코어입니다. 버전·자산마다 별도 도메인을 사용하며 기존 노트 자동 이전은 지원하지 않습니다. 가변 금액·cross-asset bridge, 실제 법정 신고, production 감사·분산 trusted setup은 포함하지 않습니다. 네트워크 label은 설정값이며 실제 메인넷 배포를 자동 차단하지 않습니다. 개발 setup은 로컬/테스트넷 시연용입니다.
