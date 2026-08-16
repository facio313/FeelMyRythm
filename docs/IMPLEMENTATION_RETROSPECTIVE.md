# FeelMyRythm 구현 회고

함께 읽을 문서: [구현 기능 카탈로그](./FEATURES.md) · [아키텍처와 코드 읽기 가이드](./ARCHITECTURE_AND_CODE_GUIDE.md)

이 문서는 현재 `codex` 워크트리의 재구축 과정에서 드러난 실패, 잘못된 가정, 설계상 위험과 그 교정을 기록한다. 완성된 기능 목록이나 신규 참여자를 위한 구조 설명이 아니라, **왜 현재 계약이 필요해졌는지**를 남기는 문서다.

## 1. 기록 원칙

- 현재 코드와 테스트 링크는 **교정된 상태의 근거**다. 과거 결함의 소스 스냅샷이나 실행 로그를 보존했다는 뜻은 아니다.
- 작업 중 직접 재현된 실패와 설계 검토로 선제 발견한 위험을 구분한다. 정확한 발생 시각이나 책임 주체를 추정하지 않는다.
- 표에서 “실패했다·오류가 났다”는 직접 관찰한 실행 실패를, “가능했다·여지가 있었다”는 코드·설계 검토에서 확인한 위험을 뜻한다.
- 한 번의 대규모 E2E 실패가 곧 같은 수의 제품 결함을 뜻하지 않는다. 공통 fixture나 환경 오류가 여러 시나리오를 연쇄 실패시킬 수 있다.
- 로컬·CI에서 통과한 항목과 실제 기기·운영 환경에서만 닫을 수 있는 항목을 구분한다.

### 상태 표기

| 상태 | 의미 |
| --- | --- |
| **해결** | 현재 구현과 회귀 테스트가 교정 내용을 직접 확인한다. |
| **완화** | 자동화나 구조로 위험을 낮췄지만 특정 환경에서 재발 가능성이 남아 있다. |
| **외부 게이트** | 실기기, 실제 공급자, 운영 DB·RPi처럼 이 워크트리만으로 완료를 증명할 수 없다. |

## 2. 요약

가장 큰 문제는 개별 컴포넌트의 문법 오류보다 **경계에 대한 초기 가정**이었다.

1. 웹과 모바일, DB와 객체 저장소, 현재 사용자와 이전 사용자, 현재 인증 세대와 이전 인증 세대를 같은 경계로 취급했다.
2. DB transaction 밖의 객체 삭제, 분리된 악보 설정 저장, 검증되지 않은 이메일에 password를 먼저 묶는 흐름처럼 중간 실패 시 복구가 어려운 방향이 있었다.
3. HMR 서버와 병렬 변경 중의 통과 결과를 최종 워크트리의 증거로 보기 쉬웠다.
4. SQLite·브라우저 에뮬레이션·시뮬레이터가 PostgreSQL 잠금, ARM64 이미지, 실제 오디오·모바일 정책까지 증명해 줄 것처럼 범위를 넓혀 생각할 위험이 있었다.

최종 방향은 다음 네 가지 원칙으로 정리됐다.

- 서버 권위 오류와 network failure를 분리한다.
- 두 저장 시스템을 한 transaction처럼 취급하지 말고 durable outbox와 멱등 작업으로 연결한다.
- 인증·캐시·비동기 결과에는 사용자와 generation 소유권을 명시한다.
- 검증은 변경이 멈춘 source tree와 실제 배포 artifact를 대상으로 한다.

## 3. 기획·문서·검증·인프라

