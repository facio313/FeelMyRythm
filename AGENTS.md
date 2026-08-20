# FeelMyRythm — AGENTS.md

> 앙상블 동기화 메트로놈 + 악보/연습 관리
> 설계: [docs/DESIGN.md](docs/DESIGN.md) · 구현: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · UI: [docs/UI_DESIGN.md](docs/UI_DESIGN.md)

---

## ⚠️ Agent Authority Boundaries — MUST READ FIRST

### 1. Branch Scope per Agent

Each AI agent may only work within its own persistent tool branch by default.
**`main` and `dev` branches are managed exclusively by the user.**

| Branch      | Who controls it |
| ----------- | --------------- |
| `main`      | User only       |
| `dev`       | User only       |
| `anthropic` | Claude Code     |
| `cursor`    | Cursor          |
| `codex`     | OpenAI Codex    |

- Agents **must not** commit, merge, or push to `main` or `dev` without an explicit user request.
- When the user explicitly asks, agents may assist with `main`/`dev` operations.
- Agents work directly on their persistent tool branch and must not create or switch to a feature branch unless the user explicitly requests one.
- If the user explicitly requests a feature branch, it remains controlled by the corresponding agent and must be merged back into the persistent tool branch before completion unless the user asks to leave it separate.

### 2. Shared Project Information → Always Update `AGENTS.md`

프로젝트 전역 규칙·아키텍처·제약이 바뀌면 **`AGENTS.md`를 갱신**한다.
개별 툴 설정만 고치면 다른 에이전트가 놓친다.

| Type of change                                | Where to update                         |
| --------------------------------------------- | --------------------------------------- |
| Project rules, domain logic, API, constraints | `AGENTS.md` ✅                          |
| Claude Code-only settings                     | `.claude/`                              |
| Cursor rule formatting                        | `.cursor/rules/`                        |
| Codex-only instructions                       | `AGENTS.md` (Codex reads this directly) |

개별 파일(`CLAUDE.md`, `.cursor/rules/`)은 `AGENTS.md`를 가리키는 thin wrapper다.

### 3. App Changes → Always Update Related Documentation

앱의 코드·설정·스키마·UI·빌드·배포 동작을 변경할 때는 **그 내용을 설명하는 기존 관련 문서를 같은 작업에서 반드시 수정**한다. 코드만 바꾸고 문서를 이전 상태로 남긴 작업은 완료로 간주하지 않는다.

| App change                          | Documents to update when they cover the changed surface                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| 사용자 기능·화면·조작 흐름          | `docs/FEATURES.md`, `docs/USER_GUIDE.md`, root/app `README.md`                            |
| 도메인 규칙·동기화·오디오·보안 계약 | `docs/DESIGN.md`, `AGENTS.md`                                                             |
| 구현 상태·단계·완료 기준            | `docs/IMPLEMENTATION_PLAN.md`, `docs/IMPLEMENTATION_RETROSPECTIVE.md`                     |
| UI·반응형·접근성 계약               | `docs/UI_DESIGN.md`, `docs/RESPONSIVE_UX.md`                                              |
| 패키지 구조·API·런타임 경계         | `docs/ARCHITECTURE_AND_CODE_GUIDE.md`, 해당 app/package `README.md`, 생성된 protocol 계약 |
| 환경변수·빌드·운영·배포 절차        | `.env.example`, `docs/OPERATIONS.md`, root/app `README.md`                                |
| 모바일 네이티브 동작·서명·딥링크    | `apps/mobile/README.md`, 관련 설계·운영 문서                                              |

- 변경된 동작을 실제로 설명하는 문서가 여러 개면 한 문서만 고르지 말고 모두 동기화한다.
- 관련 기존 문서가 없는 영역은 이 규칙만으로 새 문서 생성을 강제하지 않지만, 전역 계약이 새로 생기면 `AGENTS.md`에 기록한다.
- 완료 보고에는 함께 수정한 문서를 명시한다.

---

## Vowline

<!-- vowline:start -->

Always use the skill `vowline` consistently, including for all sub-agents.
<!-- vowline:end -->

