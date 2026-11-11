# Current work — main/dev migration (2026-11-12)

- User requested only main (production) and dev (development/local), latest remote main fetched first.
- Baseline: origin/main f117da36c7b2b5fea87daa168b7114f7a0e2ca32; current production remains at that release.
- Legacy cursor 6255209 history merged into dev without reviving the old page extraction or unvalidated join-code proposal. Validated main code remains authoritative; all original remote histories have a verified durable Git bundle.
- Canonical authentication mapping: main=sso, dev=local, other branches rejected. Actual dev checkout guards local commands; CI validates main/dev and publishing/deployment accepts main only.
- Replaced destructive worktree setup with a preserve-first dev setup. Updated AGENTS, README, OPERATIONS and environment guidance.
- Validation: server 175 passed / 4 skipped (PostgreSQL and Redis integration services not configured); web auth contract 8 passed; shell auth/actual-dev guards and changed Python lint passed. Original-worktree migration is in progress. Original main/cursor file reads have timed out; their unknown local edits have not been overwritten or deleted.
- CI follow-up corrected obsolete e2e/OpenAPI fixture branch labels and the expanded shell-check assertion. Contract tests (22), OpenAPI byte equality and dev web build pass. Full CI is rerunning on the corrective commit.
- Fleet records and rollback bundles: ~/.local/share/cks-main-dev-migration/2026-11-12/.

## Prior completed release

## 통합 CI의 짧은 데스크톱 회귀 교정 — 로컬 검증 완료 (2026-11-12)