| 증상 또는 문제 | 근본 원인 | 영향 | 교정 | 예방·교훈 | 현재 상태 및 근거 |
| --- | --- | --- | --- | --- | --- |
| 구현 계획은 Vercel/Cloudflare Pages와 Fly.io/Railway 후보를 가리키는데 실제 목표는 GHCR ARM64 이미지, RPi, 외부 `cksDB`였다. | 초기 제품 계획과 나중에 확정된 운영 토폴로지의 동기화가 늦었다. | 개발자가 잘못된 base path, DB 소유권, 이미지 빌드 위치와 배포 권한을 전제로 구현할 수 있었다. | 설계·구현 계획·에이전트 계약을 RPi 배포 구조로 맞추고, 운영 DB를 Compose가 생성하지 않도록 했다. | 운영 경로가 바뀌면 코드보다 먼저 단일 프로젝트 계약과 배포 문서를 갱신한다. | **해결** — [구현 계획](./IMPLEMENTATION_PLAN.md), [프로젝트 계약](../AGENTS.md), [운영 Compose](../docker-compose.prod.yml) |
| 병렬 작업 중 일부 게이트가 통과한 뒤 다른 변경이 유입됐고, 로컬 Playwright는 기존 HMR 서버를 재사용할 수 있었다. | 변경 중인 source tree와 mutable dev server를 검증 대상으로 삼았다. | 이미 통과한 결과가 최종 파일 집합을 증명하지 못했고, 후속 결함을 놓치거나 원인 분류가 어려워졌다. | 마지막에는 변경 유입을 멈추고 공유 서버를 종료한 뒤 전체 게이트를 다시 실행했다. CI는 fresh checkout과 새 서버를 사용한다. | 검증 전후 source fingerprint를 비교하고, 최종 게이트 동안에는 편집·생성·동기화를 병행하지 않는다. 로컬 `reuseExistingServer` 결과는 개발 피드백일 뿐 release proof가 아니다. | **완화** — 로컬 재사용 조건은 [Playwright 설정](../playwright.config.ts)에 남아 있고, CI fresh run은 [Validate workflow](../.github/workflows/ci.yml)가 담당한다. |
| 최종 표준 E2E가 한 차례 28개 중 19개 실패로 무너졌다. | IndexedDB fixture, StrictMode focus, 파트 탭 이동과 인증 mock 같은 공통 전제가 동시에 현행 계약에서 벗어났다. | 19개의 독립 제품 결함처럼 보였지만 일부는 한 fixture 오류의 연쇄 실패였고, 분류 없이 전체 재실행하면 진단 비용이 커졌다. | 실패를 DB bootstrap, 앱 셸 focus, 탭 키보드, 인증 mock 축으로 나눠 단일 spec에서 먼저 재현·교정한 뒤 전체 E2E를 다시 실행했다. | 대량 실패 시 가장 먼저 공통 setup·console/page error·첫 실패를 확인하고, 제품 결함과 harness 결함을 분리한다. | **해결** — [편집기 E2E](../e2e/editor.spec.ts), [반응형 E2E](../e2e/responsive.spec.ts), [악보 E2E](../e2e/scores.spec.ts), [세션 E2E](../e2e/session.spec.ts) |
| CPU 부하가 큰 병렬 build/E2E에서 timing-sensitive timeout과 flake가 섞였다. | 로컬 기본 E2E는 완전 병렬이고 OSMD/PDF 번들, Vite, 브라우저가 같은 자원을 경쟁했다. | 제품 회귀와 runner 포화를 혼동해 불필요한 코드 변경이나 무의미한 재실행을 할 수 있었다. | 의심 spec을 격리 재현하고 CI에서는 한 worker와 제한된 retry를 사용했다. IndexedDB의 promise 회수 오류는 아래의 결정론적 fixture 결함으로 별도 분류했다. | 같은 명령을 이유 없이 반복하지 말고, CPU·메모리·server log·page error를 먼저 분류한다. retry 성공만으로 제품 결함이 없다고 판단하지 않는다. | **완화** — CI의 `workers: 1`과 retry는 [Playwright 설정](../playwright.config.ts), 전체 실행은 [Validate workflow](../.github/workflows/ci.yml) 참고 |
| 배포가 성공한 Validate 실행의 정확한 commit과 결합되지 않거나, publish 전에 실제 runtime을 확인하지 못할 여지가 있었다. | workflow trigger, checkout SHA, artifact tag, 권한과 smoke가 하나의 불변 계약으로 묶이지 않았다. | 검증하지 않은 commit을 배포하거나, 실행 불가능한 ARM64 이미지를 registry에 게시할 수 있었다. | `workflow_run.head_sha`를 검증·checkout·tag·배포 인자로 고정하고, publish 전에 exact tag를 실행한다. publish/deploy 권한도 분리했다. | “같은 브랜치”가 아니라 “같은 40자 SHA와 같은 image tag”를 검증 단위로 삼는다. | **해결(구성)** / **외부 게이트(실배포)** — [배포 workflow](../.github/workflows/deploy.yml), [runtime smoke](../.github/scripts/smoke-runtime-images.sh) |
| runtime smoke의 public API base에 `/api`까지 넣어 앱의 base 계약과 이중 prefix가 될 수 있었고, 서버 root filesystem도 처음에는 쓰기 가능했다. | 환경변수 이름의 의미와 운영 hardening을 실제 container 동작으로 검사하지 않았다. | smoke가 잘못된 경로를 허용하거나 침해 시 쓰기 범위를 넓힐 수 있었다. | public base는 `/feelmyrythm`까지로 고치고, server는 read-only root와 `/tmp` tmpfs로 실행하며 실제 쓰기 성공·실패를 검사한다. | 설정 문자열뿐 아니라 container 내부의 effective mount, UID, CMD, migration, health를 확인한다. | **해결** — [runtime smoke](../.github/scripts/smoke-runtime-images.sh), [운영 Compose](../docker-compose.prod.yml), [서버 Dockerfile](../apps/server/Dockerfile) |
| E2E 종료 코드를 보존하는 zsh wrapper에서 `status`라는 읽기 전용 변수를 사용해 사후 source fingerprint 단계가 중단됐다. | shell별 예약 변수 차이를 고려하지 않은 임시 명령이었다. | Playwright 결과 자체와 별개로 “실행 후 source 불변” 증거가 한 번 누락됐다. | 다른 변수명으로 wrapper를 고쳐 사후 검사를 별도로 다시 수행했다. | 임시 검증 스크립트도 `set -Eeuo pipefail`과 shell 예약어를 고려하고, 테스트 결과와 wrapper 결과를 분리 기록한다. | **해결** — 저장소 코드 영향 없음 |
| 광범위 secret scan이 생성된 중첩 dependency까지 들어가 방대한 minified 출력을 만들었다. | 진단 scan 범위를 active source/config로 먼저 제한하지 않았다. | 실제 secret 판단에 도움이 되지 않는 노이즈가 커지고 검토 시간을 낭비했다. | 활성 소스·설정·workflow를 우선 검사하고 generated/dependency 결과는 별도 진단으로 분류했다. | zero-match 자체가 목표가 아니다. credential assignment와 공개 resource identifier, generated provenance를 먼저 분류한다. | **해결** — 저장소 파일 변경이나 실제 credential 발견 없음 |
| SQLite 단위 테스트만으로 PostgreSQL row lock·최초 insert 경합을 증명할 수 없고, x86 개발 환경만으로 ARM64 runtime을 증명할 수 없었다. | 편리한 로컬 대체 환경의 증명 범위를 실제 운영과 동일시할 위험이 있었다. | production에서만 나타나는 동시성·migration·아키텍처 오류가 남을 수 있었다. | PostgreSQL 전용 migration/경합 테스트와 실제 ARM64 image smoke를 별도 게이트로 만들었다. | substitute runtime의 통과는 smoke일 뿐이다. 운영 고유 의미가 있는 축은 같은 엔진·아키텍처로 검증한다. | **완화** — [PostgreSQL 테스트](../apps/server/tests/test_postgres_migration.py), [runtime smoke](../.github/scripts/smoke-runtime-images.sh); 실제 RPi는 외부 게이트 |

## 4. 인증·보안·오프라인·네이티브 경계