| 에이전트    | 전역 스킬 경로              | 활성화 방식                               |
| ----------- | --------------------------- | ----------------------------------------- |
| Claude Code | `~/.claude/skills/vowline/` | `~/.claude/CLAUDE.md` 마커 블록           |
| Codex       | `~/.agents/skills/vowline/` | `~/.codex/AGENTS.md` 마커 블록            |
| Cursor      | `~/.cursor/skills/vowline/` | `.cursor/rules/vowline.mdc` (alwaysApply) |

---

## Memento MCP

- **엔드포인트**: `http://localhost:57332/mcp`
- Claude Code / Cursor / Codex 모두 동일 서버에 연결
- 세션 시작: `context` → 작업 중 `recall`/`remember` → 종료 `reflect`

---

## Stack

| 영역   | 선택                                                                  |
| ------ | --------------------------------------------------------------------- |
| 웹     | React 19 + Vite + Tailwind 4                                          |
| 서버   | Python 3.13 + FastAPI + SQLAlchemy 2                                  |
| DB     | PostgreSQL (운영은 공용 `cksDB`, 로컬 개발은 SQLite 가능)             |
| 코어   | `packages/core` 순수 TS (템포맵·시계동기)                             |
| 오디오 | 웹 Web Audio 룩어헤드 + 모바일 AVAudioEngine/Oboe 네이티브 큐         |
| 모바일 | Capacitor (웹 빌드 래핑)                                              |
| 배포   | GitHub-hosted ARM64 Actions → GHCR immutable images → RPi 제한 배포기 |

### Production Routing and Deployment

- 공개 URL은 `https://bonifacio.work/feelmyrythm/`이며 Vite `base`와 React Router `basename`은 `/feelmyrythm/`을 기준으로 한다.
- 브라우저의 REST/WS 경로는 각각 `/feelmyrythm/api/*`, `/feelmyrythm/ws/*`이다. 이미지 내부 nginx가 prefix를 제거해 FastAPI의 기존 `/api/*`, `/ws/*`로 전달한다.
- 운영 이미지는 `ghcr.io/facio313/feelmyrythm-server:<commit-sha>`와 `ghcr.io/facio313/feelmyrythm-web:<commit-sha>`이다. RPi에서 소스를 빌드하지 않는다.
- 운영 Compose는 별도 DB를 생성하지 않는다. `fmrServer`를 외부 `cksDB` Docker 네트워크에 연결하고, `.env`의 `FMR_DATABASE_URL`로 공용 `cksDB` 안의 전용 DB/계정에 접속한다.
- `bonifacio.work` RPi 배포는 host port가 없는 전용 `fmrRedis`를 내부 backend network에 두고 `FMR_REDIS_URL=redis://fmrRedis:6379/0`을 Compose에서 고정한다. 다른 앱의 Redis를 공유하거나 public network에 노출하지 않는다.
- S3·SMTP 준비 전의 현재 RPi는 `FMR_DEPLOYMENT_PROFILE=managed_local_sso`를 명시하고 UID 10001이 쓰는 전용 persistent upload volume만 사용한다. 이 프로필에서는 중앙 관리자가 만든 SSO identity를 앱 사용자로 자동 provision하되 공개 가입·로컬 로그인·Google·인증 재전송·비밀번호 reset·메일 기반 탈퇴 challenge는 닫는다. 일반 `production` 또는 암묵적 development fallback으로 이 제한을 우회하지 않는다.
- 배포 요청은 forced-command SSH 키를 통해 `deploy feelmyrythm <40-character-sha>`만 허용한다. 배포 과정에서 전역 image prune, stack-wide `down`, DB/volume 삭제를 실행하지 않는다.
- GitHub deploy job timeout은 host의 최대 20분 전역 배포 lock 대기와 target 검증 시간을 모두 포함해야 하며 현재 40분보다 짧게 줄이지 않는다.
- 배포기는 target image에서 설정·provider와 현재 Alembic revision이 target의 정확한 알려진 조상인지 pre-migration 검증하고 DB backup을 완료한 뒤 loopback canary를 먼저 기동한다. canary migration 뒤에는 strict target-head preflight를 다시 통과해야 한다. migration이 실행된 뒤 server health가 실패해도 schema와 맞지 않을 수 있는 이전 server image로 자동 복귀하지 않고 forward-fix를 요구한다. 독립적인 web image만 이전 web image로 복귀할 수 있다.

