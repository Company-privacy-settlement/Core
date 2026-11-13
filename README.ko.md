# Core — NEAR 기반 기업 프라이버시 정산

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

Core는 기업 간 결제와 기업→근로자 송금을 위한 개발용 프로토콜입니다. 독립 볼트가 원금을 보관하고, 공유 ZK 노트로 자금이 있는 한 볼트에서 수취인에게 직접 지급합니다. 수취인은 서명된 인보이스를 발행하고, 지급자는 지갑 호출을 각각 검토하며, 증빙 보유자는 필요한 필드만 공개할 수 있습니다.

이 저장소는 SDK·로컬 증명 CLI·읽기 전용 API·확정 기록 인덱스·증빙 도구를 제공합니다. 브라우저 실행은 독립적으로 구성한 테스트넷 FT 그룹을 지원합니다. Native NEAR v2는 계약과 CLI에서 사용할 수 있습니다. 서비스와 Docs의 기본 언어는 영어입니다.

[서비스 개요](docs/SERVICE.md) · [웹 Docs](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/docs/) · [개발 현황](docs/ROADMAP.md)

## 저장소

| 저장소 | 역할 |
| --- | --- |
| [Core](https://github.com/Company-privacy-settlement/Core) | 브라우저/Node SDK, CLI 증명, API, SQLite 인덱스, 증빙 검증 |
| [Contract](https://github.com/Company-privacy-settlement/Contract) | Rust 계약, Circom 회로, 벡터, WASM·증명 아티팩트 |
| [Front](https://github.com/Company-privacy-settlement/Front) | Next.js 랜딩·영문 Docs·인보이스·노트·정산·증빙·샘플 KYB |

## 현재 기능

| 기능 | 구현 범위 |
| --- | --- |
| 프라이빗 정산 | Native NEAR v2와 토큰 고정 NEP-141 v3 그룹 분리, 고정 액면, 그룹별 총 256개 트리 출력 |
| 브라우저 노트 | FT 노트 로컬 생성, 암호화 파일 백업·재검증, 공개 입금 계획 |
| 지갑 실행 | 등록·스토리지·결제별 승인, 암호화 작업 기록, 확정 상태 확인·보수적 복구 |
| 인보이스 | 수취인 NEP-413 서명, v2 단위별 참조, v1 읽기, 부분·완납·지연·초과 지급 대사 |
| 인보이스 보관함 | 선택형 계정/네트워크별 암호화 저장·검색·열기·백업·복원·병합 |
| 수취 준비 | 계정 활성화와 토큰 등록 분리 확인, 실제 등록비 조회, 활성화 금액 임의 추정 없음 |
| 증빙 | 전체 영수증 암호화, 선택 필드 증명, 별도 루트 무결성 확인과 분리된 확정 TX 검증 |
| 공개 인덱스 | SQLite 체크포인트, 범위가 명시된 전체 샤드 TX 탐색, 검증된 출처·페이지 조회 |
| KYB | Front 로컬 샘플 접수와 SDK의 신뢰 발급자 서명 검사. 실제 사업자 심사는 후속 작업 |

## 서비스 흐름

1. 운영자로부터 독립적으로 배포 정책을 확보하고 네트워크·registry·토큰·액면·수수료 수취인·코드/검증기 해시를 Core API와 확인합니다.
2. Front **Private notes**에서 FT 노트를 생성하고 암호화 백업을 내려받아 다시 엽니다. API에는 공개 커밋먼트·루트만 보냅니다.
3. **Settlements**에 공개 입금 계획을 가져와 테스트넷 지갑을 연결하고 등록·스토리지·결제를 각각 승인합니다. 입금 기록이 `Active`여야 예치 완료입니다.
4. 원래 정책과 암호화 노트로 CLI에서 출금 증명을 생성합니다. 인보이스 결제는 서명된 수취 계정과 해당 단위의 참조에 고정합니다.
5. 앱에서 공개 출금 계획을 검토·승인합니다. 지급 기록의 `Complete`가 완료 기준이며, 지갑 응답이나 타임아웃만으로 성공·실패를 판단하지 않습니다.
6. 용도별 백업을 보관하고 필요한 영수증 필드만 공개합니다. 무결성·TX 포함·사업자 신원·세무 신고 수리는 서로 다른 검증입니다.

인보이스 결제 참조와 임의 영수증 루트는 별도 흐름입니다. Evidence 루트로 서명된 인보이스의 결제 참조를 대체할 수 없습니다.

## 수수료

입금과 출금에 각각 **원금의 0.15%를 추가**하며 자산 최소 단위에서 내림합니다. 수취인은 원금 전액을 받습니다.

| 예시 | 입금 | 출금 수수료 | 수취 원금 |
| --- | --- | --- | --- |
| 1 USDC 노트, 6자리 소수 | 1.0015 USDC | 0.0015 USDC | 1 USDC |
| Native 1 NEAR 노트 | 동작 스토리지 포함 1.0215 NEAR | 동작 스토리지 포함 0.0215 NEAR | 1 NEAR |

FT 동작 스토리지는 해당 동작당 0.02 NEAR이며 최초 송금자 credit에는 대상 계약별 0.005 NEAR 원장 보증금이 추가됩니다. 토큰 등록·계정 활성화·네트워크 가스는 별도입니다. 새 노트를 예치하는 지급자는 입금 측 수수료도 냅니다. [운영 가이드](docs/OPERATIONS.md)와 [FT 계약 명세](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md)를 참고하세요.

## Core 실행

Node.js **22.13.0+**가 필요합니다. SDK/API/인덱스 개발에는 Rust나 Contract 체크아웃이 필요하지 않습니다.

```bash
npm ci
npm run check
npm test
npm run build:client
```

실제 그룹 실행에는 독립 검증된 정책이 필요합니다. 템플릿의 자리표시자는 그대로 사용할 수 없으며 `.env` 파일은 자동 로드하지 않습니다.

```bash
export CORE_POLICY_FILE=/absolute/path/to/trusted-policy.json
export CORE_RPC_URL=https://rpc.testnet.near.org
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
```

기본 주소는 `127.0.0.1:3001`입니다. `/healthz`는 프로세스 생존, `/readyz`는 배포와 연결된 인덱스를 확인합니다. 인덱스를 연결하려면 동일한 정책·RPC·`CORE_INDEX_DB`로 별도 터미널에서 작업자를 먼저 실행하세요. [.env.example](.env.example) · [API 설정](docs/OPERATIONS.md) · [인덱스 설정](docs/INDEXER.md). 노트·지갑 키·비밀번호·업무 문서는 API에 보내지 않습니다.

## 버전별 릴리스 패키지

`npm run build:sdk`는 Node ESM·타입과 브라우저 클라이언트를 빌드합니다. `release:prepare`는 변경 없는 Core/Contract/Front 커밋을 고정하고 컨트랙트·proving 아티팩트·SDK·그룹 정책·API 주소를 묶습니다. `release:verify`는 별도로 받은 매니페스트 SHA-256으로 오프라인 검증합니다. 현재 릴리스는 샌드박스·테스트넷 개발용이며 배포·온체인 준비 상태를 보장하지 않습니다. [명령과 형식](docs/RELEASES.md) · [입력 템플릿](examples/release.template.json).

## 테스트넷 배포 도구

`deploy:plan`으로 테스트넷 릴리스·공개 배포 입력을 고정하고 `deploy:preflight`로 최종화된 네트워크·계정·키·토큰·비용을 확인합니다. `deploy:execute`는 원자적 초기화·FT 등록·명시적으로 승인한 키 제거 중 한 단계만 실행하고 공개 전송 의도를 영구 기록합니다. `deploy:reconcile`은 재전송 없이 조회하며 `deploy:verify`는 키 없는 배포를 검증합니다. 서명 키는 별도의 소유자 전용 로컬 파일로 관리하며 API에서 사용하지 않습니다. [명령·리허설](docs/DEPLOYMENT.md) · [입력 템플릿](examples/deployment.template.json).

## API·인덱서 서버 운영

`build:service`로 운영용 코드를 컴파일하고 `serve:service`로 읽기 전용 API·단일 SQLite 인덱서의 초기 동기화와 프로세스 감시를 실행합니다. Docker/Compose는 선택적 Caddy HTTPS·영구 볼륨·재시작 정책을 제공하며 Render 설정도 포함합니다. 정책 해시·정확한 origin·인덱스 준비 검증을 요구하고 온라인 백업·덮어쓰지 않는 복원을 지원합니다. [서버 운영·복구](docs/HOSTING.md) · [VPS 환경 예시](ops/service.env.example). 실제 외부 배포에는 호스팅 대상과 배포된 테스트넷 정책이 필요합니다.

## 로컬 계약·증명 검증

Core·Contract·Front를 형제 폴더로 체크아웃합니다. Contract 빌드에는 고정 Rust **1.99.1**, WASM target과 C/C++ 빌드 도구가 필요합니다. Core에서:

```bash
(cd ../Contract && npm ci)
npm run contract:build
npm run zk:setup
(cd ../Contract && npm run build:test-ft)
npm run demo:ft
```

다른 경로는 `CORE_CONTRACT_REPO`로 지정합니다. Core는 WASM·증명 파일의 매니페스트 해시를 확인해 가져옵니다. 개발용 단일 머신 setup을 바꾸면 검증기·아티팩트·새 배포도 일치해야 합니다. 생성 파일은 Git에서 제외합니다.

**2026-11-13 기록된 검증:** Core **223개 테스트**, Front **98개 브라우저 케이스**와 타입/빌드, 실제 FT 샌드박스 **14개 확정 기록**. 샌드박스 토큰은 Circle USDC나 공개망 자금이 아닙니다. 위 명령으로 기록된 검증을 재현할 수 있습니다.

## 프라이버시·보관·복구

원금은 A→B→C를 경유하지 않습니다. 그룹 공유 트리가 입력 노트 membership을 숨기고 선택한 볼트가 직접 지급합니다. 그룹별 프라이버시 집합은 별도입니다. 수취 계정·서명자·금액·시간·볼트 잔액·nullifier·공개 참조로 거래를 연결할 수 있으며 볼트 수가 실측 익명성 집합은 아닙니다. Keyless registry의 상태 조정과 RPC/API 관측에 대한 신뢰가 남습니다.

브라우저 노트와 전체 영수증은 메모리 및 내려받은 암호화 파일에 둡니다. 작업 기록과 선택형 인보이스 보관함은 별도 브라우저 저장소에 암호화해 저장합니다. 잠금·페이지 캐시 처리는 진행 작업을 무효화합니다. 이미 열린 지갑 요청은 잠금으로 취소하지 못하며 저장된 서명 시도를 명시적으로 대사해야 합니다. 운영자는 잃은 노트 비밀값·암호를 복구할 수 없습니다.

미국/아부다비는 후속 준비 계층의 범위이며 미국 주와 ADGM/본토 구분이 필요합니다. AI 세무 초안·세율 규칙·실제 KYB 심사·법정 신고·법정화폐 전환·프로덕션 배포는 구현하지 않았습니다. [컴플라이언스 범위](compliance/README.md).

## 가이드

[지갑·복구](docs/WALLET.md) · [브라우저 노트](docs/BROWSER_NOTES.md) · [수취 준비](docs/RECIPIENTS.md) · [인보이스](docs/INVOICES.md) · [보관함](docs/INVOICE_LIBRARY.md) · [영수증](docs/BROWSER_RECEIPTS.md) · [그룹](docs/GROUPS.md) · [프라이버시](docs/PRIVACY.md) · [인덱스](docs/INDEXER.md) · [로드맵](docs/ROADMAP.md)

현재 호스팅은 소유자 비공개입니다. 외부 고객 결제에는 알맞은 접근 권한과 별도 배포·자금 공급된 그룹이 필요합니다. 공개 자금 배포는 포함하지 않습니다. 브라우저 Groth16 증명·가변 금액·프라이빗 그룹 이전·실제 컴플라이언스 연동·독립 보안 감사·검토된 다자 setup은 후속 작업입니다.