| 증상 또는 문제 | 근본 원인 | 영향 | 교정 | 예방·교훈 | 현재 상태 및 근거 |
| --- | --- | --- | --- | --- | --- |
| 테스트와 E2E fixture가 token과 user를 분리 저장하던 구형 형식 또는 `hasPassword`가 없는 user를 계속 사용했다. | 인증을 단일 atomic envelope로 바꾼 뒤 소비자와 fixture를 함께 이행하지 않았다. | 실제 앱과 다른 로그인 상태가 만들어지고, 설정·탈퇴 분기 실패가 제품 결함처럼 나타났다. | `fmr.auth.session.v1` envelope로 원자 저장하고 구형 완전한 pair만 이행한다. 불완전한 user는 `/users/me`로 보강하고 fixture도 현행 형식으로 맞췄다. | persistence schema 변경은 loader, migration, logout, 테스트 seed를 하나의 변경 집합으로 취급한다. | **해결** — [AuthProvider](../apps/web/src/lib/auth.tsx), [인증 저장소 테스트](../apps/web/src/lib/auth.test.tsx), [편집기 E2E](../e2e/editor.spec.ts) |
| 동시에 발생한 401이 refresh를 중복 호출하거나, 오래 걸린 이전 refresh가 다른 계정의 새 로그인을 덮을 수 있었다. 한때 network/5xx refresh 실패도 로그아웃으로 취급했다. | 비동기 결과에 시작 token generation의 소유권이 없었고 모든 refresh 실패를 인증 거부로 일반화했다. | token rotation 충돌, 다른 사용자로의 identity rollback, 일시적 장애에서 불필요한 세션 폐기가 가능했다. | 동일 token pair는 single-flight로 refresh하고 결과 적용 전 현재 pair를 다시 비교한다. refresh endpoint의 권위 있는 401만 세션을 지우며 network/5xx는 현재 identity를 보존한다. | 비동기 인증 결과는 “요청 시작 당시 상태”가 아니라 “완료 시점의 현재 generation”에 조건부 적용한다. | **해결** — [API client](../apps/web/src/lib/api.ts), [refresh race 테스트](../apps/web/src/lib/api.test.ts) |
| 가입 첫 단계에서 password를 받는 기존 방향은 공격자가 피해자 이메일을 먼저 등록해 hash를 심는 preclaim 위험이 있었다. | 이메일 소유권 검증 전 credential을 계정에 영구 결합했다. | 피해자가 메일 링크를 열어도 공격자가 정한 password가 남거나 계정 takeover로 이어질 수 있었다. | 첫 단계는 이름과 이메일만 저장하고 password/session은 만들지 않는다. 메일 소유자가 1회용 링크에서 새 password를 정할 때 기존 legacy hash를 반드시 덮어쓴다. 검증된 Google 이메일은 미검증 선점 계정을 안전하게 회수한다. | identity proof 전에 재사용 가능한 credential을 저장하지 않는다. verification completion이 credential 생성의 transaction 경계여야 한다. | **해결** — [인증 router](../apps/server/app/routers/auth.py), [preclaim 회귀 테스트](../apps/server/tests/test_auth.py) |
| 기존 PWA Service Worker의 `fmr-api` runtime cache가 인증 API 응답을 남길 수 있었다. 새 worker만 수정해도 구형 controller의 late write가 남을 수 있었다. | asset caching과 사용자별 authenticated response의 보안 경계를 구분하지 않았고, worker 교체를 best-effort cleanup으로 봤다. | 로그아웃·계정 전환 후 이전 사용자의 응답 노출 가능성이 생겼다. | React mount 전 민감 cache를 fail-closed로 삭제하고 safety generation이 표시된 worker의 제어권, 구형 worker 종료, 전환 후 재삭제를 확인한다. nginx와 새 worker는 API를 캐시하지 않는다. | cache migration은 정상 앱 안의 편의 기능이 아니라 앱 시작 전 보안 gate다. 실제 구형 worker의 late write까지 브라우저에서 재현한다. | **해결** — [PWA 보안 이행](../apps/web/src/lib/pwaCache.ts), [단위 테스트](../apps/web/src/lib/pwaCache.test.ts), [실제 worker upgrade E2E](../e2e/pwa-upgrade.pwa.ts), [nginx](../nginx/nginx.conf) |
| 원격 IndexedDB snapshot이 사용자 식별자 없이 저장될 수 있었다. | offline cache를 device 단위 데이터로 보고 인증 principal을 key의 일부로 만들지 않았다. | 한 브라우저에서 계정을 바꾸면 다른 사용자의 템포맵·악보·주석이 fallback으로 보일 수 있었다. | schema v3 원격 store를 `userId` 복합 키로 만들고, 소유자를 알 수 없는 구형 원격 row는 migration에서 폐기한다. 로그아웃 뒤에는 다른 identity가 그 partition을 읽지 못하며, 계정 삭제 때 해당 사용자 cache를 지운다. | 인증 데이터의 모든 client persistence는 key, migration, deletion API에 principal을 포함해야 한다. | **해결** — [IndexedDB schema](../apps/web/src/lib/localDb.ts), [인증 cache 정리 테스트](../apps/web/src/lib/auth.test.tsx) |
| cache fallback이 403·404·409·검증 오류·5xx까지 가려 오래된 악보를 정상처럼 보여 줄 수 있었다. | 모든 fetch 실패를 “오프라인”으로 한 묶음 처리했다. | 권한 회수, 삭제, revision 충돌, 서버 장애를 사용자에게 숨기고 오래된 데이터를 수정할 수 있었다. | `TypeError` 기반 실제 network failure에서만 현재 사용자의 snapshot을 읽기 전용으로 연다. 서버 권위 오류는 그대로 표시한다. | cache는 availability 보조 수단이며 authorization·existence·conflict의 대체 권위가 아니다. | **해결** — [악보 화면](../apps/web/src/pages/ScoresPage.tsx), [Editor 화면](../apps/web/src/pages/EditorPage.tsx), [악보 API 테스트](../apps/web/src/lib/scoreApi.test.ts) |
| Google-only 탈퇴 메일의 fragment proof가 URL에 남거나, 로그아웃·다른 계정 로그인에서 유실되거나 잘못 적용될 여지가 있었다. | 비밀값의 보관과 올바른 계정으로의 route 복구를 한 컴포넌트 state에 묶었다. | browser history·화면 공유에 token이 노출되거나 다른 identity에서 삭제 modal이 열릴 수 있었다. | fragment를 즉시 제거하고 proof는 runtime memory broker에만 둔다. JWT의 id/email은 routing hint로만 사용하며 현재 id와 정규화 email이 모두 맞을 때만 modal을 재개하고 서버가 서명·만료·generation을 최종 검증한다. | URL secret은 소비 즉시 제거하고, route state에는 secret 대신 의도만 전달한다. client-decoded claims를 권위 검증으로 사용하지 않는다. | **해결** — [탈퇴 challenge broker](../apps/web/src/lib/accountDeletionChallenge.ts), [설정 화면](../apps/web/src/pages/SettingsPage.tsx), [설정 테스트](../apps/web/src/pages/SettingsPage.test.tsx) |
| 웹용 localStorage 추상화만으로는 native refresh token 보호가 되지 않았고, JS plugin 선언만 있어도 실제 iOS/Android bridge 등록이 빠지면 조용히 실패할 수 있었다. | Capacitor를 단순 웹 래퍼로 보고 플랫폼 credential store와 native project 등록을 별도 public surface로 다루지 않았다. | refresh token이 backup 가능한 평문 WebView 저장소에 남거나 release app에서 plugin을 찾지 못할 수 있었다. | iOS Keychain `ThisDeviceOnly`, Android Keystore AES-GCM plugin을 구현하고 양쪽 native entry point에 등록했다. JS는 native에서 fallback 없이 secure plugin을 요구한다. Android backup 제외 규칙도 둔다. | native 보안 기능은 TypeScript mock 통과만으로 완료되지 않는다. Swift/Java 등록, entitlement/backup rule, archive와 재설치 동작을 함께 확인한다. | **해결(코드)** / **외부 게이트(서명 archive·실기기)** — [JS storage adapter](../apps/mobile/src/secureStorage.ts), [iOS plugin](../apps/mobile/ios/App/App/SecureStoragePlugin.swift), [Android plugin](../apps/mobile/android/app/src/main/java/work/bonifacio/feelmyrythm/SecureStoragePlugin.java), [단위 테스트](../apps/mobile/src/secureStorage.test.ts) |
| native WebView에서 browser용 Google GIS를 그대로 노출하는 방향은 cookie/popup 정책과 native 보안 경계를 충족하지 못했다. | 웹과 native를 동일한 인증 실행 환경으로 간주했다. | 로그인 버튼이 작동하지 않거나 스토어 환경에서 불안정한 인증 UX를 만들 수 있었다. | native build에서는 GIS button/SDK를 숨기고 이메일 가입·로그인을 제공한다. browser에서는 Google 로그인을 유지한다. | 공유 UI와 플랫폼별 identity provider surface를 분리한다. native Google 로그인이 필요하면 정식 native SDK 흐름을 별도 설계한다. | **완화** — [Google 버튼](../apps/web/src/components/GoogleSignInButton.tsx), [로그인 화면 테스트](../apps/web/src/pages/LoginPage.test.tsx); native Google SDK는 현재 범위 밖 |