---

## Branch Strategy

### Worktree Layout

| Directory                          | Branch      | AI Tool              |
| ---------------------------------- | ----------- | -------------------- |
| `FeelMyRythm/` (main repo)         | `main`      | — (release baseline) |
| `FeelMyRythm/worktrees/codex/`     | `codex`     | OpenAI Codex         |
| `FeelMyRythm/worktrees/cursor/`    | `cursor`    | Cursor               |
| `FeelMyRythm/worktrees/anthropic/` | `anthropic` | Claude Code          |

### Flow

```
codex ──────┐
cursor ─────┤→ dev → main
anthropic ──┘
```

1. Work and commit directly on the assigned persistent tool branch:
   ```bash
   git switch cursor
   ```
2. Push the validated tool branch:
   ```bash
   git push origin cursor
   ```
3. Merge the tool branch into `dev` after validation (user):
   ```bash
   git checkout dev && git merge cursor
   ```
4. Merge `dev` into `main` after full verification only (user).

### Naming Rules

- Tool branches: `codex`, `cursor`, `anthropic`
- Feature branches are exceptional and require an explicit user request. When requested, use `{tool}-feature-{kebab-case-feature}` — e.g. `cursor-feature-sync-session`.
- English kebab-case only.

---

## Critical Constraints

- **결정론적 동기화** — 박을 스트리밍하지 않는다. 시계 합의(`serverStartTime`) + 로컬 타임라인 전개. 설계문서 §6.
- **오디오 우선** — 시각화는 오디오 클럭 기준 rAF. `setTimeout`으로 클릭/시각 금지. 설계문서 §5.
- **코어 순수성** — `packages/core`에 DOM/플랫폼 의존성 넣지 말 것.
- **템포맵 revision** — 수정 시 revision 증가. 동시 수정은 409. 동기 세션은 동일 revision 보장.
- **악보 설정 원자성** — `Score` metadata와 `MeasureMap`은 `/scores/{id}/settings`에서 revision 검증 후 한 transaction으로 저장한다. 최초 map 생성도 `Score` parent row를 잠그며 경합은 409다.
- **서버 권위와 캐시 경계** — 원격 악보 캐시는 network failure에만 fallback한다. 인증·권한·404·409·검증 오류·서버 오류를 오래된 IndexedDB 데이터로 숨기지 않는다.
- **인증·오프라인 데이터 격리** — Service Worker는 인증 API 응답을 Cache Storage에 저장하지 않는다. 원격 IndexedDB snapshot은 schema v3의 `userId` 복합 키로 격리하며, 소유자를 알 수 없는 구형 원격 cache는 마이그레이션에서 폐기한다.
- **PWA 인증 캐시 이행** — App을 mount하기 전 구형 `fmr-api` 캐시를 fail-closed로 삭제하고, 보안 generation이 표시된 `sw.js?fmr-safety=v1`의 제어권과 구형 worker 종료를 확인한 뒤 다시 purge한다. 캐시 확인·삭제·worker 전환을 증명하지 못하면 앱을 시작하지 않는다. Service Worker와 nginx는 `/api/*`를 캐시하지 않는다.
- **`.env` 커밋 금지**. `FMR_*` / DB 자격증명 / `DEPLOY_*` 하드코딩 금지.
- **배포 시크릿** — GitHub Repository Secret `DEPLOY_KEY`만 사용한다. 호스트·포트·사용자·서버 공개 host key는 워크플로에 고정되어 있다.
- **공용 DB 보호** — 앱 배포에서 `cksDB` 컨테이너·네트워크·데이터를 생성, 재시작, 삭제하지 않는다.
- **스키마 배포 복구** — migration 이후 server image-only rollback을 금지한다. schema 변경은 expand/contract 호환성을 유지하고, 실패하면 forward-fix를 우선한다. DB restore는 검증된 backup과 명시적 outage 절차가 있을 때만 수행한다.
- **운영 객체 저장소** — standard production은 `FMR_STORAGE_BACKEND=s3`, 비어 있지 않은 bucket/region, 활성화된 storage lifecycle worker 없이는 시작하지 않는다. 명시적 `managed_local_sso` 임시 프로필만 전용 persistent volume의 절대 경로를 허용하며 volume backup과 S3 이관 전에는 삭제하지 않는다.
- **악보 객체 생명주기** — Score·Repertoire·Project·Group 삭제는 DB transaction에서 하위 Score를 논리 삭제하고 객체 키를 durable outbox에 함께 기록한다. 204는 이 transaction의 commit을 뜻하며, lease worker가 모든 키를 멱등 삭제하고 실패를 포기 없이 backoff 재시도한다.
- **계정 삭제 생명주기** — password 계정은 현재 비밀번호를, Google-only 계정은 브라우저의 새 Google ID credential 또는 native에서도 열 수 있는 만료·1회용 확인 메일을 검증한다. 탈퇴 transaction은 소유 그룹의 모든 Score 객체 키를 같은 durable outbox에 기록하고 다른 그룹의 개인 데이터·멤버십을 제거하며, RESTRICT 감사 참조는 비활성 비식별 tombstone User로 보존한다.
- **반응형 UX 계약** — 모든 화면은 [docs/RESPONSIVE_UX.md](docs/RESPONSIVE_UX.md)의 폭·높이·입력 방식·접근성 매트릭스를 따른다. 페이지 자체의 가로 overflow, 고정 내비게이션에 가려진 조작, 44px 미만 핵심 터치 타깃을 허용하지 않으며 `any-pointer: coarse`인 기기의 핵심 타겟과 공용 input/select는 `--fmr-touch-target`으로 48px을 확보한다.
- **모바일/웹 원점 분리** — 웹의 `/feelmyrythm/` basename과 Capacitor 로컬 자산 base/API·WS 원점을 빌드 모드별로 명시한다. WebView localhost를 운영 API로 간주하지 않는다.
- 사용자 응답 **한국어**. 코드·식별자·커밋은 **영문**.