- 첫 통합: codex `45fafe4`, main `d4b7986`. [Validate 43107679240](https://github.com/facio313/FeelMyRythm/actions/runs/43107679240)에서 서버 176 + 별도 PostgreSQL migration 3, protocol·Android·iOS·웹 단위/빌드는 통과했으나 전체 브라우저는 91개 통과·2개 실패했다. PWA와 운영 배포는 이 실패를 통과로 처리하지 않는다.
- 확인된 결함: `e2e/responsive.spec.ts:285`의 일반 메트로놈 재생 버튼이 1024×390에서 bottom 524.28125, 840×641에서 647.390625로 viewport 아래에 있었다. 각 두 번의 retry에도 동일했다. 로컬 선정 22개 시나리오에는 이 두 경계가 포함되지 않아 최초 검토에서 놓쳤다.
- 교정: 작업 공간 stage 간격을 20→16px로 줄이고 짧은 2열 작업 공간은 stage row를 `min-content`, controls를 위쪽 정렬로 두었다. 기존 640px 경계와 테스트의 가시성 조건은 유지했다. 재생 버튼 bottom은 1024×390에서 345.80px, 840×641에서 639.39px로 화면 안에 들어왔다.
- 재검증: 실패한 2개와 인접 8개 크기에서 기존 primary-route E2E 10개를 retry 0으로 모두 통과했다. 별도 실제 브라우저 8개 치수의 재생 버튼/가로 overflow, build:e2e·CSS 포맷·diff 검사를 통과했다. 원본과 검증 CSS byte 일치. 변경은 CSS와 관련 설명/기록뿐이다.
- 배포 판정: 첫 실패 커밋의 [배포 43109270869](https://github.com/facio313/FeelMyRythm/actions/runs/43109270869)는 skipped였다. 후속 정확한 main SHA의 전체 CI와 운영 배포·공개 health를 확인하며 결과 commit/run URL은 최종 완료 보고로 연결한다. 실패한 CI나 로컬 성공만으로 운영 적용을 완료 처리하지 않는다.
- 환경 이력: 원본 Git 객체 읽기가 지연되어 동일 tree 또는 커밋된 원본과 SHA-1이 일치하는 blob 내용만 복구한 뒤 정상 푸시했다. 커밋 이력·refs를 재작성하지 않았다.

---

## 미커밋 템포맵·화면·문서 통합 릴리스 검토 — 완료 (2026-11-12)

- 요청/완료 기준: 남은 미커밋 변경을 검토·교정하고 codex 커밋·푸시, main 통합·CI·운영 배포와 공개 health 확인까지 수행한다. 이 기록은 커밋에 포함하는 코드 검토/로컬 검증 결과이며 실제 운영 적용은 아래 별도 배포 증거로 판단한다.
- 범위: 마디별 템포·페르마타·쉼표, Editor/재생/예비박/반응형 화면, 관련 문서·소스 읽기 가이드·생성 API 계약. 시작 codex `7b82590`, 운영 main `6b4fce7`의 후속 변경이다. 기존 사용자 데이터와 실행 중 미리보기, dev와 기존 main worktree는 보존한다.
- 발견/교정: 서버의 구간 템포 보간 연산 순서가 core와 달라 정확한 BPM 경계에서 서버만 저장을 허용했다. 두 언어의 `(delta × beatOffset) / totalBeats` 순서를 맞추고 107→30/11마디의 10마디 accel44와 120→30/10마디의 8마디 rit57 회귀를 각각 추가했다. 서버의 두 회귀는 수정 전 실패·수정 후 통과했다. 새 API 필드나 DB migration을 이 교정으로 추가하지 않았다.
- 검토 결과: 표현의 구간 경계/못갖춘마디/반복/기본값 무효화, 마지막 무음 꼬리, 원격 저장/직렬화와 UI 연결에서 추가 확정 결함은 발견하지 않았다. 문서의 과거 dev 경유 안내는 현재 승인된 tool→main 절차와 과거 workflow 조건의 차이를 설명하도록 바로잡았다.
- 로컬 검증: core 62 + audio 26 통과 후 경계 회귀 2개를 추가한 영향 파일 19개 통과, UI 연결 128 + BeatVisualizer 71, 서버 관련 74 통과. 웹·모바일·공용 package 타입, 변경 TS/TSX lint, 서버 Ruff/schema mypy, 포맷/diff 검사 통과. OpenAPI와 protocol 재생성 결과가 제출 파일과 일치한다.
- 브라우저/문서: 변경된 Editor·예비박·표현 재생 16개와 패드/데스크톱·터치 대상·200% 글자·홈 새로고침 6개, 합계 22개를 worker 1·retry 0으로 통과했다. 데스크톱 1280×800 표시를 직접 확인했다. 문서 로컬 파일 링크 1,287개와 내부 앵커 168개가 유효하며 소스 발췌 228개를 연결된 원본과 대조했다. 하드웨어 오디오 출력 오차는 측정하지 않았다.
- 환경/보존: 원본 dataless 의존성 대신 `/tmp/fmr-pending-release/check`에 frozen lockfile로 설치했다. 각 독립 검증에서 원본과 실행 소스 일치를 확인했고 최종 릴리스 파일을 대조한다. 운영 secret·공용 DB·volume·SSO 설정은 변경하지 않는다.
- 운영 증거: 승인된 main SHA의 [Validate](https://github.com/facio313/FeelMyRythm/actions/workflows/ci.yml?query=branch%3Amain)와 [Build and deploy to RPi5](https://github.com/facio313/FeelMyRythm/actions/workflows/deploy.yml?query=branch%3Amain)를 기준으로 한다. ARM64 image smoke·DB backup·canary·교체 후 dependency preflight와 공개 health를 확인하며, 정확한 commit/run URL과 최종 운영 결과는 이번 배포 완료 보고에 남긴다. 이 코드 검토 기록이나 과거 배포 성공만으로 새 운영 적용을 완료 처리하지 않는다.

---

## 라이브러리 개선 운영 배포 — 완료 (2026-11-12)

- 요청: 라이브러리 개선의 커밋·푸시·운영 배포까지 완료한다. codex에서 이번 개선만 별도 커밋하고 main으로 통합한다. dev와 기존 main worktree를 변경하지 않으며 기존 미커밋 템포맵·화면·코드 읽기 문서는 작업 트리에 보존한다.
- 릴리스 범위: PDF 문서 재사용/렌더 취소/DPR 처리, OSMD 수명 정리, MXL 선택 비동기 해제/입력 제한, 이미지 Blob URL 회수, Markdown memo, 미사용 zustand/Radix Tabs 제거와 해당 문서/회귀만 포함한다. 서버 schema·API·migration·동기화·이전 화면 변경은 제외한다.
- 근거: 전체 작업 트리는 Node 22.23.2에서 pnpm check(JS 504, 서버 173, 오디오 품질 9; DB/Redis 4 skipped), 관련 브라우저 5개, 모바일 web/자산 검사를 통과했다. 선택한 릴리스 tree의 관련 테스트 25개와 웹 타입 검사도 통과했다. 정확한 main SHA의 Validate 및 후속 immutable ARM64 publish/제한 배포를 최종 근거로 삼는다.
- 커밋/진행: codex `7b8259083e2a8da8f0a90150528fb88d1a2393a6` 푸시와 main `6b4fce7dad725b834d9cffeb151fe715a76a1475` 통합/푸시를 완료했다. [Validate 43102428067](https://github.com/facio313/FeelMyRythm/actions/runs/43102428067)의 5개 job 모두 성공했다(JS 433, 브라우저 79, PWA 2, 서버 137 + 별도 PostgreSQL migration 3, 오디오 품질 9). [운영 배포 43103950551](https://github.com/facio313/FeelMyRythm/actions/runs/43103950551)의 ARM64 이미지 생성·실제 이미지 통합 검사·GHCR 게시·제한 배포도 모두 성공했다. 운영 적용 완료는 2026-11-12 06:38:52 KST다.
- 배포/복구: 기존 GitHub Actions → 제한 SSH 배포기를 사용한다. DB backup·target canary·strict target-head 검증·서버/웹 실제 이미지 일치를 확인한다. migration 이후 server image-only rollback은 금지하며 실패 시 forward-fix한다. 백업 생성, 격리 canary, 교체 후 PostgreSQL·Redis·local storage·공개 HTTPS 검사가 모두 통과했다. 외부 재확인도 health HTTP 200과 `{"ok":true}`이며 원격 main/codex SHA를 ls-remote로 확인했다.
- 보존/범위: 격리 clone `/tmp/fmr-library-release/main`에서 main 통합을 수행했다. 기존 main worktree·dev는 변경하지 않았고 기존 작업 파일 56개는 시작 시점과 byte 일치다. 기존 미커밋 템포맵·화면·문서 작업과 이 최종 결과 기록은 로컬에 남겼다. 운영 secret·공용 DB·volume·SSO 설정은 변경하지 않았다. SMTP/association 검사의 skip은 기존 managed-local SSO/서명 모바일 조건에 따른 것이며 로그인 후 운영 UI 수동 재검사는 수행하지 않았다. 이 요청의 남은 필수 작업 없음.

---

## 라이브러리 사용 비용 개선 — 완료 (2026-11-12)

- 목표·결과: 실제 의존성/호출 경로를 조사하고 반복 계산·해제 누락을 수정했다. PDF.js는 Blob당 문서/worker를 재사용하고 페이지 전환은 RenderTask만 취소한다. 폭/DPR 변경과 재시도를 지원하며 늦은 작업은 화면을 덮지 않는다. OSMD 2.1.2에는 dispose가 없어 autoResize를 끄고 앱 소유 ResizeObserver·AbortSignal·별도 surface·clear로 수명을 관리한다.
- 추가 개선: MXL은 ZIP 목록 조사 후 container/선택 XML만 비동기 해제한다. 입력·악보 XML 50 MiB, container 64 KiB, 항목 2048개를 제한하며 META-INF 오선택·누락 rootfile·중복 이름을 거부한다. MarkdownContent는 동일 문자열의 재파싱을 생략한다. ScoreImage는 effect에서 Blob URL 생성·src 적용·revoke를 소유한다. 사용하지 않는 zustand/Radix Tabs와 전용 전이 의존성 3개를 제거했다.
- 판단: PDF.js/OSMD/fflate, Markdown·접근성·IndexedDB·인증/DB 라이브러리는 검증된 기능을 유지한다. 오디오 시계·동기화·원격 캐시 권한 계약은 변경하지 않았다. 조사표·근거·빌드 비용은 [구조 가이드](../ARCHITECTURE_AND_CODE_GUIDE.md#라이브러리-비용과-수명-2026-11-12)에 기록했다.
- 검증: CI와 같은 Node 22.23.2, Python 3.13.13에서 `VITEST_MAX_WORKERS=2 corepack pnpm check` 종료 0. JS 504개, 서버 173개, 오디오 품질 9개 통과. PostgreSQL migration 3개·Redis 1개는 테스트 URL 미설정으로 skipped다. frozen/offline install, 모바일 web build와 verify:web-assets 통과. 기존 scores/navigation/session E2E 5개를 worker 1·retry 0으로 실행해 전부 통과했다(19.6초). 새 회귀는 PDF 수명 5개, OSMD 4개, MXL 5개, 이미지 URL 1개다.
- 실제 브라우저: 샘플 PDF 1→2페이지 이동과 폭 390px 변경 후 Blob 읽기/worker 생성 각 1회, 서로 다른 페이지 픽셀과 overflow 없음 확인. 큰 MXL의 worker 해제·OSMD SVG와 폭 342→644 재계산 확인. 실제 저사양 모바일의 전체 지연·메모리 백분율 개선은 측정하지 않았다. ScoresPage는 gzip 24.52→26.36 kB로 증가했으며 초기 entry/App 크기는 유지됐다.
- 환경·실패 구분: 원본 설정/node_modules 일부는 macOS dataless였다. 읽을 수 있는 현재 파일을 복사하고 나머지는 Git index blob hash가 같은 공개 codex archive/API 원본으로 채운 `/tmp/fmr-dependency-audit/FeelMyRythm-codex`에서 검증했다. 최종 소스·테스트·manifest/lock 11개는 작업 트리와 byte 일치다. Node 26의 jsdom localStorage 초기화 실패는 CI Node 버전으로 해결했고, Editor 병렬 5초 초과는 worker 제한으로 해결했다. 테스트 기대값/timeout/프로젝트 설정은 바꾸지 않았다. E2E 첫 시도는 지정 브라우저 실행 파일 부재였으며 표준 install 후 통과했다. 로컬 Memento localhost:57332는 연결 불가여서 이 기록을 사용했다.
- 문서·범위: AGENTS, DESIGN, FEATURES, USER_GUIDE, IMPLEMENTATION_PLAN, IMPLEMENTATION_RETROSPECTIVE, ARCHITECTURE_AND_CODE_GUIDE, CODE_REVIEW_READING_GUIDE와 이 기록을 동기화했다. 기존 codex 미커밋 변경을 보존했다. 커밋·푸시·배포·운영 데이터 변경은 하지 않았다. 요청 범위의 남은 필수 작업 없음.

---

## 소스 읽기 가이드 통합 — 완료 (2026-11-10)

- 목표·완료: 기능별 후속 요청 없이 필요한 주요 코드 리뷰 흐름을 [CODE_REVIEW_READING_GUIDE.md](../CODE_REVIEW_READING_GUIDE.md) 한 파일에 정리했다. 기존 실습 01–07을 유지하고 OMR 08, 수동 매핑·MusicXML·JSON 09, 작업 공간·권한·삭제 10, 일지·할 일·세션 기록 11, 인증·SSO·탈퇴 12, 오프라인·PWA 13, 튜너·보정·설정 14, 모바일 15, 시작·계약·검증 16을 추가했다.
- 구성: 실제 코드 발췌, 원본 링크·식별자, 단계별 흐름, 값·권한·실패·revision 경계, 연결 테스트를 담았다. 목차를 16개 실습으로 통합하고 미작성 후보 안내를 화면별 시작점·오류별 경로·구체적인 리뷰 상황으로 교체했다.
- 핵심 구분: OMR 성공과 MeasureMap 적용, 추정 좌표와 실제 검출 정확도, 요청·적용 시 revision 검사, 수동 일지와 PracticeSession, 일반 로그아웃과 인증 세대 무효화, 로컬 원본과 사용자별 원격 snapshot, 개인 재생과 합주의 보정 적용 범위를 분리했다.
- 검증: 새 코드 발췌 96개(OMR 35 + 나머지 61)의 원본 일치, 문서 링크 670개·heading 195개·fence 334개·JSON 예시 7개, 숫자 예시 4종, 참조 소스 45개 hash 보존을 확인했다. 기존 실습 01–07은 목차 대상 변경·다음 장 연결 문구 외 본문을 보존했다. Markdown Prettier를 적용했다.
- 범위: 이번 작업의 수정은 가이드와 이 진행 기록뿐이다. 기존 앱·다른 문서의 미커밋 변경을 보존했다. 앱 테스트·전체 빌드, 실제 Audiveris·DB·업로드·메일·기기 오디오 측정, 커밋·푸시·배포는 실행하지 않았다. 테스트 링크는 코드에서 읽을 근거이며 실행 결과가 아니다.
- 남은 작업: 이 요청의 필수 작업 없음. 이후 소스 변경 시 관련 실습의 발췌·호출 경로를 함께 갱신한다. 브랜치는 codex다.

---

# 사용성·UI·기능 통합 개선 — 2026-09-28

## 2026-10-11 패드·데스크톱 화면 정리 — 완료

- 완료 구현: 메트로놈은 최대 1280px 작업 공간에 현재 마디/BPM/박/재생 조작을 묶고 1000px부터 280px 상시 설정 패널을 오른쪽에 배치한다. 폰은 기존 큰 숫자·조작, 패드는 세로 카드, 짧은 작업 공간은 BPM/박을 나란히 둔다. 재생은 48px 텍스트 버튼, 강세는 사각 버튼, 예비박은 테두리와 상태 글자로 정리했다. 연습일지는 넓은 작성란과 기록, 설정은 테마/저장 공간과 기본값을 두 열로 분리했다. 좁은 rail의 법적 안내는 이름/tooltip을 가진 아이콘으로 표시한다.
- 발견·조치: 홈 링크가 마지막 slash를 제거해 Vite 재시작/새로고침에서 기본 경로 안내가 떴다. 웹 router basename을 `/feelmyrythm/`로 맞춰 홈 복귀 후 새로고침 회귀를 통과했다. 오디오·데이터·서버 계약은 변경하지 않았다.
- 최종 검증: 관련 단위 53개(MetronomePage/SettingsPage/AppShell/paths), 웹 타입, 변경 소스/회귀 lint와 format, diff 검사 통과. 브라우저 관련 23개 시나리오가 통과했다. 주요 12개 route의 390×844/667×375/600×600/600×960/768×1024/840×390/1024×768/1280×720/1440×900/1920×1080 배치와 터치 대상, 200% 글자·다크/라이트, 설정·±1·재생·시작 마디 잠금, 예비박 카드, 폰 탭/집중/초점 복귀, canonical 홈 새로고침을 포함한다. 기존 Chrome 검증 중 4개 실행이 세션 종료로 중단됐으며 2개는 단독 재실행, 나머지는 임시로 설치한 Playwright Chromium에서 동일 회귀를 통과했다. 원본 코드 결함을 숨기기 위해 검사를 약화하지 않았다. 최종 변경 소스/테스트 8개가 검증본과 동일하다.
- 사용자 화면: IAB에서 1440×900 다크/라이트와 768×1024 패드, 설정·연습일지 결과를 눈으로 확인했다. 390×844의 숫자·원형 박·속도·조작·메뉴 위치와 크기는 변경 전과 완전히 같았다. 최종에는 다크 390×844 메트로놈, 기존 77 BPM·4/4를 복원했다. 모바일 악보→메트로놈 이동에 새 오류가 없고 홈 URL에 마지막 slash가 유지된다. 편집 중 08:37:46의 HMR 교체 오류는 이전 로그이며 최종 메뉴 이동에는 재현되지 않았다.
- 관련 문서: AGENTS/README, DESIGN/FEATURES/USER_GUIDE/UI_DESIGN/RESPONSIVE_UX/ARCHITECTURE_AND_CODE_GUIDE/IMPLEMENTATION_PLAN/IMPLEMENTATION_RETROSPECTIVE/OPERATIONS를 새 표시 경계와 홈 경로로 동기화했다. 전달용 화면은 저장소 밖 기존 artifact 폴더의 `desktop-workspace.jpg`, `tablet-workspace.jpg`다. 검증용 workspace·브라우저·QA 파일을 모두 삭제했고 경로 부재를 확인했다. 커밋·푸시·배포 및 무관한 전체 서버/릴리스 검증은 하지 않았다.

- 목표: 넓은 화면의 버튼·정보 배치를 전용 작업 공간으로 구성한다. 승인된 phone 메트로놈의 숫자·탭·집중·예비박·밝기·배경은 보존한다.
- 공유 기준: 메트로놈은 폭 600px 이상이면서 높이 600px 이상, 또는 폭 840px 이상에서 작업 공간을 사용한다. phone과 짧은 가로 phone은 기존 화면을 유지한다. 넓은 화면에서는 재생/템포와 박자·강세·볼륨·예비박·시작 마디를 함께 보여 주며, 1000px부터 설정을 옆 열에 둔다. fullscreen의 안전 조작은 유지한다.
- 범위: MetronomePage, 화면 크기별 CSS, 연습일지/설정의 넓은 입력 배치와 공통 헤더/버튼. 데이터·오디오·서버 계약은 변경하지 않는다. 기존 관련 문서와 영향 회귀를 함께 수정한다.
- 근거·검증: 실제 1440×900에서 설정이 화면 아래로 밀리고 설정의 저장 버튼/숫자 입력이 670px로 늘어남을 확인했다. 390×844의 주요 요소 위치·크기를 변경 전 기록했다. 새 화면 경계 회귀 6개 중 넓은 화면 4개가 수정 전에 실패했다. 동일 lockfile의 임시 native 검증 workspace는 /private/tmp/fmr-wide-layout-tools이며 검증 후 삭제한다.
- 완료 기준: 실제 600/768/1024/1440/1920 폭, 좁고 짧은 phone, 200% 글자와 테마에서 overflow·겹침·조작을 확인하고 단위/타입/브라우저 영향 검증을 마친다. 기존 서버·사용자 데이터·미커밋 변경을 유지하고 커밋·푸시·배포하지 않는다.

## 2026-10-11 모바일 미리보기 메뉴 클릭 복구 — 완료

- 후속 재확인·조치: 기존 5174 주소를 IAB에서 직접 열어 5173 canonical 앱으로 이동하고 iframe이 0개임을 확인했다. 전체 문서 탐색에서는 browser viewport override가 풀려 852×859로 돌아오는 것을 관찰했으므로 URL 이동 후 390×844를 다시 적용했다. 이후 같은 탭의 앱 메뉴 이동은 390×844를 유지했다. 악보·연습·앙상블·더보기·템포맵·튜너·프로젝트·출력 보정·설정·로그인·개인정보 처리 안내·계정 삭제 안내와 메트로놈 복귀를 실제 메뉴 클릭과 화면 제목/내용으로 확인했다. 오류/경고 브라우저 로그는 없고 웹/API health는 HTTP 200이었다. 템포맵에서 이동이 대기한 것은 새 초안의 저장 확인창이었다. 검증을 위해 연 기본 초안만 버리고 이동했으며 사용자의 저장 데이터를 삭제하거나 설정을 저장하지 않았다.
- 실행 기록 정정: `apps/server/.data/local-preview/processes.json`의 mobile PID를 종료된 91576에서 현재 redirect 프로세스 90828로 고치고 mode/url/redirectTo를 기록했다. 이전 log 경로는 previousLog로 보존하며 현재 프로세스가 그 로그를 쓰는 것으로 표시하지 않는다. 최종 IAB는 iframe 없는 390×844 메트로놈 화면으로 두었다. 전달용 화면 캡처만 저장소 밖의 기존 artifact 경로에 갱신했으며 임시/QA 파일은 새로 만들지 않았다.

- 원인·조치: IAB의 5174 iframe 미리보기에서 실제 보이는 악보 링크가 한 개로 발견돼도 클릭은 `Click target is no longer available`로 실패했다. 앱 라우터 오류 로그는 없었다. 같은 탭을 5173/feelmyrythm/로 직접 열고 IAB viewport override를 390×844로 유지하니 메뉴 클릭이 동작했다. iframe 미리보기 서버만 교체해 5174는 5173/feelmyrythm/로 302 이동하도록 했다. 리디렉션 서버 PID 90828, 웹 Vite/API·사용자 데이터는 유지한다. 앞으로 모바일은 iframe 대신 직접 URL과 browser viewport capability를 사용한다.
- 실제 검증: 현재 사용자 IAB 탭에서 악보·연습일지·앙상블·더보기·설정으로 각각 링크/버튼을 클릭해 해당 화면의 제목·내용이 표시됨을 확인했다. 5174 URL은 302 뒤 canonical 앱에서 HTTP 200을 확인했다. 설정 화면에 둔 탭과 390×844 override를 유지했다. 앱 소스·인증·폼 데이터 변경은 없다. 현재 표시 화면의 전달용 캡처는 저장소 밖 `/Users/cksmacbook/.codex/artifacts/feelmyrythm/mobile-menu-navigation.jpg`에 있다. 임시 서버 스크립트/QA 파일은 만들지 않았다.

## 2026-10-11 예비박 직전 대시 제거 — 완료

- 요청·구현: 예약 시작을 기다릴 때 큰 숫자 영역에 잠깐 나오던 `—`를 제거했다. number canvas는 clearRect 뒤 isWaiting에서 그리기를 생략해 빈 영역을 유지하고 실제 예비박 또는 본박부터 표시한다. 예비박 popup 3→2→1→0, 본박 번호·일정한 밝기·fit·표시 계층과 오디오 시작 시각은 유지한다.
- 검증: 새 대기 계약의 기존/전환 회귀 7개가 수정 전 실제 대시·track 그리기로 실패했다. 수정 후 UI 71개와 실제 원본 Vite의 브라우저 2개(일반 모바일의 전체 예비박 순서, 집중/reduced motion·예비박 off)가 통과했다. 대기 전 기존 숫자 삭제와 inline/overlay/hidden 예비박·본박 전환을 unit에서 검증했다. UI 타입·변경 코드 lint/format·diff 검사 통과. 변경 source/test 2개가 임시 native 검증본과 일치함을 확인했다.
- 문서·정리: AGENTS/README 및 DESIGN/FEATURES/USER_GUIDE/UI_DESIGN/RESPONSIVE_UX/ARCHITECTURE_AND_CODE_GUIDE/IMPLEMENTATION_PLAN/IMPLEMENTATION_RETROSPECTIVE를 빈 대기 영역으로 동기화했다. 이전 USER_GUIDE의 남은 밝기 변화 설명도 현재 일정한 밝기로 맞췄다. 동일 lockfile의 임시 검증 workspace·QA 결과물은 삭제하고 5174 미리보기·기존 변경·데이터를 보존한다. 커밋·푸시·배포하지 않았다.

## 2026-10-11 큰 박 숫자의 일정한 밝기와 전면 표시 — 완료

- 요청: 가장 큰 박 숫자가 옅어지지 않고 표시 영역의 앞 레이어에 위치해야 한다.
- 구현: 공용 number canvas의 진행도 기반 0.6–1 opacity 효과를 제거하고 모든 숫자/상태 글자는 globalAlpha 1로 그린다. 기존 테마 text 색·fit·번호·오디오 시계는 유지한다. 모바일 일반/집중 숫자 영역은 z-index 1로 진행 배경(-1)과 다른 표시 콘텐츠 위에 두고 dialog와 내비게이션의 기존 계층을 유지한다.
- 검증: 바뀐 계약의 기존 UI 회귀 3개가 수정 전 0.76875/0.60005로 실패하는 것을 확인했다. 수정 후 UI 68개와 실제 원본 Vite 브라우저 2개(일반/집중 45프레임씩 알파 255 확인, 진행 배경·중첩 순서·조작/dialog 회귀)가 통과했다. UI 타입·변경 TS lint·CSS/TS format·diff 검사 통과. root 의존성의 Vitest가 무출력 대기해 중단했고 동일 lockfile/source의 임시 native workspace로 검증했다. 변경 코드/테스트 4개와 검증본의 내용 일치를 확인했다.
- 문서·정리: AGENTS/README와 DESIGN/FEATURES/USER_GUIDE/UI_DESIGN/RESPONSIVE_UX/ARCHITECTURE_AND_CODE_GUIDE/IMPLEMENTATION_PLAN/IMPLEMENTATION_RETROSPECTIVE의 숫자 pulse 설명을 일정한 밝기와 계층 규칙으로 동기화했다. 임시 검증 workspace와 QA 결과물은 삭제했고 현재 5174 미리보기·사용자 변경·데이터를 보존했다. 커밋·푸시·배포하지 않았다.

## 2026-10-11 모바일 탭 입력판의 배치 유지 — 완료

- 후속 배치 조정: 탭/측정 횟수는 좌우 여백을 동일하게 두어 입력판 전체의 정중앙에 맞추고 1rem·500 weight로 표시한다. ×는 오른쪽 가장자리에서 4px 떨어진 세로 중앙에 48×48px 영역으로 둔다. 기존 입력판 높이와 위쪽 UI 배치를 보존한다. 수정 전 브라우저 회귀에서 라벨 중심이 24px 어긋나는 것을 재현했고, 수정 후 실제 Vite의 탭 입력·5개 배치/확대 조합·6개 coarse-pointer 200% 폭 회귀 3개가 통과했다. 정렬 회귀는 첫 입력 뒤 `다시 탭`과 ×의 비겹침도 확인한다. 변경 E2E lint·CSS/E2E format·diff 검사 통과, 390px 화면 캡처 확인. 관련 문서 10개를 중앙 배치로 동기화했고 임시 검증 workspace와 QA 캡처는 삭제했다. 현재 5174 탭 입력판의 열린 상태를 유지했다.

- 요청: 탭 입력판을 열 때 위쪽 UI가 작아지거나 움직이지 않게 한다.
- 구현: 모바일 조작 줄을 유지한 wrapper 안에 같은 크기의 입력판을 absolute로 겹친다. 원래 버튼과 빠른 시작 마디는 visibility/inert로 공간을 보존하고, 열기·닫기 초점 이동은 preventScroll을 사용한다. 입력판은 기존 줄 높이(최소 48px)이며 짧은 `탭`/측정 횟수를 표시하고 두 번 이상 입력 안내는 접근성 설명으로 제공한다. 탭 계산·Escape·닫기 후 초점 복원을 보존한다.
- 검증: 현재 메트로놈 단위 19개, 실제 원본 Vite를 사용하는 브라우저 3개 통과. 열기/닫기 배치 회귀는 390×844, 256×844/200%, 568×320, 768×1024, 390×1024/200%를 비교했고 별도 coarse-pointer 200% 회귀는 6개 폭의 조작·탭 입력판을 확인했다. 웹 타입, 변경 코드 lint/format, diff 검사 통과. 수정 전 동일 회귀는 입력판을 열면 원래 조작 DOM이 없어져 실패했다. 짧은 화면에서 테스트의 클릭 전 자동 스크롤을 구분하도록 조작을 먼저 화면에 노출한 뒤 비교했다.
- 문서·정리: AGENTS/README와 DESIGN/FEATURES/USER_GUIDE/UI_DESIGN/RESPONSIVE_UX/ARCHITECTURE_AND_CODE_GUIDE/IMPLEMENTATION_PLAN/IMPLEMENTATION_RETROSPECTIVE를 같은 높이·배치 유지 계약으로 동기화했다. 동일 lockfile의 임시 native workspace와 QA 결과물은 삭제했다. 변경 source 4개가 검증 workspace와 일치함을 확인했으며 모바일 미리보기 5174는 HTTP 200이고 현재 탭을 유지했다. 기존 변경·사용자 데이터를 보존하고 커밋·푸시·배포하지 않았다.

## 2026-10-11 예비박 팝업 표시 — 완료

- 후속 정정: 사용자 요청에 따라 앱의 팝업·접근성 안내·상태 문구를 4/4 한 마디에서 `3 → 2 → 1 → 0`으로 맞췄다. 마지막 0도 한 박 동안 표시한 뒤 본박으로 진입하며 시작·쉼표 뒤 재진입 모두 적용한다. 표시에서만 1을 빼므로 기존 오디오 frame·시간 계약은 유지한다. 이번 변경의 UI 70개와 실제 브라우저 3개(모바일 전체 순서·집중/reduced motion/off·재진입 마지막 0), UI/웹 타입·변경 코드 lint/format을 통과했다. 기존 관련 문서 10개도 같은 표시로 동기화했다. 검증 후 테스트 파일의 줄바꿈만 Prettier로 정리하고 변경 파일 포맷 검사를 통과했다. 동일 잠금 의존성의 임시 검증 workspace/포맷 도구/QA 결과물은 삭제하고 현재 미리보기는 유지한다.

- 요청·완료 조건: 예비박을 본박과 구분되는 자동 카운트다운 팝업으로 표시한다. 시작·쉼표 뒤 재진입, 모바일/집중·데스크톱/보면대·세션·악보에 같은 규칙을 적용하고 정지 조작과 접근성을 보존한다.
- 경계: 공용 `BeatVisualizer`의 같은 audio-frame/rAF에서 표시만 바꾼다. 박 영역 안에 뜨는 비모달 카드로 focus나 오디오 시간을 바꾸지 않으며 본박 시작·정지 즉시 사라진다. 기존 코어·서버 계약과 사용자 변경을 보존한다. 부모는 UI/연결/검증, 기존 server-contract agent는 관련 문서만 수정한다.
- 구현: `countInDisplay=overlay|hidden|inline`을 공용 visualizer에 추가했다. 앱에서는 예비박 라벨·민트색 숫자·진입 마디를 박 영역 안의 카드로 표시하며 기본 inline은 호환 보존한다. 모바일은 큰 숫자 영역만 overlay이고 원형 영역·진행 배경은 hidden이다. 세션·단독 악보는 각자의 visualizer에 적용하고 embedded 악보는 세션 표시를 공유한다. 기존 live region이 숫자를 알리며 popup은 focus/pointer를 가져가지 않는다.
- 검증: UI 70개와 관련 웹 40개(메트로놈·세션·악보 재생), 브라우저 8개가 통과했다. 브라우저는 일반 모바일/짧은 가로/256px·390px 200% 글자/desktop의 카드와 실제 정지·초점, 집중 화면·reduced motion·예비박 off, 실제 페르마타·쉼표 뒤 예비박 on/off를 확인했다. UI·웹 및 변경 E2E 타입 검사, 변경 코드 ESLint/Prettier, diff 검사를 통과했다. 마지막 CSS 수정은 영향받는 작은 화면/확대에서 다시 검증했다.
- 보완·환경: 2마디 예비박의 테스트 기대값을 총 8부터 감소가 아니라 기존 계약인 4·3·2·1 반복으로 정정했다. 256px/200%에서 문구가 카드 높이를 넘던 실제 문제는 가로 배치 전환을 rem 기준으로 바꿔 고쳤다. 원본 의존성의 worker 시작 timeout으로 동일 lockfile/source의 native 임시 workspace를 사용했고 관련 source/config 158개 일치를 확인했다. 초기 canonical branch 환경 누락으로 시작하지 못한 검증은 환경 실패로 구분했다. 최종 배치 검증은 실제 원본 Vite 5173에서도 통과했다.
- 문서·정리: AGENTS/README, DESIGN/FEATURES/USER_GUIDE/UI_DESIGN/RESPONSIVE_UX/ARCHITECTURE_AND_CODE_GUIDE/IMPLEMENTATION_PLAN/IMPLEMENTATION_RETROSPECTIVE와 이 기록을 동기화했다. 임시 검증 workspace·스크린샷·QA 결과물을 제거하고 영구 회귀만 보존한다. 5173 웹·5174 모바일 미리보기·8000 API와 사용자 데이터를 유지한다. codex 작업 트리에만 반영했으며 커밋·푸시·배포하지 않았다.

## 2026-10-08 마디별 연주 표현 — 구간 끝 제한 정정 완료

- 사용자 정정: 구간 분할을 요구하지 않고 임의의 마디에 rit./a tempo/페르마타/쉼표를 직접 배치해야 한다. 기존 구간 수·범위·저장 데이터와 지정 시간 뒤 자동 재개·재진입 예비박 on/off를 보존한다.
- 계약: optional `measureExpressions`에 고유한 절대 `measure`와 템포 변화/페르마타/쉼표를 저장한다. rit./accel.은 inclusive `endMeasure`(생략 시 같은 마디)까지 진행하고 목표 템포를 유지한다. span 중간의 구간 경계는 넘을 수 있고, span 이후 새로운 구간 시작에서는 그 구간 기본 템포를 따른다. a tempo는 해당 마디 시작에서 즉시 전환한다. 페르마타는 선택한 1-based `beat`(생략 시 마지막 박)에 추가 길이를 넣는다. 마디행이 있으면 늘임·쉼표는 해당 행의 설정(끄기 포함)을 우선하며 행이 없을 때 기존 구간 끝 기본값을 사용한다.
- 구현: 곡 전체 설정 다음의 `마디별 연주 표현`에서 마디 번호로 추가·수정·삭제한다. 구간 수를 바꾸지 않으며 이동·나누기·합치기에도 절대 마디 번호를 보존한다. 페르마타 뒤 남은 박을 이어가고, 마디 템포 지시를 중간 시작·예비박에도 반영한다. 중복 마디·겹치는 변화 범위·없는 박·범위 밖 마디는 저장을 막고 해당 입력에서 고칠 수 있게 한다. 메트로놈의 박자 변경이 기존 마디 표현을 무효화하는 경우에도 잘못된 맵을 적용하지 않는다.
- 검증: core 62개, 관련 web 113개, 서버 57개로 이번 관련 테스트 232개 통과. 기존 Editor 7개, 분할 없이 직접 마디를 편집하는 모바일 흐름 1개, 실제 재생의 예비박 on/off 2개로 브라우저 10개 통과. core/web/생성 protocol/변경 E2E 타입 검사, 변경 코드 lint, 서버 Ruff·schema mypy, web E2E 빌드 통과. 기존 전체 E2E 타입 검사에서 확인된 무관한 responsive.spec.ts 오류 2개는 수정 범위에 넣지 않았다.
- 확인한 실제 흐름: 기존 구간 1개를 유지한 채 3–4마디 rit., 5마디 a tempo, 7마디 2박 페르마타, 8마디 쉼표를 편집·저장·재열기·가져오기·재생한다. 별도 실제 오디오 시계 재생에서는 마디 중간 페르마타 뒤 남은 박, 쉼표, 선택적 재진입 예비박, 다음 마디의 아 템포를 확인했다.
- 보완: 오류 문구가 입력의 접근성 이름을 바꾸지 않게 했고, 마디 지시에 덮여 실제로 실행되지 않는 구간 rit./accel.은 아 템포 기본값 후보에서 제외했다. 1/3초 기반 progress의 부동소수점 비교는 1e-10 오차로 검증한다. 빌드와 단위 테스트의 dist 읽기가 겹친 환경 실패는 순서대로 재실행해 해소했다.
- 환경·정리: 동일 lockfile과 실제 source를 `/private/tmp/fmr-measure-expression-tools`에 복사해 검증했으며, 검증 시점 원본·실행 파일 183개의 SHA-256 일치를 확인했다. 이후 기능에 영향 없는 정책 주석과 이 기록만 정리했다. 검증된 core/audio 빌드를 원본에 반영하고 기존 local API를 같은 데이터·실행 환경으로 재시작했다. 실제 OpenAPI의 measureExpressions/endMeasure/beat, 웹 API health 및 Vite의 새 마디 편집 controls를 확인했다. 임시 검증 workspace와 QA 결과물은 삭제했다.
- 문서·상태: AGENTS.md, README.md, DESIGN/FEATURES/USER_GUIDE/UI_DESIGN/RESPONSIVE_UX/ARCHITECTURE_AND_CODE_GUIDE/IMPLEMENTATION_PLAN/IMPLEMENTATION_RETROSPECTIVE와 이 기록을 마디 중심으로 수정했다. 기존 변경과 사용자 데이터를 보존했고, 변경은 codex 작업 트리에 남겼다. 커밋·푸시·운영 배포는 하지 않았다.

## 2026-10-08 구간의 연주 표현과 숨 고르기 — 완료

- 요청·완료 기준: 구간의 rit./accel.에 즉시 복귀하는 a tempo를 추가하고, 구간 마지막 박의 페르마타와 구간 뒤 쉼표를 편집·저장·실제 로컬/동기 재생에 반영한다. 사용자는 지정 시간 뒤 자동 재개를 선택했으며 쉼표마다 재진입 예비박을 켜고 끌 수 있어야 한다.
- 계약: `tempoChange.type=aTempo`는 `targetBpm`으로 즉시 전환한다. `fermata.extraBeats`는 마지막 박 길이의 추가 배수(0 초과, 16 이하), `breath.durationSec`는 무음 초(0 초과, 300 이하), `breath.countIn`은 필수 boolean이다. 재진입 예비박은 다음 연주 마디의 템포·박자와 곡 전체 예비박 마디 수를 따른다. 전체 타임라인에 길이를 미리 반영해 서버 anchor와 반복/점프 동기화를 보존한다.
- 범위·분담: 부모는 core/audio/재생 표시/공통 문서, server agent는 Pydantic·저장 회귀·생성 계약, editor agent는 Editor·편집 회귀를 담당한다. 기존 `CURRENT.md` 변경을 보존하며 commit/push/배포하지 않는다. 일회성 QA 산출물은 종료 시 정리하고 실행 중인 모바일 미리보기와 사용자 로컬 데이터는 보존한다.
- 구현: Editor에서 표현을 선택·저장하고 블록/표에 요약한다. 나누기는 원래 끝의 표현을 뒤 구간에 보존하고, 앞 구간 끝에 표현이 있으면 합치기를 제한한다. 공통 타임라인은 늘임·무음·재진입 예비박을 미리 계산하고, scheduler는 마지막 클릭이 아닌 전체 연주 시간 뒤 종료한다. 로컬·세션·악보 재생에 페르마타/숨 고르기/예비박 상태와 실제 박의 BPM을 표시하며 큰 숫자에는 쉼을 고정 표시한다.
- 검증: core 45개, audio 26개, UI 65개, 관련 web 106개, 서버 31개로 관련 테스트 273개 통과. Editor 브라우저 8개와 실제 재생의 예비박 on/off 2개(총 10개) 통과. core/audio/UI/web 및 변경 E2E 파일의 타입 검사, 변경 TS/TSX 19파일 ESLint, 서버 Ruff/schema mypy, 생성 protocol 타입 검사와 web E2E 빌드 통과. 코드와 테스트의 오류 수정 후 영향받는 범위만 다시 실행했다.
- 검증 환경: 원본 의존성의 macOS dataless 읽기 지연으로 일부 원본 실행은 worker timeout 또는 무출력 대기로 중단했다. 동일 manifest·lockfile·source를 native 임시 workspace에 설치해 공식 테스트를 실행했고, 원본과 실행 파일 181개의 내용 일치를 확인했다. 코어의 새 실수 시각 기대값은 부동소수점 반올림 차이 때문에 1e-10 정밀도 비교로 수정했으며, Editor 테스트의 잘못된 Testing Library `exact` 옵션도 제거했다. 임시 Python/JS 환경·pnpm 저장소와 QA 결과물은 최종 검증 후 삭제했다.
- 기존 검증 한계: 추가 실행한 전체 E2E TypeScript 검사에는 이번에 변경하지 않은 `e2e/responsive.spec.ts:424–425`의 canvas `height`/`width` 타입 오류 2개가 있다. 해당 테스트나 검사 설정은 바꾸지 않았으며, 변경한 두 E2E 파일은 원래 설정을 상속한 범위별 검사와 실제 브라우저 실행을 통과했다. 물리 기기 출력 오차 측정·운영 배포는 이번 작업 범위가 아니다.
- 미리보기: 검증된 core/audio 빌드를 원본에 반영했고 현재 Vite에서 새 Editor controls를 확인했다. API는 동일 잠금 버전의 `/Users/cksmacbook/Library/Caches/FeelMyRythm/codex-server-venv`를 사용해 source는 원본에서 실행한다. `PYTHONDONTWRITEBYTECODE=1`과 별도 `PYTHONPYCACHEPREFIX`로 기존 dataless bytecode를 읽지 않게 했다. 재시작 후 실제 API health·새 OpenAPI 표현 계약·웹 API proxy 응답을 확인했다. 실행 환경 경로와 PID는 `.data/local-preview/processes.json`에 보존하며 5173/5174/8000 서버는 유지한다.
- 동기화 문서: `AGENTS.md`, `README.md`, `docs/DESIGN.md`, `docs/FEATURES.md`, `docs/USER_GUIDE.md`, `docs/UI_DESIGN.md`, `docs/RESPONSIVE_UX.md`, `docs/ARCHITECTURE_AND_CODE_GUIDE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/IMPLEMENTATION_RETROSPECTIVE.md`, 이 기록. 변경은 `codex` 작업 트리에 있으며 커밋·푸시하지 않았다.

> 2026-10-08 로컬 모바일 미리보기 복구: 5174 미리보기·5173 웹·8000 API가 모두 종료되어 연결이 거부되는 상태를 확인했다. 현재 세 서버는 `start_new_session=True`와 표준입력 분리로 실행하며, PID와 실행 로그는 Git에서 제외된 `apps/server/.data/local-preview/`에서 관리한다. 원본 앱은 5173, 390×844 고정 모바일 미리보기는 `http://127.0.0.1:5174/`이다. API는 `codex/local`, development, 기존 `.data/dev.db`와 `.data/uploads`를 사용한다. 재시작 중 dataless Python bytecode와 core/audio의 오래된 중첩 의존성에서 읽기가 멈춰 해당 생성 파일만 제거하고 lockfile 버전 그대로 의존성을 복구했다. API에는 `PYTHONDONTWRITEBYTECODE=1`을 적용했다. 세 주소와 웹 API proxy의 HTTP 200, API의 `{"ok":true}`, 브라우저의 모바일 메트로놈 표시와 오류 로그 없음까지 확인했다. OS 재부팅 후 자동 시작은 구성하지 않았다. 아래 과거 미리보기와 임시 복사본 기록은 현재 실행 상태로 해석하지 않는다.

> 2026-10-01 정리: 사용자 요청으로 `output/playwright`의 QA 보고서·화면 캡처, 테스트 결과·리포트·커버리지와 Python 검사 캐시를 삭제했다. 사용 중인 프로세스가 없는 임시 QA 실행 복사본 `fmr-usability-g4k1a54l`과 별도 배포용 clone `fmr-main-release-11aek1sl`도 삭제하고 경로 부재를 확인했다. 아래 산출물 보존·미리보기 유지 기록은 당시 상태이며, 현재 해당 파일이나 임시 서버가 남아 있다는 뜻이 아니다. 원본 앱·테스트·로컬 데이터와 기존 작업 변경은 보존했다.

- 목표: 실제 브라우저 조작으로 기존 감사 결함과 추가 핵심 흐름의 사용성 문제를 확인·수정한다. 모바일/패드/웹의 박 가독성, 구간별 박자·BPM 편집 후 악보/메트로놈 재생, 여러 참가자의 동기 연습을 연결한다.
- 완료 기준: 일반 곡의 실제 API 저장/조회/재생, 새 곡 첫 작성, 로컬 편집 왕복, PDF/이미지 맵 연결, 세션 안의 악보, 작은 화면 합주, 준비 상태/초대 주소/예비박 가독성을 수정하고 해당 회귀 및 대표 실제 브라우저 흐름을 통과한다. 그 밖의 프로젝트·악보·설정 핵심 조작도 실제 탐색하여 발견한 중대한 이상을 조치한다.
- 제약: `codex` 브랜치에서 구현. `main`/`dev` 갱신·커밋·푸시·배포 없음. 실제 운영 DB/계정 미사용. 전체 릴리스 빌드는 로컬에서 반복하지 않는다. 물리 기기 오디오 정확도는 브라우저 에뮬레이션으로 통과 주장하지 않는다.
- 시작 상태: HEAD `c8425f514f568a7a47fd7cbabef30671c86bd663`, 추적 파일 변경 없음, `output/`에 이전 감사 산출물만 있음.
- 기존 근거: `output/playwright/usability-2026-09-28/REPORT.md`. 이는 수정 전 감사 결과이며 수정 완료 근거로 재사용하지 않는다.
- 실행 환경: 원본 의존성 일부가 macOS dataless라 임시 소스 복사본 `/var/folders/ns/8yh7k1zn3q9flcsx0msyzfhm0000gn/T/fmr-usability-g4k1a54l`의 frozen-lockfile 설치 의존성을 재사용한다. 수정은 원본에서 수행하고 변경 파일을 명시적으로 복사해 실행한다. 원본/실행 소스 일치를 최종 확인한다.
- 분담: backend agent — 템포맵 선택 필드 직렬화/회귀; tempo agent — Editor/Metronome 작성·저장·이동 계약; score agent — ScoresPage 내 맵 연결 및 세션 내장 경계; 부모 — Session/BeatVisualizer/CSS/문서/컴퓨터 유즈 검증·통합.
- 현재 상태: 구현·관련 회귀·대표 컴퓨터 유즈 검증 완료. 변경은 `codex` 작업 트리에 있으며 커밋·푸시·배포하지 않았다.
- 구현: optional 템포맵 응답의 null 복원 제거; 새 원격 곡의 권한 확인 후 첫 작성; 명시적 로컬 맵 저장·편집·재생 왕복; PDF/이미지와 로컬 맵 연결; 세션의 고정 revision을 사용하는 내장 악보; 오디오 준비/늦은 합류/준비 상태; 작은 합주 화면 재배치; 예약 대기와 예비박 표시; 초대 원점; 악보 도구 겹침과 보이지 않는 펜 선 수정.
- 실제 브라우저: 새 원격 16마디 곡을 1–4마디 96 BPM·4/4, 5–16마디 132 BPM·3/4로 작성·저장·재생했다. 로컬 이미지 악보에서 5마디 이후 150 BPM·3/4 편집·저장·복귀·재생을 확인했다. 두 계정이 실제 REST/WS 서버의 같은 방에서 준비/시작/합류하고 6마디 132 BPM·3/4를 함께 표시했다. 재생 중 PDF 악보 열기·스크롤에서도 방과 재생을 유지했다. 연습 메모 저장 후 5마디 악보 링크도 확인했다.
- 검증: 서버 관련 20개, 오디오/메트로놈 표시 34개, 악보 7개, 세션 17개, BeatVisualizer 16개 통과. Editor 작성·왕복·JSON 가져오기와 초대 URL 회귀 통과. 기존 브라우저 대표 9개, 세션 1개, 악보 3개 시나리오 통과. 변경 파일 lint/format, 웹 전체 TypeScript, 서버 schemas mypy, OpenAPI 동일성, diff 검사 통과. 전체 릴리스 빌드는 실행하지 않았다.
- 화면: 세션 256×568, 320×568, 390×844, 667×375, 768×1024, 1440×900의 박·조작 위치와 overflow 확인. 실제 iPhone/iPad/Android 및 서로 다른 기기의 물리 출력 동기는 미검증이며 브라우저 성공으로 대체하지 않는다.
- 실패와 조치: 옛 검증 원점의 PWA 캐시 때문에 소스와 UI가 달라 새 로컬 원점으로 확인했다. 악보 펜 테스트에서 재생 바가 필기 표면을 덮는 문제를 발견해 정지/편집 때 일반 흐름으로 바꿨다. 이어 SVG non-scaling 펜이 0.004 CSS px인 원인을 3px로 수정했다. 기존 테스트의 오래된 좌표 재사용도 실제 표면 hit 검증으로 보완했다.
- 문서: 기존 관련 11개 문서를 동기화했다. 상세 변경·실행 결과·화면·한계는 `output/playwright/usability-fixes-2026-09-28/REPORT.md`를 본다. 수정 전 감사와 현재 완료 근거를 구분한다.
- 종료 상태: 원본/임시 실행 소스·테스트 20개 내용 동일. 직접 만든 브라우저 탭을 닫고 viewport를 복원했으며 검증용 4173·4174·8001 서버를 종료했다. 임시 환경의 synthetic DB와 원본의 증거 파일은 보존했다.
- 2026-09-29 사용자 미리보기: 같은 임시 실행 환경의 소스·테스트 20개가 원본과 동일함을 확인한 뒤 API `127.0.0.1:8001`과 웹 `http://127.0.0.1:4174/feelmyrythm/`을 재실행했다. 웹 proxy의 `/api/health` 응답과 실제 메트로놈 화면을 확인했고, 사용자가 조작하도록 서버와 브라우저 탭을 열어 두었다. 기존 로컬 샘플 데이터와 계정을 사용한다.
- 모바일 미리보기 정정: 브라우저 viewport를 390×844로 설정했지만 다음 확인에서 데스크톱 배치로 돌아온 것을 관찰했다. 임시 실행 복사본의 `apps/web/public/mobile-preview.html`에 390×844 고정 iframe 미리보기를 추가하고 `http://127.0.0.1:4174/feelmyrythm/mobile-preview.html`을 열었다. iframe의 실제 clientWidth/clientHeight와 모바일 하단 메뉴를 확인했다. 이 파일은 로컬 미리보기 보조 페이지이며 원본 앱 구현에는 추가하지 않았다.
- 다음 작업이 생기면: 이 작업의 후속 배포 또는 실기기 시험은 별도 범위다. 실기기 시험은 휴대폰·패드·PC의 내장/유선 출력을 녹음하여 실제 시작·구간 전환·재합류의 출력 오차를 측정한다.

## 2026-09-29 모바일 화면 후속 수정 — 완료

- 사용자 요청: 모바일 상단 바를 없애고 기능을 더보기로 옮긴다. 기존 원형 박 위에 숫자만 크게 점멸하는 화면을 추가한다. 시작·정지와 나머지 조작을 두 줄로 나눈다.
- 범위: AppShell의 모바일 메뉴, MetronomePage, 공용 BeatVisualizer의 숫자 variant, 관련 CSS·회귀·기존 설명 문서. 기존 작업 트리 변경을 보존하며 커밋·푸시·배포하지 않는다.
- 공용 판단 지점: 모바일 내비게이션 breakpoint인 839px까지 상단 바를 숨기고 safe area를 본문에 보존한다. 숫자는 기존 오디오 frame의 main beat만 따라 점멸하며 subdivision은 추가 점멸하지 않는다. 정지는 숫자를 유지하고 예약 대기는 `—`를 표시한다. reduced motion은 점멸만 끄고 박 번호는 계속 갱신한다. fullscreen은 기존 표시를 유지한다.
- 구현: 더보기에서 Bonifacio·테마·설정·계정/로그인과 해당 운영 프로필의 운영 안내에 접근한다. 숫자 패널은 기존 원형 박 위에 둔다. 599px 이하 조작은 시작/정지 첫 줄과 BPM·예비박 둘째 줄로 분리하고, 600–839px의 좁은 조작 열은 기존 세로 흐름을 유지한다.
- 발견·수정: 상태 복구 안내가 있는 359/390×420에서 조작부가 하단 메뉴를 넘었다. 이 조건은 숫자를 첫 행, 원형 박과 BPM을 나란히 둘째 행, 마디를 셋째 행에 두어 조작부 bottom 345.39px를 확보했다(하단 메뉴 top 360/356px). 48px 핵심 터치 타깃은 유지했다.
- 이번 검증: AppShell 12개, BeatVisualizer 21개, MetronomePage 13개 단위 테스트 통과. 영향받는 브라우저 시나리오 10개 통과(작은 화면·200% 글자·테마·설정 focus·보면대 포함; coarse-pointer 회귀의 16개 viewport 통과). 웹/UI TypeScript와 변경 소스·테스트의 ESLint 및 포맷 검사 통과. 전체 빌드·서버 회귀는 UI만 변경한 이번 작업에서 반복하지 않았다.
- 검증 중 정정: 새 테스트의 exactOptionalPropertyTypes 위반은 undefined를 넣지 않도록 수정했다. UI 재검증을 root에서 실행해 setup 경로 오류가 났던 시도는 통과 근거에서 제외하고 packages/ui에서 21개가 통과한 실행을 사용한다.
- 결과: `output/playwright/mobile-ui-2026-09-29/`에 기본·짧은 복구 화면 3개와 검증 기록을 보존했다. 390×844 고정 미리보기를 새로고침해 열어 두었고 기존 API 8001·웹 4174 서버를 유지한다. 이번 변경은 원본 작업 트리와 임시 실행 복사본에 반영하며 커밋·푸시·배포하지 않았다.

## 2026-09-29 모바일 메트로놈 단순화 — 완료

- 사용자 요청: BPM의 입력 힌트 삭제, 마디를 최상단으로 이동, 예비박을 세부 설정으로 이동, BPM·박자 표기를 간결하게 정리, 원형 박 아래 진행 바를 큰 숫자 박스 안으로 이동. 탭 템포와 ±5의 기능 질문에는 사용법을 설명하고 동작은 유지한다.
- 범위와 판단: 모바일 일반 화면의 마디는 header에 단일 DOM으로 배치한다. 공용 BeatVisualizer의 showProgress 선택으로 모바일 숫자 박스에만 track을 그리며 desktop/fullscreen/다른 화면의 기존 bar를 유지한다. 예비박은 settingsControls에서 같은 저장 값과 재생 옵션을 사용한다. 오디오 예약 로직·기존 사용자 변경은 보존한다.
- 완료 조건: 관련 UI/Page 단위 회귀, 영향받는 모바일·짧은 화면·설정·확대·fullscreen 브라우저 회귀와 타입·lint, 현재 미리보기 확인. 지난 수정의 통과를 이번 변경의 검증으로 사용하지 않는다.
- 구현: 모바일 header 왼쪽에 현재 마디를 표시하고 마지막 구간일 때 불필요한 다음 문구를 생략한다. 숫자 panel 하단으로 진행 bar를 옮기고 원형 박의 중복 bar를 제거했다. 입력 힌트는 삭제하되 큰 BPM 클릭은 유지한다. 일반 표기는 `BPM · 4/4`, 점4분음표 기준은 `BPM (♩.)`로 구분한다. 메인 보조 조작은 ±5/탭 세 개이고 예비박 켬/끔은 설정 panel·dialog에서 제공한다.
- 이번 검증: BeatVisualizer 26개 및 MetronomePage 14개 단위 회귀, 기존 영향 E2E 8개 모두 통과. 예비박 off 저장·reload 복원·키보드 on·실제 예비박에서 마디 재생으로 전환, coarse-pointer 16개 viewport의 48px 조작, 200% 글자 확대 6개 viewport, 짧은 복구 화면 및 fullscreen을 확인했다. 웹/UI TypeScript, 변경 소스·테스트 lint/format, diff 검사 통과. 무관한 AppShell·서버·전체 빌드는 반복하지 않았다.
- 산출물: `output/playwright/mobile-ui-2026-09-29/mobile-390-simplified-metronome.png`. 원본/실행 복사본의 이번 소스·테스트 7개가 동일하다. IAB에서 새 메인 화면과 설정 안 예비박을 직접 확인하고 390×844 미리보기·4174/8001 서버를 유지한다. 기존 단계의 스크린샷과 결과는 당시 근거로 보존한다.
- 문서: AGENTS·README와 RESPONSIVE_UX·UI_DESIGN·USER_GUIDE·FEATURES·ARCHITECTURE_AND_CODE_GUIDE·DESIGN·IMPLEMENTATION_PLAN·IMPLEMENTATION_RETROSPECTIVE 10개를 새 배치와 조작에 맞춰 동기화했다. Medium 가로 rail·오디오 예약·운영 경계는 보존한다.

## 2026-09-29 모바일 조작 한 줄·탭 입력판 — 완료

- 사용자 요청: 조작을 `−5 → 재생/정지 → +5` 한 줄과 오른쪽 끝 `탭`으로 배치한다. 탭을 누르면 조작 영역 전체를 큰 입력판으로 바꾸고 우상단 ×로 원래 조작에 돌아온다.
- 범위·예외: 폭 839px 이하의 일반 메트로놈 화면에서만 적용한다. desktop 직접 탭과 fullscreen 조작, BPM 범위·계산 방식·오디오 예약, 기존 사용자 변경을 보존한다. 부모는 Page·CSS·unit·기록, 기존 agent는 관련 문서와 E2E를 각각 담당한다.
- 완료 조건: 실제 모바일 행 배치와 입력판 진입·BPM 계산·닫기·포커스 복귀를 확인하고 관련 단위·브라우저 회귀 및 웹 타입·변경 파일 lint를 통과한다. 열기·닫기는 측정에 포함하지 않고 새 진입은 새 측정이다. 현재 390×844 미리보기와 서버를 유지하며 커밋·푸시·배포하지 않는다.
- 구현: 한 줄의 왼쪽 `−5·재생/정지·+5`와 오른쪽 `탭`을 시각·DOM 순서로 일치시켰다. 탭 입력판은 조작 영역의 전체 폭과 최소 높이 128px을 사용하며, 우상단 ×는 16px 아이콘·48px 터치 영역이다. X/Escape 닫기와 focus 복귀, 840px 전환 및 fullscreen 진입 시 측정 정리를 구현했다. 기존 간격 중앙값 계산·2초 유휴 초기화를 유지한다.
- 이번 검증: 구현 전 새 모바일 순서 회귀만 실패하고 기존 14개는 통과했다. 구현 후 MetronomePage 15개, 선택 E2E 5개, 웹 TypeScript와 변경 소스·테스트 ESLint·Prettier·diff 검사를 통과했다. E2E에서 500/800/600ms 간격 중앙값 100 BPM, 열기·닫기 비집계, 재진입 초기화, X/Escape·포커스 복귀, 16개 coarse 화면의 48px 타깃, 200% 글자 6개 화면의 입력판/닫기 접근, fullscreen을 확인했다. 전체 빌드·무관한 서버/UI package 회귀는 반복하지 않았다.
- 브라우저: HMR 중 중복 createRoot 오류가 있던 미리보기는 새로고침한 뒤 새 입력판 열기·X 복귀·탭 버튼 focus를 확인했다. 사용자 BPM 88을 유지한 기본 행 상태로 열어 두었다. 원본/실행 소스·테스트 5개 내용 동일. API 8001·웹 4174 유지.
- 문서·증거: 기존 관련 10개 문서를 계약에 맞춰 동기화했다. `output/playwright/mobile-ui-2026-09-29/REPORT.md`의 마지막 절과 새 `mobile-390-controls-row.png`, `mobile-390-tap-pad.png`에 이번 결과를 기록했다. 이전 단계 기록과 화면은 당시 증거로 보존한다.

## 2026-09-29 모바일 조작 중앙 정렬·테두리 정리 — 완료

- 사용자 요청: `−5·재생·+5`를 중앙에 정렬하고 네모 테두리를 없앤다. 오른쪽 탭은 작고 은은하게 표시한다.
- 판단·범위: 모바일 controls CSS와 이를 설명하는 기존 문서, 기존 화면 회귀만 수정한다. 박 숫자 패널·열린 탭 입력판의 상자는 요청 대상이 아니므로 유지한다. BPM/재생/탭 계산은 그대로 두고, 작은 표시와 별도로 48px 터치 영역·키보드 focus를 보존한다.
- 완료 조건: 390px 중앙 정렬과 버튼의 무테두리 표현, 좁은 화면에서 겹침 없는 48px target, 200% 글자 접근을 기존 관련 브라우저 회귀와 실제 미리보기로 확인한다. 동작 변경이 없는 CSS 작업이므로 단위·타입·전체 빌드는 반복하지 않는다.
- 구현: 좌우 여백이 같은 grid에 ±5·재생을 중앙 배치하고 탭은 오른쪽 끝에 유지한다. 가용 폭에 따라 간격과 재생 크기를 줄이며 256px에서도 48px target을 겹치지 않게 유지한다. ±5·탭의 border/background를 제거하고 탭은 0.6875rem muted text로 표시한다.
- 검증: 수정 전 기존 화면 회귀에서 중앙 오차 95px 실패를 확인했다. 수정 후 관련 E2E 3개(25.6초), spec ESLint·CSS/spec Prettier·diff 검사 통과. coarse 16개 화면에서 중앙 오차 1px 이내·48px target·무겹침, 200% 글자 6개 화면에서 포커스 접근을 확인했다. 실제 IAB에서 중앙 재생·무테두리 ±5·작은 탭을 확인했고 사용자 88 BPM과 미리보기/서버를 유지한다.
- 문서·증거: 왼쪽 배치를 설명하던 기존 문서 9개를 중앙 배치로 동기화했다. source CSS와 E2E spec은 임시 실행 복사본과 동일하다. `output/playwright/mobile-ui-2026-09-29/mobile-390-centered-controls.png`와 REPORT 마지막 절에 결과를 남겼다.

## 2026-09-29 모바일 큰 박 숫자 확장·BPM 이동 — 완료

- 사용자 요청: 큰 박 숫자가 다른 조작과 겹치지 않고 화면의 여유 공간을 크게 사용하게 한다. 메인 BPM 표시 영역을 없애고 4/4 등의 박자표를 큰 박 숫자 옆에 두되 숫자 자체는 중앙을 유지한다.
- 판단·범위: 모바일 일반 stage의 BPM을 제거하고 직접 입력은 기존 설정에서 접근하도록 한다. 숫자·박자표는 같은 오디오 기준 canvas에서 분리해 그리며 기본 number variant와 desktop/fullscreen은 보존한다. phone stage는 가용 높이를 쓰고 원형 박·조작은 별도 grid 행으로 둔다. 부모 Page/CSS/unit, 기존 agent는 Visualizer·관련 E2E·문서를 각각 담당한다.
- 완료 조건: 숫자 중심과 박자표 분리·확대 회귀, 모바일 BPM 비노출과 설정 편집 왕복, 390px 큰 표시 영역과 짧은 화면/확대/상태/보면대의 무겹침을 관련 검증으로 확인한다. 이전 통과를 이번 결과로 재사용하지 않는다. 사용자 BPM과 기존 작업을 보존하고 미리보기/서버 유지, 커밋·푸시·배포 없음.
- 구현: 폭 599px 이하 일반 화면은 본문 높이를 채우고 숫자 panel에 남는 높이를 배분한다. 원형 박과 조작은 별도 행에 둔다. 모바일 메인 BPM 영역은 제거하고 세부 설정/인라인 설정의 `N BPM` 버튼으로 기존 입력 dialog를 연다. 큰 박 번호의 x 중심은 유지하고 오른쪽 박자표를 별도로 그린다. 정상박 전체의 실측 최대 범위로 글꼴 크기와 박자표 위치를 고정해 매 박 크기·위치가 흔들리지 않는다.
- 발견·수정: 실제 설정에서 4/4→3/4 변경 시 기존 4개 강세가 남아 Invalid TempoMap으로 화면이 중단됐다. 박 수를 줄일 때 기존 앞 강세를 보존하고 초과분을 제거하며, 늘릴 때 기본 강세를 채우도록 같은 변경에 묶었다. 3/4·6/8·5/4의 저장 맵 유효성과 보존 패턴 회귀를 추가했다.
- 이번 검증: MetronomePage 16개, BeatVisualizer 38개 단위 회귀 통과. 영향 E2E 8개는 초기 7개 통과 뒤 박자 변경 결함을 수정하고 실패 1개만 재실행해 통과했다. 390px 큰 표시·설정 박자 변경, coarse 16개 viewport, 200% 글자 6개 viewport, 중첩 BPM dialog 적용/취소/focus, 탭 입력, 설정 viewport focus, Medium 높이 경계, fullscreen을 확인했다. 웹/UI 타입 및 변경 소스·테스트 lint/format, diff 검사 통과. 전체 빌드와 무관한 서버 검증은 반복하지 않았다.
- 브라우저·산출물: IAB의 최종 390×844 화면에서 확대된 숫자·오른쪽 4/4·원형 박과 조작 분리·BPM 비노출을 확인했다. 세부 설정에서 기존 103 BPM이 유지됨을 확인했고 최종 일반 화면과 4174/8001 서버를 열어 두었다. 원본/실행 소스·테스트 7개가 동일하다. `output/playwright/mobile-ui-2026-09-29/REPORT.md` 마지막 절에 이번 결과를 기록하고 `mobile-390-centered-beat.png`에 대표 화면을 보존한다.
- 문서: AGENTS·README·RESPONSIVE_UX·UI_DESIGN·USER_GUIDE·FEATURES·ARCHITECTURE_AND_CODE_GUIDE·DESIGN·IMPLEMENTATION_PLAN·IMPLEMENTATION_RETROSPECTIVE 10개를 현재 배치와 설정·강세 정합성에 맞춰 갱신했다.

## 2026-09-29 모바일 속도 복원·배경 진행 — 완료

- 사용자 정정: 원형 박 아래 현재 속도 숫자를 다시 표시한다. BPM이라는 글자는 제거하되 4/4는 속도 숫자 옆에 배치한다. 큰 본박 숫자 영역에서는 박자표·아래 진행 막대·테두리를 제거하고 영역의 배경 자체가 진행을 표시한다.
- 범위와 판단: 모바일 메인에 기존 직접 입력 가능한 속도 숫자를 복원하고 설정의 중복 템포 버튼은 제거한다. 중앙 큰 본박 번호·원형 박·속도와 박자표·조작을 분리한다. background progress는 같은 오디오 frame의 진행 값을 사용하며 정지·대기·reduced motion에서는 채움을 끈다. desktop/fullscreen/기존 bar는 보존한다.
- 완료 조건: 큰 번호와 속도 숫자의 중앙 유지, 박자표 위치, 배경 채움과 bar 비노출을 해당 UI/Page 단위 및 관련 실제 모바일·짧은 화면·확대 회귀로 확인한다. 기존 103 BPM과 사용자 변경·서버·미리보기를 보존한다. 관련 문서의 이전 오해를 정정하고 커밋·푸시·배포는 하지 않는다.
- 발견·수정: canvas backing height가 min-content에 다시 반영되어 짧은 복구 화면의 숫자 최소 높이가 172/183px로 커졌고, frame progress가 0.12초 lookahead queue의 다음 클릭에 의존해 박 후반에만 갱신됐다. canvas를 wrapper 내부 absolute로 분리하고 progress를 전체 타임라인·예비박 계획에서 계산하도록 수정했다. 재생 중 map 변경도 실제 예약된 전환 시각부터 새 표시 타임라인을 사용하며 오디오 예약·동기 시각은 바꾸지 않았다.
- 최종 검증: MetronomePage 16개·BeatVisualizer 47개·useMetronome 29개 단위 회귀 통과. 기존 선택 E2E 5개는 처음 통과한 탭·직접 입력을 반복하지 않고, CSS 수정 후 coarse 16개 viewport와 hook 수정 후 대표 배치·실제 배경 픽셀/200% 확대 6개 viewport를 재실행해 모두 통과했다. 웹/UI 타입, 변경 소스·테스트 lint/format 통과. 전체 빌드·무관한 서버 검증은 반복하지 않았다.
- 브라우저·증거: 실제 IAB에서 속도 숫자·옆 박자표·테두리 없는 큰 숫자·재생 중 배경 채움을 확인했다. 확인 당시 사용자 값 103·12/8을 보존하고 정지 상태로 두었다. 현재 IAB 탭 5와 390×844 미리보기, 4174/8001 서버를 유지한다. 원본/실행 소스·테스트 8개가 동일하다. 최종 캡처는 `output/playwright/mobile-ui-2026-09-29/mobile-390-tempo-background.png`와 `mobile-390-background-playing.png`이며 별도 검증 브라우저의 100·4/4 예시다.
- 문서: 기존 관련 10개 문서를 정정하고 같은 output의 REPORT 마지막 절에 변경·실패 원인·실제 검증 결과를 남겼다. 요청 범위의 남은 실패는 없으며 커밋·푸시·배포하지 않았다.

## 2026-09-29 모바일 전체 화면 배경 진행 — 완료

- 요청: 큰 박 숫자 영역에서 차오르는 애니메이션을 모바일 화면 전체로 확장한다. 현재 숫자·원형 박·속도/박자표·조작 배치와 사용자 103·12/8 설정은 유지한다.
- 구현 경계: 기존 audio-frame/rAF를 사용하는 장식용 진행 canvas를 화면 뒤에 고정하고 상단·본문·하단 내비게이션 배경까지 한 면으로 채운다. canvas는 pointer/focus를 받지 않고 정지·예약 대기·모션 감소에서 비운다. 모바일 메트로놈을 떠나거나 desktop/fullscreen으로 바뀌면 제거한다. 오디오·타임라인·동기화 로직은 이번 범위에 포함하지 않는다.
- 완료 기준: 실제 재생 중 화면 가장자리와 하단까지 진행 배경이 이어지는지, 버튼/메뉴 조작과 기존 레이아웃이 유지되는지 확인한다. 관련 canvas/Page 회귀와 해당 브라우저 시나리오, 타입·변경 파일 lint 및 기존 설명 문서를 동기화한 뒤 종료한다. 기존 서버·미리보기·사용자 변경을 보존하고 커밋·푸시·배포하지 않는다.
- 구현: 장식용 `BeatVisualizer variant="progress"`를 body portal의 fixed viewport canvas로 추가했다. 활성 모바일 shell은 그 위에 두고 해당 내비게이션의 배경만 투명하게 했다. 기존 모바일 radial과 숫자 canvas의 중복 채움을 제거하고 숫자/조작 배치는 유지했다. 오디오 hook은 변경하지 않았다.
- 검증: 변경 전 Page 회귀 1개와 UI 장식 회귀 6개의 실패를 확인했다. 변경 후 Page 16개·UI 53개, 웹/UI TypeScript와 변경 파일 lint/format 통과. 기존 대표 E2E 1개가 10.9초에 통과했으며 전체 viewport/DPR·상중하 동일 부분 채움·중복 채움 없음·메뉴 조작·route/desktop/fullscreen 제거·reduced motion을 확인했다. 무관한 전체 회귀/릴리스 빌드는 반복하지 않았다.
- 결과: IAB에서 상단 마디부터 하단 메뉴까지 이어지는 실제 배경 채움을 확인하고 기존 103·12/8을 보존한 정지 상태로 두었다. 미리보기 탭 5와 4174/8001 서버를 유지한다. 새 캡처는 `output/playwright/mobile-ui-2026-09-29/mobile-390-screen-progress.png`이고 별도 검증 브라우저의 100·4/4 예시다. 관련 기존 문서 10개와 REPORT 마지막 절을 갱신했다. 요청 범위의 남은 실패는 없다.

## 2026-09-29 진행 배경의 메뉴 제외·최하단 배치 — 완료

- 요청: 진행 채움은 하단 메뉴 위까지만 표시하고 화면 요소 중 가장 뒤에서 그린다. 현재 숫자·조작·오디오 동작과 사용자 103·12/8을 보존한다.
- 범위와 판단: 진행 canvas를 모바일 AppShell 안에 두어 실제 내비게이션 크기 변수를 상속하고 fixed 영역에서 메뉴를 제외한다. 격리된 shell의 z-index -1 배경으로 배치하며 내비게이션 표면을 복원한다. Medium 가로 화면의 왼쪽 메뉴도 같은 기준으로 제외한다. Page/CSS, 기존 해당 회귀와 관련 문서만 수정한다.
- 완료 기준: 메뉴와 배경이 겹치지 않고 숫자/조작 아래에 표시되는 실제 화면과 대표 브라우저 회귀, 필요한 Page/타입/lint를 확인한다. 서버/미리보기는 유지하고 커밋·푸시·배포하지 않는다.
- 구현·검증: Page 내부 fixed canvas는 격리된 AppShell의 `z-index: -1`에서 실제 내비게이션 크기 변수를 상속한다. 원래 메뉴 표면을 복원했다. Page 16개·웹 타입·변경 소스/테스트 lint/format, 기존 대표 E2E 1개(10.3초) 통과. 390×844·768×1024, 768×600 왼쪽 rail, 390×844 200% 글자에서 실제 메뉴 경계와 canvas를 비교해 무겹침을 확인했다. UI pointer hit·재생 픽셀·route/fullscreen/reduced motion도 통과했다.
- 결과: IAB에서 메뉴 위까지의 채움과 고정 메뉴 표면을 직접 확인하고 기존 103·12/8을 보존한 정지 상태로 두었다. 새 캡처는 `output/playwright/mobile-ui-2026-09-29/mobile-390-content-progress.png`(독립 검증 브라우저 100·4/4)이며 REPORT 마지막 절과 관련 기존 문서 10개를 갱신했다. 원본/실행 소스·테스트 4개 동일. 기존 서버와 미리보기를 유지하며 요청 범위의 남은 실패는 없다.

## 2026-09-29 모바일 표시·직접 조작·집중 화면 — 완료

- 요청: 진행 배경을 진한 주황으로 바꾸고 큰 박 숫자만 80%로 줄인다. 원형 박을 중앙에 맞추고 속도/박자표의 기준선을 맞춘다. 속도는 직접 숫자 입력, 박자표는 선택 가능하게 한다. 상단 보면대 버튼 대신 큰 본박 숫자 탭으로 집중 화면을 전환하며 설정은 테두리 없는 아이콘으로 표시한다.
- 판단: 별도로 속도 숫자 입력 요청이 있으므로 집중 화면의 진입/복귀는 큰 본박 번호 탭으로 구분한다. 집중 화면에는 큰 번호·원형 박·속도/박자표·재생/정지만 남기고 Escape로도 복귀한다. 기본 진행 배경의 메뉴 제외/최하단 레이어와 사용자 103·12/8, 실제 오디오 수명은 유지한다. 데스크톱 fullscreen은 기존 동작을 보존한다.
- 범위/분담: 부모 Page/CSS/해당 단위 회귀·IAB; 기존 UI agent 숫자 스케일/원 중앙/배경색 계약; E2E agent 영향 시나리오·화면; 문서 agent 기존 관련 10개 설명 동기화. 기존 변경을 보존하고 커밋·푸시·배포하지 않는다.
- 완료 기준: 관련 단위·타입·변경 파일 lint/format과 모바일 직접 입력·박자 선택·집중 전환/복귀·재생 유지의 실제 브라우저 확인. 기존 서버·미리보기를 유지하고 정상/집중 화면 증거와 검증 결과를 남긴다.
- 구현: 모바일 progress는 `#f47a24`/0.3이며 메뉴 제외와 최하단 레이어를 유지한다. `numberScale={0.8}`로 fit 글자만 줄이고 bar 없는 원의 세로 중심을 맞췄다. 속도·박자표는 baseline을 맞추고 박자표 선택 dialog는 기존 강세 보존 함수를 재사용한다. 큰 번호 탭의 인앱 집중 화면은 번호·원·속도/박자표·재생/정지만 남긴다. 설정은 테두리 없는 아이콘으로 바꿨다.
- 발견·수정: 박자 선택 dialog의 Escape가 같은 이벤트에서 집중 화면까지 닫는 실제 E2E 실패를 확인했다. defaultPrevented와 이벤트의 dialog 경로를 확인해 입력 창만 닫도록 수정했다. 단위 테스트의 이미 Escape로 닫힌 dialog를 다시 취소하려던 잘못된 단계와 테스트 타입도 정정했다.
- 검증: MetronomePage 18개·BeatVisualizer 61개 단위 회귀, 웹/UI 타입 및 변경 소스·테스트 lint/format 통과. E2E 4개는 처음 통과한 3개를 반복하지 않고 실패한 대표만 수정 뒤 12.3초에 통과했다. 실제 픽셀 색/농도, 기준선·원 중심 오차 1px 이하, BPM/박자 입력·포커스 복귀, 집중 전환·다시 탭/Space/Escape 복귀와 재생 유지, 256px 입력·200% 글자·데스크톱 fullscreen을 확인했다.
- 결과: IAB에서 103 BPM 입력 적용·12/8 선택·재생 중 집중 전환과 큰 번호 재탭 복귀를 확인하고, 같은 설정의 정지 상태로 두었다. 탭 5와 API 8001·웹 4174는 유지한다. 원본/실행 소스·테스트 6개 동일. `mobile-390-focus-normal.png`, `mobile-390-focus-active.png`와 REPORT 마지막 절에 새 증거를 보존했다. 관련 기존 문서 10개를 동기화했으며 요청 범위의 남은 실패는 없다. 커밋·푸시·배포 및 전체 릴리스 빌드는 하지 않았다.

## 2026-09-29 main 통합·운영 배포 — 완료

- 승인: 사용자가 현재 작업을 main에 푸시하고 운영 배포하도록 명시 요청했다. FeelMyRythm의 현재 사용성/모바일 수정과 관련 서버·웹·문서·회귀를 codex에서 기록한 뒤 main에 직접 통합한다. dev 및 다른 앱/공유 인프라는 변경하지 않는다.
- 현재 시작점: codex `c8425f514f568a7a47fd7cbabef30671c86bd663`, 원격 main `7f132f01dcb9601a124bb6121771ee0cfb8aafeb`는 공통 조상에서 각 1개 커밋씩 갈라져 있다. main의 운영 자원 제한 커밋을 보존하며 통합한다. 기존 로컬 증거·미리보기·사용자 데이터를 보존한다.
- 통합 환경: 기존 main worktree는 macOS dataless PNG를 읽느라 상태 확인이 멈췄다. 해당 읽기 명령만 종료하고 `/private/tmp/fmr-main-release-11aek1sl`의 별도 main clone에서 통합·푸시한다. 기존 main 폴더와 dev는 수정하지 않는다. fetch는 dataless FETCH_HEAD를 쓰지 않는 옵션으로 성공했다.
- 진행: source `1be451afcbe48dd68d74b6c09b5e417d0f42d77a`를 기록하고 main에 merge commit `1e445b584c34dde99ac03773f4e7ff3a54ab9fb2`로 통합·푸시했다. 충돌은 OPERATIONS의 인접 설명 한 곳뿐이며 모바일 운영 안내와 기존 자원 제한 설명을 모두 보존했다. source와 통합 tree의 차이는 main의 Compose 자원 제한 9줄과 해당 문서 1줄뿐이다. 로컬 diff 검사·root/mobile 문서 포맷을 통과했고 배포 전 공개 health는 `{"ok":true}`였다. main Validate는 https://github.com/facio313/FeelMyRythm/actions/runs/36467756949 에서 실행 중이다.
- 첫 CI 결과: 서버·protocol·iOS·Android, 웹 format/lint/type/unit/build는 통과했다. 일반 E2E는 71개 통과·8개 실패로 배포가 중단됐다. 편집기 3개 mock에 새 access 조회의 leader 응답이 없었고, 화면 5개는 현재 작은 `탭` 글자 대신 이전 0px 아이콘 전용 상태를 기대했다. 앱 코드와 기존 충돌·오프라인·이동 차단 검사는 유지한 채 fixture/기대값을 수정했다. 실패했던 8개만 로컬에서 다시 실행해 모두 통과(1.1분), 두 spec의 ESLint·Prettier도 통과했다.
- 로컬 재현 환경: 임시 실행 복사본의 root/app manifest·Vite 설정·index.html 등 추적 파일 323개가 없어 첫 실행이 불가했다. 존재하는 파일·local DB·node_modules는 덮어쓰지 않고 통합 clone에서 누락 파일만 복원했으며 기존 4174 서버의 HTTP 200을 확인했다. 이 환경 실패는 테스트 통과 근거에서 제외한다. 테스트 수정과 원인을 기존 회고 문서에도 기록했으며 다음 main CI를 진행한다.
- 보완 후 진행: source `abe6d2f`를 main `3881884069025eb41b4f72b06f73885b792d772c`로 통합·푸시했다. Validate https://github.com/facio313/FeelMyRythm/actions/runs/36469899148 의 server·protocol·javascript·iOS·Android가 모두 성공했다. 웹 계열 단위 418개, 일반 E2E 79개(6.9분), PWA E2E 2개(13.7초) 통과를 로그로 확인했다. 같은 SHA의 https://github.com/facio313/FeelMyRythm/actions/runs/36471052621 에서 운영 이미지 publish/deploy가 실행 중이다.
- 최종 결과: 위 publish/runtime image smoke와 제한 배포 job이 모두 성공했다. 배포기는 DB backup → target canary → strict dependency checks → server/web 교체를 완료하고 `FeelMyRythm deployed successfully: 3881884069025eb41b4f72b06f73885b792d772c`를 기록했다(2026-09-29 04:21 KST). PostgreSQL target head·Redis·local upload root·공개 HTTPS health는 모두 passed이며 SMTP와 native association은 기존 운영 프로필에 따라 skipped다.
- 배포 후 확인: GitHub main SHA가 위 target과 일치하고 공개 `/feelmyrythm/api/health`는 `{"ok":true}`를 반환했다. 비인증 HTML/새 CSS 요청은 기존 중앙 SSO `/sso/`로 HTTP 302를 반환한다. Python이 이 redirect를 따라간 최종 SSO 요청은 403이었으므로 로그인 후 실제 사용자 흐름을 확인한 것으로 계산하지 않는다. 앱의 로그인 후 화면 전체 회귀를 운영에서 다시 실행하지 않았다.
- 인수인계: source codex는 `abe6d2f`, 원격 main은 `3881884`이며 dev를 변경하거나 codex를 별도로 푸시하지 않았다. 기존 main 폴더는 보존하고 임시 main clone은 `/private/tmp/fmr-main-release-11aek1sl`에 남겼다. 현재 문서의 최종 배포 결과만 로컬 기록으로 남겨 불필요한 추가 CI/배포를 만들지 않는다. 요청 범위의 남은 실패는 없다.
- 경로와 완료 기준: 현재 main의 GitHub Validate → immutable ARM64 image build/runtime smoke → 제한 배포 명령 흐름을 사용한다. 정확한 main SHA의 CI·publish·deploy 성공 및 배포기 상태/공개 health·대표 읽기를 확인한 뒤 완료 보고한다. 이미 통과한 로컬 전체 검증은 반복하지 않고 통합 충돌이나 새 변경의 영향만 검증한다. migration 실패 시 server image-only rollback을 하지 않는 기존 복구 경계를 유지한다.