## 5. 실시간 동기화·오디오·서버 계약

| 증상 또는 문제 | 근본 원인 | 영향 | 교정 | 예방·교훈 | 현재 상태 및 근거 |
| --- | --- | --- | --- | --- | --- |
| `stop()`의 `AudioContext.suspend()`가 끝나기 전에 빠르게 다시 시작하면 뒤늦은 suspend가 새 재생을 멈출 수 있었다. | start와 stop을 독립 비동기 호출로 보고 lifecycle 순서를 직렬화하지 않았다. | UI는 재생 중인데 소리가 없거나 첫 박이 누락되는 race가 생길 수 있었다. | 하나의 `lifecyclePromise`에 start/stop을 순서대로 연결해 in-flight suspend 후 반드시 resume하도록 했다. | platform lifecycle API는 현재 state 확인만으로 충분하지 않다. 이전 operation의 완료 순서까지 소유해야 한다. | **해결** — [WebAudio engine](../packages/audio/src/webAudioEngine.ts), [rapid restart 테스트](../packages/audio/test/webAudioEngine.test.ts) |
| 늦게 방에 들어온 client가 이미 지난 요청 마디의 경계에 click을 예약하거나 첫 박을 건너뛰는 문제가 있었다. | server start anchor가 과거가 됐을 때 “요청 마디 유지”와 “다음 안전 경계 합류”를 구분하지 않았다. | 참가자가 서로 다른 박에서 시작하거나 과거 시각을 현재 시각으로 clamp해 어긋날 수 있었다. | 현재 경계가 아직 schedulable한 경우만 유지하고, 아니면 타임라인의 다음 마디 경계에서 합류한다. | late join은 단순 seek가 아니다. 권위 anchor, 현재 clock, lookahead 허용 범위를 함께 테스트한다. | **해결** — [metronome hook](../apps/web/src/lib/useMetronome.ts), [late-join 테스트](../apps/web/src/lib/useMetronome.test.ts), [WS 통합 테스트](../apps/server/tests/test_websocket.py) |
| 방이 “현재 템포맵”만 참조하면 세션 도중 편집 후 참가자별로 다른 revision을 펼칠 수 있었다. | repertoire와 mutable latest map만 식별하고 session의 immutable input을 고정하지 않았다. | 결정론적 동기화의 전제가 깨져 같은 명령에도 다른 beat sequence가 생성될 수 있었다. | 방 생성 시 최신 revision 번호를 고정하고 exact `TempoMapRevision` row를 다시 검증해 room과 transport payload에 보존한다. | 동기화는 이벤트 스트림보다 입력 snapshot의 동일성이 먼저다. 세션 생성 이후 latest를 다시 읽지 않는다. | **해결** — [room manager](../apps/server/app/rooms.py), [room API](../apps/server/app/routers/rooms.py), [revision·late join 테스트](../apps/server/tests/test_websocket.py) |
| 템포맵이 JSON object라는 정도만 확인하면 구간 gap, 중복 id, 잘못된 accent 길이, revision/repertoire 불일치가 저장될 수 있었다. | Pydantic 필드 형식 검증과 음악 도메인의 의미 검증을 동일하게 봤다. | core에서만 뒤늦게 실패하거나 서버에 펼칠 수 없는 revision이 영구 저장될 수 있었다. | 서버 schema에 strict nested model과 semantic validator를 두고 모든 계약 branch를 422로 거부한다. | 생성 소비자 한 곳의 검증에 의존하지 말고, 영구 저장 경계에서 독립적으로 같은 불변식을 검사한다. | **해결** — [TempoMap schema](../apps/server/app/schemas.py), [malformed 계약 테스트](../apps/server/tests/test_permissions_revision.py), [core 검증](../packages/core/src/validation.ts) |
| 자연 종료는 UI의 `playing`만 내리고 browser WakeLock/native KeepAwake를 남길 수 있었고, stop·unmount와 겹치면 중복 해제도 가능했다. | 로컬/동기 재생과 종료 원인마다 power cleanup을 따로 처리했다. | 배터리 소모, 화면 꺼짐 정책 불일치, native plugin 중복 호출이 생길 수 있었다. | 공용 power lifecycle과 idempotent active flag를 두고 자연 종료·명시 stop·unmount 중 최초 경계가 정확히 한 번 해제한다. | 자원 획득과 해제는 같은 ownership token으로 묶고 모든 terminal path를 표로 테스트한다. | **해결** — [metronome hook](../apps/web/src/lib/useMetronome.ts), [power cleanup 테스트](../apps/web/src/lib/useMetronome.test.ts), [native bridge](../apps/mobile/src/nativeBridge.ts) |
| WebSocket 인증 거부와 실제 network close를 같은 자동 재연결 대상으로 삼으면 만료 token으로 무한 재시도할 수 있었다. | close code의 의미와 auth generation별 refresh 한도를 구분하지 않았다. | 서버 부하, 배터리 소모, 잘못된 “연결 중” 상태가 지속될 수 있었다. | terminal close code를 분리하고 4401은 현재 auth generation에서 한 번만 refresh한다. 실제 network close만 backoff 재연결한다. | 재연결 정책은 transport error가 아니라 protocol semantic에 따라 결정한다. | **해결** — [room client](../apps/web/src/lib/roomClient.ts), [room client 테스트](../apps/web/src/lib/roomClient.test.ts), [WS 서버](../apps/server/app/ws.py) |