---

## Implemented Contracts

### Monorepo and verification

- JavaScript 패키지는 pnpm workspace의 `packages/{core,audio,ui,protocol}`과 `apps/{web,mobile}`로 구성한다. Python 서버는 `apps/server`의 독립 uv 프로젝트다.
- 서버 Pydantic schema가 REST 계약의 단일 원본이다. `apps/server/openapi.json`을 내보낸 뒤 `openapi-typescript`로 `packages/protocol/src/openapi.ts`를 생성한다. JSON 필드명은 camelCase다.
- 전체 로컬 게이트는 `corepack pnpm check`, 계약 동기화는 `corepack pnpm protocol:check`, 일반 브라우저 시나리오는 `corepack pnpm test:e2e`, Service Worker 교체 시나리오는 `corepack pnpm test:e2e:pwa`로 검증한다.

### Tempo map, scores, and offline data

- 템포맵 저장 요청은 `{ expectedRevision, data }`, 응답은 revision metadata와 `data`를 포함한다. 서버는 revision을 immutable row로 보관하며 오래된 `expectedRevision`에는 409를 반환한다.
- 동기 룸은 생성 시 템포맵 revision을 고정하고, 모든 참가자는 그 정확한 revision을 내려받아 로컬에서 같은 타임라인을 전개한다.
- `GET /repertoire/{id}/access`의 `role`로 leader/owner 전용 악보 UI를 선제 제한하되, 서버 권한 검사를 대체하지 않는다.
- 마디 앵커 주석은 `GET /repertoire/{id}/annotations`로 곡의 모든 파트에서 조회하고 대상 파트의 `MeasureMap`에 재투영한다. 페이지 좌표 앵커는 생성한 `scoreId`에만 표시한다.
- 공동 주석은 REST 저장을 유일한 mutation 경계로 유지하고 `/ws/repertoires/{id}/annotations`에서 commit 이후 upsert/delete 이벤트만 전송한다. 첫 frame은 `JOIN_ANNOTATIONS`이며 접속·재접속마다 현재 사용자가 볼 수 있는 전체 DB snapshot을 먼저 보내 누락·중복 이벤트를 복구한다. private 주석은 작성자 연결에만 전송하고, 각 이벤트/keepalive에서 멤버십을 다시 확인한다.
- 비로그인 웹 데이터는 기존 local IndexedDB/localStorage store에 남고, 로그인한 공유 데이터만 REST API를 사용한다. IndexedDB schema v3는 원격 템포맵·악보 원본·`MeasureMap`·주석·연습일지를 `userId`별 store에 마지막 성공 응답으로 snapshot한다. network failure일 때만 현재 사용자의 snapshot을 읽기 전용으로 사용하며, 이 규칙은 Editor의 원격 템포맵에도 동일하게 적용되어 편집·가져오기·저장을 잠근다.
- 악보 원본은 final key와 분리된 presigned staging key에 인증 헤더 없이 업로드한다. complete는 잠근 pending `Score`를 기준으로 staging을 final로 멱등 promote한 뒤 `ready`와 staging 삭제 outbox를 한 transaction으로 확정한다. pending은 목록·GET에서 숨기고, 만료 reaper가 client 정리 실패를 회수하며 레파토리 악보 수는 `ready`만 집계한다.
- PDF·이미지 OMR은 revision에 묶인 persistent `OmrDraftJob`으로 Audiveris를 bounded background worker에서 실행한다. worker는 pending job을 원자 claim하고 timeout을 넘긴 orphan만 복구해 rolling startup이 다른 인스턴스의 정상 작업을 되돌리지 않는다. 결과는 정규화된 마디 영역의 best-effort 초안이며 기존 `MeasureMap`을 자동으로 덮어쓰지 않는다. 사용자가 미리보기 후 명시적으로 저장할 때도 시작 시점 revision으로 충돌을 검사한다.
- 악보 좌표는 zoom과 무관한 score page surface 기준 0–1 정규화 값이다. 재생 중 수동 페이지 이동은 auto-follow를 멈추고 명시적인 resume CTA를 제공하며, compact 악보 도구는 고정 하단 overlay다.

