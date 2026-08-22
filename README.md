# FeelMyRythm

앙상블 멤버가 같은 템포맵과 서버 시각을 기준으로 각 기기에서 클릭을 결정론적으로 재생하는 메트로놈입니다. 악보·마디 매핑·필기·연습일지·할일·튜너를 같은 레퍼토리에서 관리합니다.

상세 설계와 구현 순서는 [DESIGN.md](docs/DESIGN.md), [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), [UI_DESIGN.md](docs/UI_DESIGN.md)에 있습니다. 화면 크기·방향·입력 방식·접근성에 따른 동작은 [RESPONSIVE_UX.md](docs/RESPONSIVE_UX.md)가 구현 계약이며, 프로젝트 전역 규칙은 [AGENTS.md](AGENTS.md)가 기준입니다.

## 구성

- `packages/core`: 순수 TypeScript 템포맵 전개, 마디 탐색, count-in, 시계 동기, 캘리브레이션
- `packages/audio`: Web Audio 버퍼 클릭, Worker lookahead scheduler, transport, YIN 튜너
- `packages/ui`: Tailwind 4 토큰, Radix 기반 공용 컴포넌트, audio-clock beat visualizer
- `packages/protocol`: FastAPI OpenAPI에서 생성한 REST/WS TypeScript 타입
- `apps/web`: React 19 + Vite PWA, 오프라인 IndexedDB, 템포 편집·세션·악보·연습·튜너 UI
- `apps/server`: FastAPI + SQLAlchemy 2 + Alembic, JWT/OAuth, PostgreSQL, REST/WS, S3/local upload
- `apps/mobile`: Capacitor iOS/Android 웹 래퍼, Keep Awake, haptics, deep link

## 로컬 실행

필요 버전은 Node.js 22+, pnpm 10.15, Python 3.13, uv입니다.

```bash
corepack pnpm install --frozen-lockfile
uv sync --project apps/server --frozen --all-groups
cp .env.example .env
```

로컬 개발은 `.env`의 `FMR_ENVIRONMENT=development`, SQLite `FMR_DATABASE_URL`, `FMR_STORAGE_BACKEND=local`을 사용하세요. `.env`와 비밀값은 커밋하지 않습니다. 인증 mode는 branch에 고정됩니다. `main`/`dev`는 `sso`, 그 밖의 branch는 `local`이며 [`scripts/portfolio-auth-mode.sh`](scripts/portfolio-auth-mode.sh)가 명시값 → `GITHUB_REF_NAME` → 현재 Git branch 순으로 판정합니다. 명시한 mode가 branch와 다르면 실행하지 않습니다.

독립적인 회원가입·로그인과 proxy 없는 직접 접근은 tool/feature branch에서 실행합니다. 아래 server 명령과 root `pnpm dev`는 `local`을 명시적으로 요청하므로 `main`/`dev`에서는 즉시 실패합니다. 보호 branch는 앱 전용 edge secret과 중앙 SSO edge를 준비한 배포 경로로만 실행합니다.

```bash
PORTFOLIO_AUTH_MODE=local scripts/portfolio-auth-mode.sh exec -- \
  uv run --project apps/server uvicorn app.main:app --app-dir apps/server --reload
corepack pnpm dev
```

웹은 `http://localhost:5173/feelmyrythm/`, API health check는 `http://localhost:8000/api/health`입니다.

## 검증

```bash
corepack pnpm check
corepack pnpm protocol:check
corepack pnpm test:e2e
corepack pnpm test:e2e:pwa
```

`check`는 공통 branch/auth resolver, Prettier, ESLint, TypeScript, Vitest, Ruff, mypy, pytest, 프로덕션 빌드를 순서대로 실행합니다. `FMR_SSO_ENABLED`와 `VITE_FMR_SSO_ENABLED`는 canonical mode의 선택적 호환 adapter이며, 명시할 때는 canonical 결과와 일치해야 합니다. 일반 Playwright와 PWA는 배포 산출물이 아닌 명시적 `e2e*/local` fixture로 로컬 로그인 UI를 검증하고, CI의 별도 `pnpm build`는 실제 source branch의 canonical mode를 검증합니다. 일반 Playwright는 `/feelmyrythm/` basename, 템포 편집, 목 WS 세션 시작을 확인합니다. 별도 PWA 게이트는 구형 Service Worker와 `fmr-api` 캐시를 실제 브라우저에 만들고 보안 worker로 교체하는 중에 발생한 마지막 legacy write까지 제거되는지 확인합니다.