## 6. 악보·비동기 상태·객체 저장소

| 증상 또는 문제 | 근본 원인 | 영향 | 교정 | 예방·교훈 | 현재 상태 및 근거 |
| --- | --- | --- | --- | --- | --- |
| 선택한 악보나 repertoire가 바뀌는 동안 이전 요청이 늦게 완료되면 새 화면에 이전 데이터가 잠시 노출될 수 있었다. | 비동기 결과를 dependency별 요청 소유권 없이 공용 state에 반영했다. | 잘못된 파트·권한·악보를 표시하거나 후속 편집의 기준을 오염시킬 수 있었다. | dependency/reload마다 request key를 만들고 cleanup 시 이전 결과 소유권을 abort flag로 무효화한다. 현재 key와 같은 결과만 노출한다. | 모든 async loader에는 resource identity 또는 generation을 두고 로딩 전환 시 이전 data를 명시적으로 숨긴다. | **해결** — [useAsync](../apps/web/src/lib/useAsync.ts), [stale response 테스트](../apps/web/src/lib/useAsync.test.tsx) |
| IndexedDB v3 cache를 seed하는 E2E helper가 앱 migration 전에 DB를 열어 `remoteTempoMaps` store가 없는 `NotFoundError`를 냈고 evaluate promise가 회수됐다. | test가 production bootstrap과 별개로 내부 store 존재를 가정했다. | 편집기뿐 아니라 같은 browser context의 후속 시나리오까지 연쇄 실패했다. | 앱을 먼저 열어 실제 schema upgrade를 완료한 뒤 current store에 seed하고 transaction 완료를 기다리도록 fixture를 고쳤다. | migration 테스트는 object store를 흉내 내지 말고 실제 앱 bootstrap 또는 공유된 public migration 경로를 사용한다. | **해결** — [IndexedDB schema](../apps/web/src/lib/localDb.ts), [편집기 E2E seed](../e2e/editor.spec.ts) |
| 확대된 악보에서 pointer 좌표를 viewport나 보이는 이미지 기준으로 저장하면 zoom 전후 annotation과 마디 영역이 이동했다. | 좌표의 기준 surface가 계약으로 고정되지 않았다. | 필기, 마디 하이라이트, 파트 전환 재투영이 서로 다른 위치를 가리킬 수 있었다. | score page surface의 bounding rect 기준 0–1 좌표로 clamp해 저장하고 렌더링도 같은 surface를 사용한다. | 좌표 데이터는 화면 pixel이 아니라 어떤 공간의 정규화 값인지 schema·UI·테스트에 함께 명시한다. | **해결** — [악보 화면](../apps/web/src/pages/ScoresPage.tsx), [악보 E2E](../e2e/scores.spec.ts), [UI 설계](./UI_DESIGN.md) |
| Score metadata와 MeasureMap을 별도 요청으로 저장하면 하나만 성공할 수 있었고, 최초 map 생성 경합은 map row 자체를 잠글 수 없었다. | 화면의 한 번의 “정보 저장”을 두 DB transaction으로 나눴고 존재하지 않는 child row lock을 기대했다. | instrument/offset/map이 서로 다른 revision을 나타내거나 concurrent insert가 500/중복으로 끝날 수 있었다. | `/scores/{id}/settings`에서 expected map revision을 검사하고 metadata와 map을 한 transaction으로 저장한다. 최초 생성도 parent Score row를 잠그며 충돌은 409다. | UI action이 원자적이어야 한다면 API도 같은 aggregate boundary를 가져야 한다. 없는 row의 경합은 안정된 parent lock으로 직렬화한다. | **해결** — [악보 settings API](../apps/server/app/routers/scores.py), [client API 테스트](../apps/web/src/lib/scoreApi.test.ts), [PostgreSQL 경합 테스트](../apps/server/tests/test_postgres_migration.py) |
| DB row 삭제 전에 객체 저장소 파일을 먼저 지우는 방향은 DB commit 실패 시 살아 있는 Score가 없는 파일을 참조하게 만들었다. | 서로 다른 transaction system을 synchronous 순서만으로 원자화하려 했다. | 사용자 데이터가 복구 불가능하게 사라지고 재시도할 durable 기록도 남지 않는다. | DB transaction에서 관계형 row 삭제와 객체 key outbox를 함께 commit한 뒤 lease worker가 멱등 delete한다. 실패는 backoff 재시도하고 delete 후 ack 전 crash도 lease 만료 후 회수한다. | 외부 부작용은 DB commit 이전에 실행하지 않는다. at-least-once worker를 전제로 외부 연산을 멱등하게 만든다. | **해결** — [storage lifecycle](../apps/server/app/storage_lifecycle.py), [commit 실패·lease 테스트](../apps/server/tests/test_storage_lifecycle.py) |
| presigned upload를 final key에 바로 쓰고 Score를 즉시 보이게 하면 client가 complete하지 않거나 늦은 PUT이 도착할 때 반쪽 데이터가 남았다. | upload capability, 객체 존재, DB 가시성을 하나의 단계로 간주했다. | 목록에 다운로드 불가능한 악보가 보이거나 삭제 뒤 같은 URL로 객체가 되살아날 수 있었다. | 고유 staging key와 숨겨진 pending Score를 만들고, complete에서 잠근 row를 기준으로 staging→final promote 후 `ready`와 staging cleanup outbox를 commit한다. 만료 reaper와 late-write guard가 잔여물을 회수한다. | 외부 upload는 prepare/upload/finalize 상태 머신이어야 하며 final namespace를 capability target으로 직접 노출하지 않는다. | **해결** — [score upload API](../apps/server/app/routers/scores.py), [object storage](../apps/server/app/storage.py), [upload·reaper 테스트](../apps/server/tests/test_scores_logs_musicxml.py), [lifecycle 테스트](../apps/server/tests/test_storage_lifecycle.py) |
| 원격 악보 cache snapshot에서 MXL을 이미 정규화한 뒤 metadata만 바뀌어도 다시 unzip하려는 경로가 있었다. | blob의 실제 normalized content와 원래 filename/content type metadata를 동일한 신호로 사용했다. | offline 복원에서 정상 MusicXML을 손상된 압축 파일처럼 처리할 수 있었다. | snapshot에 정규화된 blob 의미를 유지하고 metadata 변경만으로 재압축 해제하지 않도록 했다. | 파생 artifact에는 원본 형식과 현재 payload 형식을 별도 필드로 표현한다. | **해결** — [악보 화면 테스트](../apps/web/src/pages/ScoresPage.test.ts), [MusicXML helper](../apps/web/src/lib/musicxml.ts) |