### Application UX and install surface

- AppShell의 본문 scroller는 history entry별 위치를 보존해 POP 탐색에서 복원하고, 새 탐색은 맨 위에서 시작한다. 페이지 전환 후 `h1`으로 focus를 이동하며 browser POP은 모바일 더보기 overlay를 닫는다.
- temporary managed-local SSO web build는 첫 진입에 운영 TODO dialog를 열고 topbar 경고 버튼으로 다시 볼 수 있게 한다. 적용 중인 로컬 volume·중앙 계정 관리와 남은 S3 이관·SMTP·backup·association·OMR 작업을 숨기지 않으며 standard profile 전환 때 build flag와 dialog를 함께 제거한다.
- 대규모 workspace는 root `/groups`를 권위 요청으로 두고 members·projects·repertoire leaf 요청을 최대 6개로 제한한다. leaf 일부가 실패해도 성공한 그룹·곡은 계속 노출하고 누락 영역과 재시도를 별도로 표시한다.
- 세션의 ready/start/stop은 서버 roster/transport acknowledgment 또는 5초 timeout 전까지 pending으로 잠가 중복 전송을 막는다. Clipboard API가 없거나 거부되면 선택 가능한 read-only 초대 URL과 재시도를 제공한다.
- 악보 파트 선택은 `tablist`/`tab`/`tabpanel`과 roving tab index·화살표/Home/End를 사용하고, Editor의 표 모드는 native `table`/column header/row header를 사용한다. 악보 표면의 필기·매핑은 pointer capture와 현재 `pointerId`만 처리해 stylus 입력에 다른 pointer가 섞이지 않게 한다.
- PWA manifest는 고정 `id`·scope·start URL, `ko-KR`, category, 별도의 `any`/`maskable` PNG와 180px Apple touch icon을 제공한다. 다크/라이트 변경은 `data-theme`, `theme-color`, Capacitor SystemBars를 함께 동기화하되 native 실패는 웹 UI를 차단하지 않는다.

