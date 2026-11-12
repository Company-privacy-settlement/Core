# Core

NEAR 위에서 기업·개인의 자금을 비공개 노트로 이전하고, 필요한 거래만 선택 공개하는 해커톤 프로토콜 코어.

```text
송금자 지갑 ── 예치 ──> 온체인 풀 ── ZK 노트 이전 ──> 수신자 소유 노트 ── 출금 ──> 수신자 지갑
                           │
                           └─ 거래 기록 커밋먼트 ──> 선택 공개 영수증 + 확정 TX 증빙 묶음
```

운영 서버가 비밀키나 자금을 보관하지 않습니다. 계약이 Groth16 증명을 직접 검증하며 출금 승인자가 없습니다. 외부 relayer는 누구나 사용할 수 있고, 증명에 지정된 수신자나 출력 노트를 바꿀 수 없습니다. NEAR 트랜잭션 서명에는 가스와 storage fee를 내는 계정이 필요합니다.

## 구현 범위

| 구성 | 현재 구현 |
| --- | --- |
| 자산 | Native NEAR, 풀마다 고정 denomination |
| 비공개 이전 | Circom + Poseidon + Groth16 BN254, 실제 증명 생성·온체인 검증 |
| 소유권 | 수신자가 생성한 비밀 노트, 송금자에게 commitment만 전달 |
| 이중 사용 방지 | 도메인별 nullifier, 소비 즉시 기록 |
| 출금 | NEAR 비동기 transfer, 성공 callback, 실패 시 같은 주소로만 재시도 |
| 영수증 | 8개 필드의 독립 salt + SHA-256 Merkle opening, 필드별 선택 공개 |
| TX 증빙 | 확정 TX·풀 계약 이벤트·온체인 journal을 대조 |
| 기업 KYB | 신뢰한 발급기관의 Ed25519 서명, 노트 commitment, 만료·폐기 검증 |
| 새 출금 지갑 | 수신자 기기에서 Ed25519 implicit 계정 생성, 첫 송금으로 온체인 계정 생성 |
| 분산 보관 | 키 없는 vault 자동 배포, 생성 실패 환불, 코드·키 검증 후 선택 |
| 세금·AI | 이후 단계. 미국 / UAE 아부다비 경계만 기록 |

## 실행

Node.js 22+, Rust 1.99.1, C/C++ 빌드 도구가 필요합니다. 데모가 공식 NEAR sandbox 2.14.1을 별도로 내려받습니다(Linux x64 / macOS arm64). 계약 빌드는 풀을 먼저 최적화하고 팩토리에 포함해 `artifacts/core_pool.wasm`, `core_factory.wasm`, `build-manifest.json`을 생성합니다.

```bash
npm ci
rustup target add wasm32-unknown-unknown
npm run check
npm test
npm run contract:test
npm run contract:build
npm run factory:test
npm run zk:setup
npm run demo
npm run demo:factory
```

`demo`는 별도의 로컬 NEAR 체인을 시작해 계약 배포, 예치, 실제 ZK 노트 이전, 출금, 이중 사용 거부, 수신자 변조 거부, 확정 TX 증빙 검증을 실행합니다. `demo-output/bundle.json`과 `verification.json`을 저장한 뒤 로컬 체인을 종료합니다. 이 파일의 TX는 테스트넷 TX가 아니며 체인 종료 후 RPC로 재조회할 수 없습니다.

`demo:factory`는 키 없는 vault 2개 배포, 실제 생성 실패와 환불, 팩토리 키 제거 후에도 가능한 생성, 직접 예치, 새 지갑 출금, vault 간 증명 재사용 거부와 TX 증빙을 검증합니다. 결과는 `demo-output/factory-validation.json`에 저장합니다. 자동 키 제거는 이 일회용 로컬 체인 안에서만 수행합니다.

`npm test`와 Rust 테스트는 커밋된 공개 검증 벡터를 사용하므로 ZK setup 없이 실행할 수 있습니다. 벡터를 새 setup과 맞춰 재생성하려면 `npm run vectors:generate`를 실행합니다. 벡터에 note 비밀값과 proving key는 포함되지 않습니다.