## 7. 반응형 UX·접근성·모바일 빌드

| 증상 또는 문제 | 근본 원인 | 영향 | 교정 | 예방·교훈 | 현재 상태 및 근거 |
| --- | --- | --- | --- | --- | --- |
| React StrictMode의 mount effect replay를 history POP처럼 오인해 첫 화면의 `h1` focus가 사라지고, 여러 viewport E2E가 같은 지점에서 실패했다. | navigation type만 보고 실제 history entry key가 바뀌었는지 확인하지 않았다. cleanup 때 초기 좌표도 복원 값처럼 기록했다. | 키보드·screen reader 사용자가 route 전환 위치를 잃고 새 페이지 scroll이 예측 불가능했다. | 이전 location key와 현재 key가 실제로 달라진 POP만 복원한다. 새 탐색은 top으로 이동하고 다음 frame에 `h1`, 복원 탐색은 main scroller에 focus한다. | StrictMode replay, PUSH, REPLACE, POP을 별도 상태 전이로 테스트한다. | **해결** — [AppShell](../apps/web/src/components/AppShell.tsx), [StrictMode·scroll 테스트](../apps/web/src/components/AppShell.test.tsx), [반응형 E2E](../e2e/responsive.spec.ts) |
| 악보 파트 탭에서 `Home`/`End`가 시각적 첫·마지막 탭을 선택하지 않거나 route 전환 후 focus가 이전 버튼에 남았다. | roving tab focus와 URL 기반 selection을 따로 갱신했고, 정렬된 DOM 배열을 단일 기준으로 쓰지 않았다. | `aria-selected`, 실제 악보, keyboard focus가 서로 달라져 키보드 탐색 계약을 위반했다. | 표시되는 `parts` 배열로 target을 결정해 route를 전환하고 target id를 보존해 새 DOM의 해당 tab으로 focus를 복원한다. | composite widget은 selection, focus, DOM order를 하나의 state machine으로 검증한다. 화살표뿐 아니라 Home/End도 E2E에 포함한다. | **해결** — [ScoresPage](../apps/web/src/pages/ScoresPage.tsx), [파트 탭 E2E](../e2e/scores.spec.ts) |
| 개인정보 처리방침의 계정 삭제 경로가 문서 아래쪽에 묻혀 있었고 inline 연락처/삭제 링크의 touch target이 44px보다 작았다. | 법적 텍스트가 존재하면 discoverability와 touch usability도 충족한다고 보았다. | 앱을 설치하지 않은 사용자가 삭제 경로를 찾기 어렵고 모바일 접근성 기준을 충족하지 못했다. | 페이지 상단에 독립 CTA를 배치하고 법적 action/link의 최소 높이를 44px로 보장했다. `/delete-account`는 로그인 전에도 절차를 설명한다. | 정책 충족은 URL 존재, 화면 내 발견 가능성, 실제 완료 흐름, touch target을 모두 확인해야 한다. | **해결** — [개인정보 화면](../apps/web/src/pages/PrivacyPage.tsx), [외부 삭제 안내](../apps/web/src/pages/AccountDeletionPage.tsx), [공용 CSS](../apps/web/src/index.css), [반응형 E2E](../e2e/responsive.spec.ts) |
| 웹의 절대 Vite base `/feelmyrythm/`와 상대 REST/WS를 그대로 Capacitor에 복사하면 asset은 WebView 안에서 잘못 해석되고 API는 `app.feelmyrythm.local`로 향했다. | 웹 subpath 배포와 native local asset origin을 동일한 origin/base 문제로 취급했다. | 설치 앱이 빈 화면이 되거나 운영 API에 전혀 연결되지 않을 수 있었다. | `mobile` Vite mode는 상대 asset base를 쓰고 PWA를 끈다. REST/WS만 `https://bonifacio.work/feelmyrythm`로 보낸다. Capacitor hostname은 앱 자산 origin으로만 쓴다. | asset base, router basename, API origin, WS origin을 플랫폼별 표로 먼저 정하고 bundle 결과를 검사한다. | **해결(빌드)** / **외부 게이트(실기기 네트워크)** — [Vite 설정](../apps/web/vite.config.ts), [경로 helper](../apps/web/src/lib/paths.ts), [Capacitor 설정](../apps/mobile/capacitor.config.ts) |
| 모바일 자산 검증기가 `index.html`이 직접 참조한 JS만 검사해, code-split된 `App` chunk의 잘못된 API origin을 놓쳤다. bootstrap 분할 후 `mobile sync`가 실제로 실패했다. | entry HTML의 정적 참조만 bundle 전체라고 가정했다. | 검증기가 통과해도 lazy/dynamic chunk에서 웹 origin이나 PWA 등록 코드가 남을 수 있었다. | emitted JS에서 상대 `.js/.mjs` 참조를 재귀 추적하고 bundle root escape를 막아 reachable chunk 전체에서 public origin과 PWA 부재를 검사한다. PDF.js의 단순 fallback filename처럼 존재하지 않는 문자열은 dependency로 오인하지 않는다. | code splitting이 있는 검증은 entry 파일이 아니라 reachable artifact graph를 대상으로 한다. | **해결** — [모바일 자산 검증기](../apps/mobile/scripts/verify-web-assets.mjs), [모바일 sync 명령](../apps/mobile/package.json), [모바일 안내](../apps/mobile/README.md) |
| 공용 input/select는 coarse pointer에서 48px 계약을 따르지 않고 일부 화면별 CSS만 커져 있었다. | touch target을 개별 버튼 문제로 보고 공용 primitive의 shared decision point에 두지 않았다. | 태블릿·펜 기기에서 form control만 작게 남고 화면별 회귀가 반복될 수 있었다. | 공용 `.fmr-input`과 핵심 target이 `--fmr-touch-target`을 사용하고 `any-pointer: coarse`에서 48px로 올라가도록 했다. | 반복되는 접근성 수치는 컴포넌트별 override가 아니라 token/primitive에 둔다. | **해결** — [UI primitive CSS](../packages/ui/src/primitives.css), [반응형 계약](./RESPONSIVE_UX.md), [반응형 E2E](../e2e/responsive.spec.ts) |