### Realtime and audio

- WebSocket 주소는 `/ws/rooms/{roomId}`이며 첫 frame은 반드시 access token을 담은 `JOIN_ROOM`이다. 이후 `PING`/`PONG`, `REPORT_RTT`, `READY`, `CMD_START`, `CMD_STOP`, `CMD_SEEK` envelope를 사용한다.
- production room metadata·presence·분산 lock은 필수 `FMR_REDIS_URL`의 공유 Redis에 저장한다. 인스턴스별 WebSocket은 Redis pub/sub으로 transport/roster/replacement를 fan-out하며 participant presence는 heartbeat TTL로 정리한다. transport 상태는 PostgreSQL `PracticeSession`과 Redis state를 분산 lock 안에서 갱신하고 PING마다 권위 상태를 다시 전송해 pub/sub 유실을 복구한다.
- 서버 wire time은 `time.time_ns()` 기반 integer nanoseconds다. 브라우저 경계에서 milliseconds로 변환하고, min-RTT offset과 완만한 drift 보정을 거쳐 server → performance → audio clock 순서로 매핑한다.
- 브라우저 클릭은 미리 만든 `AudioBuffer`와 Worker lookahead scheduler로 예약한다. Capacitor는 같은 `AudioEngine` 계약 뒤에서 전체 결정론적 클릭 타임라인을 native batch로 넘기고 iOS `AVAudioEngine`, Android Oboe low-latency stream으로 재생한다. 재생 클릭과 beat 시각화에 `setTimeout`을 사용하지 않으며, 시각화는 audio clock 기반 `requestAnimationFrame`으로 구동한다.
- 네트워크 단절 중에는 이미 시작한 로컬 오디오를 중단하지 않는다. 재접속·늦은 합류는 서버 transport anchor를 받아 다음 마디 경계에서 합류한다.
- WS close `4000`(새 연결로 교체), `4400`(잘못된 요청), `4404`(없는/만료된 방)는 terminal이다. `4401`은 현재 auth generation에서 access token을 한 번만 갱신하고 재거부되면 종료하며, 실제 network close만 backoff 재연결한다.
- 로컬 타임라인이 자연 종료되면 리더 client가 `CMD_STOP`을 보내 서버 transport도 `stopped`로 정리한다. route/auth identity가 바뀌면 기존 예약 오디오를 즉시 중단한다.

### Mobile boundary