GitHub `Validate`의 JavaScript job은 프로젝트의 Playwright 버전과 일치하는 digest 고정 공식 브라우저 이미지에서 실행하므로 매 실행마다 Chromium과 시스템 의존성을 내려받지 않습니다. 모바일 job은 clean checkout에서 웹 번들이 의존하는 `core`·`audio` workspace package를 먼저 빌드한 뒤 Android/iOS 프로젝트를 동기화하고 native shell을 compile합니다. Android job은 Gradle 및 Capacitor의 Java 21 source level과 같은 Temurin JDK 21을 명시적으로 설치합니다. 서버와 protocol job은 서버 이미지와 같은 Python patch를 명시적으로 설치하며, 해당 patch를 지원하는 동일한 uv 버전을 사용합니다. 저장소 루트의 `.env.example`·운영 Compose 계약은 이 전체 checkout 검증에서 강제하고, 격리된 서버 이미지 테스트 단계는 서버 빌드 컨텍스트 안의 테스트만 다시 실행합니다. `dev`의 성공한 Validate도 ARM64 server/web image build와 runtime smoke까지 수행하지만 registry push, latest 취급, RPi 운영 배포는 `main`에만 허용합니다. 어느 job이라도 실패하면 image publish와 RPi 배포는 실행되지 않습니다.

웹 PWA는 App을 보이기 전에 구형 인증 API 캐시를 fail-closed로 정리합니다. 삭제나 versioned Service Worker 제어권 전환을 확인할 수 없으면 보안 안내와 재시도만 표시하며, `/feelmyrythm/api/*`는 Service Worker와 nginx 모두에서 캐시하지 않습니다.

30분 클릭 간격·drift와 두 기기 녹음의 ±10ms 차이는 [audio quality 도구](scripts/audio_quality/README.md)로 같은 절차에서 분석할 수 있습니다.

## 모바일

workspace 라이브러리와 웹을 빌드한 후 네이티브 프로젝트를 동기화합니다.

```bash
corepack pnpm build:workspace-libs
scripts/portfolio-auth-mode.sh exec -- corepack pnpm --filter @feelmyrythm/mobile sync:ios
scripts/portfolio-auth-mode.sh exec -- corepack pnpm --filter @feelmyrythm/mobile sync:android
```

실기기의 화면 꺼짐·백그라운드 오디오·무음 스위치·두 기기 파형 차이는 스토어 빌드에서 반드시 재검증해야 합니다.

공개 개인정보 처리 안내는 `/feelmyrythm/privacy`, 앱을 설치하지 않고 시작할 수 있는 계정 삭제 경로는 `/feelmyrythm/delete-account`입니다. 스토어 제출 전 실제 운영자 연락처와 두 URL의 운영 접근성을 확인해야 합니다.

## 배포

운영 경로는 `https://bonifacio.work/feelmyrythm/`입니다. `main`의 40자 commit SHA로 ARM64 이미지를 GHCR에 발행하고, 제한 SSH 명령 `deploy feelmyrythm <sha>`로만 RPi 배포를 요청합니다. workflow, image build arg, 운영 Compose에는 `PORTFOLIO_BRANCH=main`, `PORTFOLIO_AUTH_MODE=sso`를 명시합니다. Python·Node·nginx·uv·PostgreSQL·Redis 기반 이미지는 version과 digest를 고정하고, 정확한 publish 태그를 실제 PostgreSQL·Redis와 함께 먼저 실행해 Alembic migration·non-root server·nginx SPA fallback·security/cache header·API proxy를 smoke한 뒤에만 push합니다. Alembic 도입 전 `create_all` 운영 DB는 알려진 legacy schema일 때만 한 transaction에서 revision schema로 변환하고 row를 보존하며, 알 수 없는 unversioned schema는 시작을 거부합니다. Compose는 DB를 만들지 않고 외부 `cksDB` 네트워크의 전용 DB/계정에 연결하며, RPi에서는 다른 앱과 격리된 내부 전용 Redis를 사용합니다. 배포기는 pre-migration dependency/revision 검사와 DB backup 후 target server canary를 먼저 확인하고 strict head 검사를 반복하며, migration 뒤에는 schema와 맞지 않을 수 있는 이전 server image로 자동 rollback하지 않고 forward-fix합니다. 전체 절차는 [운영 준비 및 검증](docs/OPERATIONS.md)을 따릅니다.