## 8. 아직 닫히지 않은 외부 게이트

아래 항목은 실패를 숨긴 것이 아니라 현재 로컬 증명의 경계를 명시한 것이다. 실행 환경과 계정·장비가 준비되기 전에는 **해결**로 바꾸면 안 된다.

| 외부 게이트 | 왜 로컬 증명으로 대체할 수 없는가 | 완료 조건 | 현재 근거 |
| --- | --- | --- | --- |
| 서명된 iOS/Android archive와 설치 | TypeScript·Swift·Java compile 또는 Capacitor sync는 실제 signing, entitlement, release manifest를 증명하지 않는다. | release archive 생성, clean device 설치·재설치, secure token backup/restore 동작 확인 | [모바일 release checklist](../apps/mobile/README.md) |
| Universal Link / App Link | 실제 Team ID, release signing certificate fingerprint와 운영 `.well-known` 응답이 필요하다. | 운영 AASA/assetlinks 게시 후 cold/warm launch에서 session/login/settings 링크 확인 | [association generator](../apps/mobile/scripts/association-files.mjs), [production preflight](../apps/server/scripts/production_preflight.py), [deep-link 테스트](../apps/mobile/src/deepLink.test.ts) |
| 무음 스위치·백그라운드·화면 꺼짐·인터럽트·마이크·햅틱 | 브라우저와 simulator는 실제 오디오 세션, 전화/알림 인터럽트, 기기 권한과 진동을 재현하지 못한다. | 지원 iOS/Android 실기기 matrix에서 수동·녹화 검증 | [네이티브 audio adapter](../apps/mobile/src/nativeAudio.ts), [iOS plugin](../apps/mobile/ios/App/App/NativeAudioPlugin.swift), [Android service](../apps/mobile/android/app/src/main/java/work/bonifacio/feelmyrythm/NativeAudioPlaybackService.java) |
| 30분 오디오 안정성과 2–3대 동기 ±10ms | fake clock과 단위 테스트는 oscillator/device output latency와 실제 Wi-Fi jitter를 증명하지 않는다. | 동시 녹음 파형으로 장기 drift와 기기 간 오차 측정, 허용 기준 기록 | [오디오 품질 도구](../scripts/audio_quality), [설계](./DESIGN.md) |
| 실제 SMTP·메일 deliverability·abuse 방어 | fake sender는 provider quota, spam 분류, DNS, CDN rate limit/CAPTCHA를 증명하지 않는다. | 운영 provider sandbox/production에서 발송·실패·queue saturation·enumeration/rate limit 확인 | [mailer](../apps/server/app/mailer.py), [메일 테스트](../apps/server/tests/test_mail_delivery.py) |
| 실제 S3 CORS·lifecycle·권한 | local storage와 mock S3는 bucket policy, CORS, lifecycle rule, transient provider failure를 증명하지 않는다. | 운영과 동일한 bucket에서 presign→PUT→complete→delete retry 및 lifecycle 확인 | [storage](../apps/server/app/storage.py), [환경 예시](../.env.example) |
| `cksDB` backup/restore와 migration | 격리 PostgreSQL은 공유 운영 DB의 백업 정책, 계정 권한, 복구 시간을 증명하지 않는다. | 사전 backup, staging restore, Alembic up/down 정책과 복구 runbook 실연 | [Alembic](../apps/server/alembic), [운영 Compose](../docker-compose.prod.yml) |
| RPi forced-command 배포·rollback | workflow와 ARM64 container smoke는 실제 SSH forced command와 서버측 deployer 상태를 증명하지 않는다. | 허용 SHA 배포, 임의 명령 거부, health 실패 rollback, 기존 DB/volume 무영향 확인 | [배포 workflow](../.github/workflows/deploy.yml), [runtime smoke](../.github/scripts/smoke-runtime-images.sh) |
| 느린 네트워크의 PDF/OSMD 성능 | production build 성공은 대형 dynamic chunk의 실제 다운로드·parse·render 시간을 증명하지 않는다. | 대표 저사양 모바일과 throttled network에서 첫 표시·페이지 이동·메모리 측정 | [악보 화면](../apps/web/src/pages/ScoresPage.tsx), [Vite 설정](../apps/web/vite.config.ts) |

## 9. 재발 방지를 위한 핵심 교훈

### 9.1 계약을 구현보다 먼저 고정한다

- 운영 URL, router basename, API·WS origin, DB 소유권, image architecture를 한 표에서 결정한다.
- mutable latest resource와 session-pinned immutable resource를 구분한다.
- “오프라인”을 HTTP 오류의 별칭으로 사용하지 않는다.