- 브라우저 web은 `/feelmyrythm/` 절대 base를 유지한다. Capacitor는 Vite `mobile` 모드의 상대 base와 `apps/mobile/web` 산출물을 iOS/Android에 동기화하고, REST/WS만 `https://bonifacio.work` 원점으로 연결한다.
- 웹은 공용 `nativeBridge`만 호출하며 native audio, Keep Awake, app lifecycle/deep link, haptics 같은 네이티브 세부 구현을 직접 알지 않는다. Android native audio는 `mediaPlayback` foreground service와 MediaStyle stop action을 재생 수명에 맞춰 유지하고, iOS는 `.playback` audio session과 `UIBackgroundModes/audio`를 사용한다.
- 브라우저 인증은 token+user를 단일 `fmr.auth.session.v1` envelope로 원자 저장하며, refresh 결과는 시작 auth generation이 현재와 같을 때만 반영한다. refresh endpoint의 권위 있는 401만 세션을 폐기하고 network/5xx는 현재 identity와 token을 보존한 채 재시도 가능한 오류로 전달한다. `hasPassword`가 없는 구형 user envelope는 `/users/me`로 갱신한다. native refresh token은 iOS Keychain `ThisDeviceOnly` 또는 Android Keystore로 보호하고 WebView backup·평문 저장소에 남기지 않는다.
- password 가입의 첫 단계는 이름+이메일만 받고 password를 저장하지 않는다. 발급·재발급 때마다 이전 링크를 무효화하는 만료 전용 서명 토큰을 연 사용자가 새 password+확인을 제출해야만 이메일 검증, password hash 생성, access/refresh 발급을 원자적으로 완료한다. 검증 전 login과 그룹 초대를 차단하며 legacy 미검증 hash도 완료 시 반드시 덮어쓴다.
- `managed_local_sso`에서는 public email enrollment를 열지 않는다. `scripts/bootstrap_single_user.py`는 migration 전 legacy owner를 한 번 seed/reset하는 도구일 뿐이며, SSO subject가 연결된 뒤에는 password를 다시 만들지 못한다. 새 사용자는 중앙 관리자에서 생성하고 첫 trusted exchange에서 앱 row를 provision한다.
- `bonifacio.work`의 browser production은 `FMR_SSO_ENABLED=true`, 32자 이상의 앱 전용 edge secret, edge `auth_request`를 함께 사용한다. 운영 secret은 rootless host의 `cks:cks` small regular mode-0640 file을 read-only mount하고 `FMR_SSO_EDGE_SECRET_FILE`로 읽는 계약이 우선이다. Compose는 process UID 10001을 유지하고 GID만 0으로 두며, 서버는 container에서 secret이 `root:root` mode 0640이고 effective GID가 0인지 검사한다. `FMR_SSO_EDGE_SECRET`은 개발/격리 테스트 fallback이다. `/api/auth/sso`는 proxy가 덮어쓴 non-empty `Remote-User`를 immutable unique nullable `User.sso_subject`로 먼저 찾고, 미연결 기존 계정은 unique email이 정확히 일치할 때 한 번만 연결하며, `managed_local_sso`에서 둘 다 없으면 verified active 앱 사용자를 만든다. subject/email이 서로 다른 row를 가리키면 409로 닫는다. 모든 bearer HTTP API와 refresh/logout, access token을 첫 frame으로 받는 모든 WebSocket은 edge가 덮어쓴 `Remote-User`가 token 사용자의 `sso_subject`와 정확히 같고 `X-Portfolio-Edge-Secret`이 설정값과 일치해야 한다. health와 명시적 public HTTP 경로만 예외다. SSO 모드에서는 local register/login/Google/email recovery/account deletion을 모두 닫고, web logout은 앱 refresh session을 폐기한 뒤 중앙 `/sso/logout`으로 이동한다. 내부 nginx는 identity와 edge-secret header를 API와 WebSocket upstream 모두에 명시 전달하고 origin port는 loopback에만 둔다.
- 비밀번호 재설정 요청은 계정 존재를 숨기고 per-email cooldown을 적용한다. 만료·1회용 reset token으로 password를 바꾸면 auth generation을 증가시키고 기존 refresh session을 전부 폐기한다. 가입·재발급·reset·탈퇴 메일은 SMTP enqueue 전에 last-attempt를 commit해 전송 실패·queue overflow도 cooldown을 유지한다. SMTP I/O는 고정 worker 수와 bounded queue를 가진 비동기 delivery manager만 수행해 요청 응답을 기다리게 하지 않으며, queue full/provider 오류 로그에는 이메일·서명 URL을 남기지 않는다.
- password login은 계정 없음·비활성·미검증·Google-only 경로에도 고정 dummy bcrypt를 수행해 계정별 시간 차를 줄이고, 프로세스 전역 bounded bcrypt verifier로 CPU 동시성을 제한한다. 앱은 임의 `X-Forwarded-For`를 신뢰하지 않으므로 client IP/CAPTCHA/provider quota 같은 외부 abuse 제한은 trusted CDN/nginx/provider 경계에서 시행한다.
- 검증된 Google 이메일이 미검증 password 선점 계정과 일치하면 같은 사용자에 Google subject를 연결하고 password/refresh session을 제거하며 auth generation을 증가시킨다. 다른 Google subject 또는 별도 기존 계정과 충돌하면 409를 반환한다.
- Capacitor native WebView에서는 웹 Google GIS button/SDK를 노출하지 않고 이메일 가입·로그인만 제공한다. 브라우저에서는 Google 로그인을 유지한다.
- `DELETE /api/users/me`는 `{ email, currentPassword? | googleIdToken? | accountDeleteToken? }` 중 계정 유형에 맞는 fresh proof 하나를 요구한다. Google-only 탈퇴 확인 메일 token은 purpose/email/Google subject/auth generation에 묶고 URL fragment에서 즉시 제거해 메모리에만 보관한다. 로그아웃 또는 다른 계정 상태에서는 secret 없는 login route state로 올바른 계정 전환을 안내하고, id+정규화 email이 일치한 뒤에만 메모리 proof로 삭제 modal을 재개한다. 성공·취소·대체 재인증 때 proof를 폐기한다. 성공 시 소유 그룹을 삭제하고 다른 그룹의 membership·개인 annotation/log·calibration/session credential을 제거하며 Todo assignee를 비운 뒤 동일 User id를 `Deleted user` tombstone으로 익명화한다.
- 로컬·동기 재생은 같은 power lifecycle을 사용한다. 자연 종료, 명시적 stop, unmount 중 먼저 도착한 경계가 Browser WakeLock과 native KeepAwake를 정확히 한 번 해제한다.
- AASA와 `assetlinks.json`은 release Team ID와 실제 Android keystore alias SHA-256으로 generator에서 만들며, Android bundle 전 fingerprint 일치를 검증한다. 운영 게시물은 production preflight가 app identity와 session/login/settings의 좁은 경로 범위를 확인한다.
- 무음 스위치, 백그라운드/화면 꺼짐 오디오, 기기 간 ±10 ms 기준은 시뮬레이터가 아니라 실제 iOS/Android 기기와 녹음 파형으로 최종 검증한다.