팩토리 테스트에는 포함할 vault WASM이 필요하므로 `contract:build` 이후 실행합니다. 공유 트리·공유 nullifier·비공개 cross-vault 이동은 아직 구현하지 않았습니다.

## 지갑과 연결하는 CLI

`examples/pool.json`의 계약 주소를 교체합니다. private note 파일은 AES-256-GCM으로 암호화하고 새 파일로만 저장합니다. 실제 지갑 서명·전송은 사용 중인 NEAR 지갑/CLI가 담당하며, 아래 명령은 호출 인자를 생성합니다.

```bash
# 별도 안전한 입력으로 환경변수를 설정. 비밀번호를 명령행 인자에 쓰지 않습니다.
read -rs CORE_NOTE_PASSWORD
export CORE_NOTE_PASSWORD

# 수신자가 실행. stdout의 paymentRequest만 송금자에게 전달합니다.
npm run cli -- note examples/pool.json receiver-note.encrypted.json

# 매 출금마다 새 외부 지갑이 필요할 때 수신자 기기에서 실행합니다.
npm run cli -- wallet receiver-wallet.encrypted.json

# 각 동작마다 새 영수증을 생성합니다.
npm run cli -- receipt examples/receipt-values.json private-receipt.json

# 예치 / 초기화 인자 출력
npm run cli -- deposit-args examples/pool.json receiver-note.encrypted.json RECEIPT_ROOT
npm run cli -- init-args examples/pool.json

# 온체인 get_commitments 결과를 commitments.json에 저장한 뒤 증명 생성
npm run cli -- spend-args examples/pool.json receiver-note.encrypted.json commitments.json examples/withdraw-action.json withdrawal-args.json

# 거래처/회계 담당자에게 공개할 필드만 출력
npm run cli -- disclose private-receipt.json asset,amount,reference

# 배포된 테스트넷 풀의 증빙 검증
npm run cli -- verify-bundle bundle.json https://rpc.testnet.near.org

# 신뢰한 빌드 해시로 factory-policy.json 작성 후 keyless vault 탐색
npm run cli -- discover-vaults examples/factory-policy.json https://rpc.testnet.near.org

# 팩토리의 코드·키·설정을 검증하고 새 vault 생성 인자 출력
npm run cli -- create-vault-args examples/factory-policy.json creator.testnet https://rpc.testnet.near.org
```

이후 `CORE_NOTE_PASSWORD`를 unset하고 암호화 노트를 안전하게 백업합니다. 비밀 노트를 잃으면 프로토콜 운영자도 복구할 수 없습니다. `transfer`의 `target`은 수신자가 만든 commitment이며, 송금자가 수신자의 비밀 노트를 대신 만들어 전달하지 않습니다.

## 계약 API

모든 금액은 yoctoNEAR 십진 문자열입니다. storage fee는 호출마다 0.02 NEAR, 초기 reserve는 1 NEAR입니다. 별도로 WASM 배포 storage 비용도 충당할 잔액이 필요합니다. storage fee는 반환하지 않고 계약 storage reserve로 남습니다.

| 메서드 | 핵심 인자 | attached deposit |
| --- | --- | --- |
| `new` | 직접 배포용: `network`, `denomination`, `verification_key` (base64) | 1 NEAR 이상 |
| `new_from_factory` | 위와 동일, 직접 부모 팩토리만 호출 가능 | 1 NEAR 이상 |
| `deposit` | `commitment`, `disclosure_root` | denomination + 0.02 NEAR |
| `transfer` | `output_commitment`, `disclosure_root`, `proof`, `public_inputs` | 0.02 NEAR |
| `withdraw` | `recipient`, `disclosure_root`, `proof`, `public_inputs` | 0.02 NEAR |
| `retry_withdrawal` | `nullifier` | 0.02 NEAR |
| views | `get_config`, `get_commitments`, `get_records`, `get_payout`, `is_spent` | 없음 |