### 9.2 비동기 결과에는 소유자가 있어야 한다

- 인증 refresh에는 token generation을 둔다.
- 화면 loader에는 resource request key를 둔다.
- IndexedDB에는 user principal을 둔다.
- worker job에는 lease owner와 만료 시각을 둔다.

### 9.3 두 시스템 사이에는 실패 상태가 반드시 있다

- DB와 S3를 한 transaction처럼 보이게 하는 synchronous 순서는 원자적이지 않다.
- upload는 `pending → promote → ready`, delete는 `DB commit → outbox → leased delete → ack` 상태로 표현한다.
- retry가 있는 외부 부작용은 멱등해야 한다.

### 9.4 테스트 fixture도 public contract의 소비자다

- persistence schema를 바꾸면 E2E seed가 앱 migration을 우회하지 않는지 확인한다.
- auth fixture는 production envelope와 같은 필수 필드를 써야 한다.
- entry HTML만 보지 말고 code-split artifact graph를 검사한다.

### 9.5 통과 결과의 대상이 무엇인지 명시한다

- HMR 서버 통과, frozen source의 fresh browser 통과, exact ARM64 image 통과는 서로 다른 증거다.
- retry나 재실행 전에 product failure, fixture failure, runner contention, provider failure를 분류한다.
- 실제 기기·운영 계정이 필요한 조건은 로컬 통과 수치에 합치지 않는다.

## 10. 다음 작업용 체크리스트

### 설계·착수 전

- [ ] [프로젝트 계약](../AGENTS.md), [설계](./DESIGN.md), [구현 계획](./IMPLEMENTATION_PLAN.md), [반응형 계약](./RESPONSIVE_UX.md)이 현재 운영 목표와 일치하는가?
- [ ] 데이터의 권위, cache fallback 조건, user partition, revision/generation이 명시됐는가?
- [ ] 하나의 UI action이 여러 DB row나 외부 저장소를 바꾼다면 transaction/outbox 경계가 정해졌는가?
- [ ] 웹·PWA·Capacitor·서버의 asset base, REST origin, WS origin이 각각 정해졌는가?
- [ ] SQLite/mock/simulator로 증명할 수 없는 항목을 먼저 표시했는가?

### 구현 중

- [ ] 비동기 요청이 늦게 끝나도 현재 사용자·resource·generation을 덮지 않는가?
- [ ] migration, legacy fixture, logout/account deletion cleanup을 함께 수정했는가?
- [ ] authorization·404·409·5xx를 cache가 숨기지 않는가?
- [ ] external side effect가 DB commit 전에 실행되지 않는가?
- [ ] 실패 후 retry가 멱등이며 lease/ack crash를 복구하는가?
- [ ] 공용 접근성 규칙을 개별 화면이 아니라 token/primitive에서 해결했는가?

### 완료 선언 전

- [ ] 병렬 편집·생성 작업을 멈추고 source tree를 고정했는가?
- [ ] HMR 공유 서버가 아닌 fresh client/server에서 표준 E2E를 실행했는가?
- [ ] format, lint, typecheck, unit, server, protocol generation, build, 일반 E2E, PWA upgrade E2E를 현재 tree에서 실행했는가?
- [ ] PostgreSQL 고유 동시성과 migration을 실제 PostgreSQL에서 확인했는가?
- [ ] 게시할 exact ARM64 image tag의 default CMD, migration, health, non-root, read-only rootfs, nginx/API proxy를 실행했는가?
- [ ] 실패가 발생했다면 공통 fixture, product, runner, 외부 provider 중 어느 축인지 기록했는가?
- [ ] 위의 외부 게이트를 실제 담당자가 증명하기 전 release 완료로 표시하지 않았는가?

## 11. 회귀 증거 빠른 찾기

| 영역 | 우선 확인할 테스트·자동화 |
| --- | --- |
| 템포맵·revision·권한 | [서버 revision 테스트](../apps/server/tests/test_permissions_revision.py), [core validation 테스트](../packages/core/test/validation.test.ts) |
| 인증·메일·탈퇴 | [인증 테스트](../apps/server/tests/test_auth.py), [메일 테스트](../apps/server/tests/test_mail_delivery.py), [계정 삭제 테스트](../apps/server/tests/test_account_deletion.py), [웹 인증 테스트](../apps/web/src/lib/auth.test.tsx) |
| refresh race | [API client 테스트](../apps/web/src/lib/api.test.ts) |
| PWA cache 이행 | [PWA 단위 테스트](../apps/web/src/lib/pwaCache.test.ts), [실제 upgrade E2E](../e2e/pwa-upgrade.pwa.ts) |
| 악보·cache·좌표·키보드 | [score API 테스트](../apps/web/src/lib/scoreApi.test.ts), [악보 E2E](../e2e/scores.spec.ts), [악보 화면 테스트](../apps/web/src/pages/ScoresPage.test.ts) |
| 객체 저장소 lifecycle | [storage lifecycle 테스트](../apps/server/tests/test_storage_lifecycle.py), [upload 테스트](../apps/server/tests/test_scores_logs_musicxml.py) |
| 실시간·오디오 | [WebSocket 테스트](../apps/server/tests/test_websocket.py), [scheduler 테스트](../packages/audio/test/scheduler.test.ts), [WebAudio 테스트](../packages/audio/test/webAudioEngine.test.ts), [metronome hook 테스트](../apps/web/src/lib/useMetronome.test.ts) |
| 앱 셸·반응형·접근성 | [AppShell 테스트](../apps/web/src/components/AppShell.test.tsx), [반응형 E2E](../e2e/responsive.spec.ts), [접근성 E2E](../e2e/ux-accessibility.spec.ts) |
| 모바일 경계 | [native bridge 테스트](../apps/mobile/src/nativeBridge.test.ts), [secure storage 테스트](../apps/mobile/src/secureStorage.test.ts), [deep-link 테스트](../apps/mobile/src/deepLink.test.ts), [자산 검증기](../apps/mobile/scripts/verify-web-assets.mjs) |
| 전체 CI·배포 artifact | [Validate workflow](../.github/workflows/ci.yml), [Deploy workflow](../.github/workflows/deploy.yml), [runtime image smoke](../.github/scripts/smoke-runtime-images.sh) |
