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

로컬 개발은 `.env`의 `FMR_ENVIRONMENT=development`, SQLite `FMR_DATABASE_URL`, `FMR_STORAGE_BACKEND=local`을 사용하세요. `.env`와 비밀값은 커밋하지 않습니다.

```bash
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

`check`는 Prettier, ESLint, TypeScript, Vitest, Ruff, mypy, pytest, 프로덕션 빌드를 순서대로 실행합니다. 일반 Playwright는 `/feelmyrythm/` basename, 템포 편집, 목 WS 세션 시작을 검증합니다. 별도 PWA 게이트는 구형 Service Worker와 `fmr-api` 캐시를 실제 브라우저에 만들고 보안 worker로 교체하는 중에 발생한 마지막 legacy write까지 제거되는지 확인합니다.

GitHub `Validate`의 JavaScript job은 프로젝트의 Playwright 버전과 일치하는 digest 고정 공식 브라우저 이미지에서 실행하므로 매 실행마다 Chromium과 시스템 의존성을 내려받지 않습니다. 모바일 job은 clean checkout에서 웹 번들이 의존하는 `core`·`audio` workspace package를 먼저 빌드한 뒤 Android/iOS 프로젝트를 동기화하고 native shell을 compile합니다. Android job은 Gradle 및 Capacitor의 Java 21 source level과 같은 Temurin JDK 21을 명시적으로 설치합니다. 서버와 protocol job은 서버 이미지와 같은 Python patch를 명시적으로 설치하며, 해당 patch를 지원하는 동일한 uv 버전을 사용합니다. 저장소 루트의 `.env.example`·운영 Compose 계약은 이 전체 checkout 검증에서 강제하고, 격리된 서버 이미지 테스트 단계는 서버 빌드 컨텍스트 안의 테스트만 다시 실행합니다. 어느 job이라도 실패하면 이미지 publish와 RPi 배포는 실행되지 않습니다.

웹 PWA는 App을 보이기 전에 구형 인증 API 캐시를 fail-closed로 정리합니다. 삭제나 versioned Service Worker 제어권 전환을 확인할 수 없으면 보안 안내와 재시도만 표시하며, `/feelmyrythm/api/*`는 Service Worker와 nginx 모두에서 캐시하지 않습니다.

30분 클릭 간격·drift와 두 기기 녹음의 ±10ms 차이는 [audio quality 도구](scripts/audio_quality/README.md)로 같은 절차에서 분석할 수 있습니다.

## 모바일

workspace 라이브러리와 웹을 빌드한 후 네이티브 프로젝트를 동기화합니다.

```bash
corepack pnpm build:workspace-libs
corepack pnpm --filter @feelmyrythm/mobile sync:ios
corepack pnpm --filter @feelmyrythm/mobile sync:android
```

실기기의 화면 꺼짐·백그라운드 오디오·무음 스위치·두 기기 파형 차이는 스토어 빌드에서 반드시 재검증해야 합니다.

공개 개인정보 처리 안내는 `/feelmyrythm/privacy`, 앱을 설치하지 않고 시작할 수 있는 계정 삭제 경로는 `/feelmyrythm/delete-account`입니다. 스토어 제출 전 실제 운영자 연락처와 두 URL의 운영 접근성을 확인해야 합니다.

## 배포

운영 경로는 `https://bonifacio.work/feelmyrythm/`입니다. `main`의 40자 commit SHA로 ARM64 이미지를 GHCR에 발행하고, 제한 SSH 명령 `deploy feelmyrythm <sha>`로만 RPi 배포를 요청합니다. Python·Node·nginx·uv·PostgreSQL·Redis 기반 이미지는 version과 digest를 고정하고, 정확한 publish 태그를 실제 PostgreSQL·Redis와 함께 먼저 실행해 Alembic migration·non-root server·nginx SPA fallback·security/cache header·API proxy를 smoke한 뒤에만 push합니다. Alembic 도입 전 `create_all` 운영 DB는 알려진 legacy schema일 때만 한 transaction에서 revision schema로 변환하고 row를 보존하며, 알 수 없는 unversioned schema는 시작을 거부합니다. Compose는 DB를 만들지 않고 외부 `cksDB` 네트워크의 전용 DB/계정에 연결합니다. 운영 서버는 `FMR_STORAGE_BACKEND=s3`로 고정되며 `.env`에 `FMR_S3_BUCKET`과 `FMR_S3_REGION`이 없으면 시작하지 않습니다.

악보 업로드는 client가 staging key에만 쓰고 complete가 final key로 promote합니다. 삭제 API의 204는 논리 삭제와 durable object-deletion outbox의 원자 commit을 뜻하며, storage worker가 lease와 backoff로 실제 객체 삭제를 멱등 재시도합니다. 운영에서는 worker를 끄지 말고 staging prefix에 bucket lifecycle rule도 방어층으로 설정하되, correctness는 DB outbox와 late-upload guard가 보장합니다.

password 가입의 이메일 인증을 위해 운영 `.env`에는 HTTPS `FMR_WEB_APP_BASE_URL`, `FMR_SMTP_HOST`, `FMR_SMTP_FROM_EMAIL`이 필요합니다. 기본은 587/STARTTLS이며 SMTP 인증을 사용한다면 `FMR_SMTP_USERNAME`과 `FMR_SMTP_PASSWORD`를 함께 설정합니다.

Google 로그인을 켤 때는 서버의 `FMR_GOOGLE_CLIENT_ID`와 GitHub Repository Variable `VITE_GOOGLE_CLIENT_ID`에 같은 OAuth 웹 클라이언트 ID를 설정합니다. 클라이언트 ID는 web image 빌드 시 주입되고 비밀값으로 취급하지 않습니다.