현재 RPi는 S3·SMTP 준비 전의 명시적 `managed_local_sso` 임시 프로필입니다. 악보는 삭제 금지 전용 named volume에 보존하고 메일 기능은 닫은 채 사용할 수 있습니다. Browser production은 `bonifacio.work` 중앙 관리자가 만든 계정을 immutable SSO subject로 연결합니다. 기존 owner는 첫 trusted exchange에서 unique email로 한 번만 연결하고, 새 중앙 계정은 verified active 앱 사용자로 자동 provision합니다. 앱의 로컬 로그인·회원가입·복구·계정 삭제는 노출하지 않습니다. 모든 bearer HTTP 요청과 refresh/logout, room·annotation WebSocket의 첫 token frame은 중앙 subject, canonical `Remote-Groups`(`user < developer < admin`) 및 앱 전용 edge secret을 다시 검사합니다. 일반 도메인 작업은 최소 `user`, 인증 인벤토리는 `developer`, 멱등 credential/session 정리는 `admin`을 요구하며 중앙 역할이 그룹 owner/leader/member 권한을 우회하지 않습니다. SSO startup은 남아 있는 password/Google credential과 그 세션, revoked/expired refresh row를 정리하되 User와 도메인 참조는 보존합니다. 별도 admin cleanup은 명시적 active-refresh purge 확인값을 요구하고 현재 access JWT는 남은 수명까지만 유효한 채 모든 refresh row를 제거합니다. 운영 edge secret은 Compose나 `.env` 본문이 아니라 rootless host의 `cks:cks` mode-0640 regular file을 read-only mount해 `FMR_SSO_EDGE_SECRET_FILE`로 읽습니다. Compose는 비-root UID 10001과 GID 0으로 서버를 실행하고 container 내부 `root:root` mode 0640을 검증합니다. 웹은 첫 진입에 임시 적용 사항과 남은 S3 이관·SMTP·backup·mobile association·OMR 작업을 dialog로 보여 주고 topbar 경고 버튼으로 다시 엽니다. 정식 전환에서는 standard profile의 S3·SMTP preflight를 통과하고 local object를 이관한 뒤 이 build flag와 dialog를 함께 제거합니다.

악보 업로드는 client가 staging key에만 쓰고 complete가 final key로 promote합니다. 삭제 API의 204는 논리 삭제와 durable object-deletion outbox의 원자 commit을 뜻하며, storage worker가 lease와 backoff로 실제 객체 삭제를 멱등 재시도합니다. 운영에서는 worker를 끄지 말고 staging prefix에 bucket lifecycle rule도 방어층으로 설정하되, correctness는 DB outbox와 late-upload guard가 보장합니다.

standard password 가입의 이메일 인증을 위해 운영 `.env`에는 HTTPS `FMR_WEB_APP_BASE_URL`, `FMR_SMTP_HOST`, `FMR_SMTP_FROM_EMAIL`이 필요합니다. 기본은 587/STARTTLS이며 SMTP 인증을 사용한다면 `FMR_SMTP_USERNAME`과 `FMR_SMTP_PASSWORD`를 함께 설정합니다. 임시 managed-local SSO profile에서 이 값을 가짜로 채우거나 개발용 token logging을 켜지 않습니다.

Google 로그인을 켤 때는 서버의 `FMR_GOOGLE_CLIENT_ID`와 GitHub Repository Variable `VITE_GOOGLE_CLIENT_ID`에 같은 OAuth 웹 클라이언트 ID를 설정합니다. 클라이언트 ID는 web image 빌드 시 주입되고 비밀값으로 취급하지 않습니다.