### Deployment gate

- 운영 publish/deploy는 `Validate` workflow가 성공한 정확한 commit SHA에 대해서만 시작한다. publish job은 `packages:write`, RPi deploy job은 `packages:read` 최소 권한으로 분리한다.
- Validate에는 JS/Python 전체 check, protocol 생성 일치, 일반 Playwright와 전용 PWA upgrade E2E, PostgreSQL Alembic smoke가 포함되어야 한다.
- Alembic 도입 전 운영 DB는 `b881b6589baa`가 알려진 legacy table signature를 확인한 뒤 같은 PostgreSQL transaction에서 기존 table을 격리 schema로 이동하고 새 schema로 row를 변환한다. 알 수 없는 unversioned schema는 추측해 stamp하거나 덮어쓰지 않고 배포를 거부하며, CI는 실제 legacy row 보존 upgrade를 별도 PostgreSQL DB에서 검증한다.
- 운영 승인 전 `production:preflight`로 PostgreSQL Alembic head, Redis, SMTP TLS/auth, S3 CORS/staging lifecycle, public health와 mobile association identity를 fail-closed 검증한다. S3 canary와 test mail은 명시적 opt-in에서만 외부 상태를 바꾼다.
- 임시 `managed_local_sso` preflight는 SMTP를 명시적으로 skipped로 기록하고 S3 대신 runtime UID가 persistent local upload root에 접근 가능한지 검사한다. 이것은 standard provider 승인이나 local file backup·S3 이관 완료를 의미하지 않는다.
- 제한 배포기의 첫 target preflight만 `--allow-database-behind`를 사용한다. 이 모드는 비어 있거나 unversioned인 DB, unknown/divergent revision, multi-head mismatch를 거부하고 단일 current revision이 단일 target head의 정확한 조상일 때만 pending migration을 허용한다. canary가 migration phase에 진입한 뒤 수행하는 모든 preflight는 이 flag 없이 strict head 일치를 요구한다. 제한 배포기의 `--skip-association`은 web/API infrastructure bring-up만 승인하며 mobile release 승인이 아니다. mobile release 전에는 실제 signing identity의 association JSON을 공개하고 별도 non-skip preflight를 통과한다.
- server/web Dockerfile의 Python·Node·nginx·uv base와 CI/deploy PostgreSQL은 version tag와 image digest를 함께 고정한다. 운영 server는 read-only root filesystem과 `/tmp` 전용 tmpfs로 실행한다. ARM64 runtime image를 registry에 push하기 전 그 정확한 tag를 같은 read-only 경계로 실행해 server default CMD의 Alembic migration·health·non-root 상태와 nginx SPA·header·API proxy `no-store`를 통합 smoke한다.