`get_commitments` / `get_records`: `from_index`, `limit`. 가스는 변경 메서드에 300 Tgas를 권장합니다. `withdraw` 반환 성공 여부와 `get_payout`의 `Complete`를 확인해야 출금 완료입니다. 요청 이벤트만으로 지급 완료를 판단하지 않습니다.

## 프라이버시와 증명 범위

- 공개되는 정보: 예치 계정, 출금 주소, 고정 금액, 시간, relayer, output commitment, nullifier, receipt root. ZK는 사용한 입력 노트와 출력의 직접 연결을 숨깁니다. 실제 익명성은 풀 참여자 수와 사용 패턴에 좌우됩니다. 단일 참여자 데모가 익명성을 보장하지는 않습니다.
- 지갑 회전만으로 추적이 끊기지 않습니다. 수신자는 풀 안의 새 비밀 노트를 제어하며, 마지막 출금만 공개 주소로 보냅니다. 자신의 알려진 지갑으로 private spend를 직접 제출하면 계정 정보가 드러납니다.
- **동작마다 새 영수증과 salt를 생성합니다.** 같은 receipt root를 여러 동작에서 재사용하면 공개적으로 연결됩니다. 전체 영수증·노트·KYB 서류는 오프체인에 보관합니다.
- 증빙 묶음은 선택한 TX가 해당 풀에서 확정됐고 공개 필드가 원래 receipt root에 포함됐음을 검증합니다. 전체 자금 흐름의 연결성, 빠짐없는 거래 이력, 실명, 금액 필드의 경제적 진실, 세무 신고 수리는 증명하지 않습니다. 영수증의 당사자·목적 등은 작성자의 주장입니다.
- KYB 증명은 외부 기관이 실제 법인·실소유자 확인을 수행했다는 서명에 의존합니다. 현재는 지갑 SDK에서 검증하는 첨부 자료이며, 회로가 강제하는 입장 조건이 아닙니다. 폐기 목록 최신성도 검증 주체가 확보해야 합니다.

## 중앙화 경계

계약에는 owner, 강제출금, verifier 교체, pause, sweep 메서드가 없습니다. 네트워크·계약 주소·denomination이 증명 도메인에 포함되어 다른 풀로 replay할 수 없습니다. relayer에 관리자 권한이 없으며, 동일 증명을 먼저 제출해도 목적지를 바꿀 수 없습니다.

직접 배포한 계정에 full-access key가 남으면 그 키로 계약을 교체할 수 있습니다. 팩토리가 만든 vault는 키를 한 번도 추가하지 않습니다. 팩토리 자체는 초기화·검증 후 별도로 키를 제거해야 하며, SDK는 팩토리와 vault 모두 access key가 0개일 때만 승인합니다. 공개 네트워크의 키 제거는 자동화하지 않습니다. verifier hash와 WASM hash는 별도로 고정해 검증합니다. 탐색 조회는 하나의 최종 확정 블록에서 수행하며, RPC 운영자에 대한 신뢰는 여전히 필요합니다.

## 현재 제한

깊이 8, 총 256개 output note를 담는 append-only 트리입니다. 가득 차면 추가 예치/이전은 중단되고 기존 노트 출금은 가능합니다. 고정 denomination, 단일 노트 입출력이며 split/merge, FT/USDC, 가변 금액, 정기 급여, 실시간 KYB 서비스, 세금 계산, AI 법률 서류 준비는 후속 범위입니다.

로컬 1인 Groth16 setup은 개발용입니다. 이 설정과 새 회로는 감사되지 않았습니다. network 설정값은 `testnet` / `sandbox`만 허용하지만, 계약이 실행 중인 실제 네트워크를 식별하거나 메인넷 배포를 기술적으로 차단하지는 않습니다. 테스트넷/로컬에서만 사용하며, 실제 자금용 배포에는 별도 회로 검토·독립 setup·운영 검증이 필요합니다.

프로토콜 상세: [docs/PROTOCOL.md](docs/PROTOCOL.md). 자동 배포: [docs/FACTORY.md](docs/FACTORY.md). 분산 보관: [docs/DISTRIBUTED_VAULTS.md](docs/DISTRIBUTED_VAULTS.md). 확장 경계: [compliance/README.md](compliance/README.md).
