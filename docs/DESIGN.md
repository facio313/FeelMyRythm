# FeelMyRythm 설계문서

앙상블 연습을 위한 **동기화 메트로놈 + 악보/연습 관리** 애플리케이션.

- 작성일: 2026-08-04
- 상태: 초안 v1.1 (서버 스택을 Python으로 변경)
- 함께 볼 문서: [구현 로드맵](./IMPLEMENTATION_PLAN.md) · [UI 디자인 시스템](./UI_DESIGN.md)

---

## 1. 개요와 목표

### 1.1 한 줄 정의

곡의 템포 구조(박자·BPM 변화·반복)를 "템포맵"으로 정의하고, 앙상블 멤버 전원이 **같은 시각에 같은 박**을 듣고 보게 하는 메트로놈.

### 1.2 기능 우선순위

| 순위 | 기능 | 비고 |
|---|---|---|
| **P0** | 2. 박자 세기 상세 (템포맵: 구간·박자 변화·반복) | 핵심 도메인 |
| **P0** | 3. 박자 공유 (그룹/프로젝트, 실시간 동기 시작, 예비박) | 핵심 차별점 |
| P1 | 1. 메트로놈 기본 (박자 소리, 튜너) | 튜너는 독립 모듈 |
| P1 | 6. 박자 시각화 (공학심리학 기반) | P0와 함께 개발 |
| P2 | 4. 악보 저장 (마디 인식, 총보/파트보 이동, 필기) | |
| P2 | 5. 연습일지 (메모, 지시사항, 할일) | |

### 1.3 설계 전체를 관통하는 원칙

1. **결정론(Determinism)**: 같은 템포맵 + 같은 시작 시각이 주어지면 모든 기기에서 모든 박의 절대 시각이 동일하게 계산된다. 실시간 동기화는 "박 신호를 스트리밍"하는 것이 아니라 **"시계를 맞추고 시작 시각만 합의"** 하는 방식으로 구현한다. (네트워크 지터에 면역)
2. **코어 로직의 순수성**: 템포맵 해석·타임라인 전개·시계 동기화 수학은 DOM/플랫폼 의존성이 없는 순수 TypeScript 패키지로 분리한다. → 테스트 용이, 웹/모바일/서버 재사용.
3. **오디오 우선, 시각은 오디오 시계에 종속**: 화면 갱신은 오디오 클럭을 읽어 렌더링한다. `setTimeout` 기반 시각화 금지.
4. **플랫폼 어댑터 패턴**: 소리 출력·햅틱·파일 접근 등 플랫폼 의존 기능은 인터페이스 뒤에 숨긴다. 웹 구현이 기본, 모바일에서 문제가 생기는 지점만 네이티브 플러그인으로 교체.

---

## 2. 기술 스택 결정

### 2.1 결론 (추천)

| 영역 | 선택 | 
|---|---|
| 언어 | 클라이언트: TypeScript / 서버: **Python 3.13+** |
| 코어/오디오 | 순수 TS 타임라인·시계동기 + 웹 Web Audio / 모바일 AVAudioEngine·Oboe 어댑터 |
| 웹 프론트 | **React 19 (최신) + Vite**, PWA |
| UI 스타일 | Tailwind CSS 4 + Radix UI 프리미티브 — 상세는 [UI 디자인 시스템](./UI_DESIGN.md) |
| 모바일 포팅 | **Capacitor** (웹 빌드를 그대로 래핑 + 네이티브 플러그인) |
| 서버 | **Python + FastAPI** (uvicorn/uvloop) — REST + WebSocket 단일 앱. Flask 대비 근거는 §2.3 |
| ORM/마이그레이션 | SQLAlchemy 2 + Alembic |
| DB | **PostgreSQL** (+ Redis: 실시간 세션 상태, 멀티 인스턴스 시) |
| 파일 저장 | `ObjectStorage` adapter: 현재 single-server external local volume, 확장 시 선택적 S3 호환 스토리지 |
| 모노레포 | pnpm workspaces (JS 측) + uv (Python 서버) |
| 테스트 | Vitest (코어 단위 테스트), pytest (서버), Playwright (E2E) |

### 2.2 왜 Capacitor인가 (대안 비교)

| 기준 | 웹+Capacitor ✅ | React Native | Flutter | PWA만 |
|---|---|---|---|---|
| 웹 개발자 역량 재사용 | 100% | 부분 (RN 학습 필요) | 낮음 (Dart) | 100% |
| 코드 공유율 (웹↔앱) | UI까지 거의 전부 | 로직만, UI 재작업 | 웹은 canvas 렌더로 별도 세계 | 전부 |
| 오디오 정밀 타이밍 | Web Audio + 네이티브 플러그인 구현 | 네이티브 모듈 필수 | 플러그인 필수 | Web Audio |
| iOS 백그라운드/오디오 세션 제어 | 플러그인으로 가능 | 가능 | 가능 | **불가/제한** (탈락 사유) |
| 스토어 배포 | O | O | O | X (iOS 설치 UX 열악) |

- **PWA만으로는 부족한 이유**: iOS Safari는 화면 잠금/백그라운드에서 오디오·타이머를 강하게 제한한다. 연습 중 화면이 꺼지면 메트로놈이 멈추는 것은 치명적. → 네이티브 셸 필요.
- **React Native가 아닌 이유**: 이 앱의 성능 민감 지점은 UI가 아니라 **오디오 스케줄링**이다. RN을 써도 오디오는 결국 네이티브 모듈을 짜야 하므로, UI까지 재작업하는 RN보다 웹 UI를 그대로 쓰고 오디오만 필요시 플러그인화하는 Capacitor가 유리하다.
- **알려진 리스크와 대응**: WKWebView 타이머 중단을 오디오 경로에서 제거하기 위해 `AudioEngine` 인터페이스 뒤에 AVAudioEngine/Oboe 구현을 둔다(§5.1). 기기별 출력 지연은 §6.5 캘리브레이션으로 흡수하고 실제 파형으로 최종 검증한다. 코어 로직은 플랫폼과 무관하다.
- **native 인증 경계**: Google Identity Services의 웹 button과 browser SSO cookie는 Capacitor WebView의 production identity proof로 간주하지 않는다. 모든 Capacitor build는 Google web button/SDK를 숨기며, local-auth tool/feature build에서만 이메일 가입·로그인·복구를 사용할 수 있다. `main`/`dev` SSO mobile release는 system browser에서 확인한 중앙 session을 일회용 app credential로 교환하는 native callback/bridge를 별도 설계·구현·검증한 뒤 승인한다. 이를 피하려고 production SSO server의 local login을 다시 열지 않는다.

### 2.3 서버 스택 근거 — Python은 적합, 프레임워크는 Flask보다 FastAPI

**Python 백엔드 자체는 이 앱에 잘 맞는다.** 박 계산·오디오 스케줄링 같은 시간 민감 로직은 전부 클라이언트(TS)에서 돌고, 서버는 CRUD와 WS 중계·타임스탬프만 담당하므로 언어 성능이 병목이 아니다.

단, 실시간 동기화(§6)가 **서버가 타임스탬프를 직접 찍는 NTP 유사 프로토콜**을 요구하므로 프레임워크는 가려 쓴다:

| 기준 | FastAPI ✅ | Flask |
|---|---|---|
| WebSocket | ASGI 네이티브 — 표준 기능 | WSGI라 불가 → Flask-SocketIO + eventlet/gevent 몽키패칭 필요 |
| 비동기 모델 | async/await, 최신 Python 문법 그대로 | 동기 기본. async 지원이 제한적 |
| 시계동기 타임스탬프 품질 | 이벤트 루프(uvloop)에서 수신 즉시 기록 → 지터 작고 예측 가능 | eventlet 협력 스케줄링 아래서 지터 예측이 어려움 |
| 타입·검증 | Pydantic 내장 → OpenAPI 자동 생성 → **프론트 TS 타입 자동 생성** | 별도 라이브러리 조합 필요 |

- Flask로 불가능한 것은 아니다(Flask-SocketIO로 구현 사례 많음). 하지만 이 서버의 핵심이 WS 게이트웨이인 이상, WS가 1급 기능인 FastAPI가 구조적으로 맞다. CRUD 작성 경험도 Flask와 거의 동일한 난이도.
- BaaS 실시간 기능(Firebase RTDB, Supabase Realtime)은 지연 제어가 안 되므로 배제 — 자체 WS 게이트웨이 필수라는 결론은 동일.
- 운영 형태: FastAPI 앱이 REST + WS를 함께 서빙한다. production은 공유 Redis에 room metadata·participant presence·분산 lock을 두고 pub/sub으로 각 인스턴스의 로컬 WebSocket에 transport/roster/replacement를 fan-out한다. 서버 시각은 epoch 기준 `time.time_ns()`를 ms로 변환해 사용한다.

---

## 3. 시스템 아키텍처

### 3.1 모노레포 구조

```
feelmyrythm/
├── packages/
│   ├── core/          # 순수 TS. 템포맵 모델, 타임라인 전개, 시계동기 수학. 의존성 0
│   ├── audio/         # AudioEngine 인터페이스 + WebAudioEngine, TunerEngine(피치 검출)
│   ├── ui/            # React 공용 컴포넌트 (비주얼 메트로놈, 템포맵 에디터, 악보 뷰어)
│   └── protocol/      # 생성된 TS 타입 (원천은 서버 Pydantic 모델 → OpenAPI/JSON Schema)
├── apps/
│   ├── web/           # React 19 + Vite. PWA
│   ├── mobile/        # Capacitor 셸 (web 빌드 래핑) + 네이티브 플러그인
│   └── server/        # Python + FastAPI (uv 관리). REST API + WS 동기화 게이트웨이
└── docs/
```

### 3.2 컴포넌트 다이어그램

```mermaid
graph TB
    subgraph Client["클라이언트 (웹 / Capacitor 앱)"]
        UI["UI 레이어<br/>비주얼 메트로놈 · 에디터 · 악보뷰어"]
        CORE["core<br/>TempoMap → PerformanceTimeline<br/>ClockSync 추정기"]
        AE["AudioEngine<br/>Web Audio lookahead / AVAudioEngine / Oboe"]
        TUNER["TunerEngine<br/>(마이크 → 피치 검출)"]
        UI --> CORE
        CORE --> AE
        UI --> TUNER
    end
    subgraph Server["서버 (Python · FastAPI)"]
        REST["REST API<br/>인증 · 그룹 · 곡 · 템포맵 · 악보 · 일지"]
        WS["WS Gateway<br/>시계동기(PING/PONG) · 트랜스포트(START/STOP/SEEK)"]
        DB[("PostgreSQL")]
        S3[("객체 스토리지<br/>external local volume / 선택적 S3")]
        REST --> DB
        REST --> S3
        WS --> DB
    end
    Client -- HTTPS --> REST
    Client -- WebSocket --> WS
```

### 3.3 데이터 흐름 (앙상블 동기 재생)

1. 리더가 곡을 선택하고 연습 세션(방)을 연다. 멤버들이 방에 입장.
2. 모든 클라이언트가 WS로 시계 동기(§6.2)를 수행해 서버 시계와의 오프셋을 추정.
3. 모든 클라이언트가 같은 revision의 템포맵을 내려받아 **동일한 PerformanceTimeline을 로컬에서 전개**.
4. 각 참가자는 `준비` 클릭의 사용자 제스처에서 오디오 엔진을 준비하고 READY를 보낸다. 이 단계는 클릭 예약·시각화·Keep Awake를 시작하지 않는다.
5. 리더가 "26마디부터 시작" 누름 → 리더의 오디오 준비를 기다린 뒤 CMD_START를 보내고 서버가 `TRANSPORT{measure:26, serverStartTime: now+3s}` 브로드캐스트.
6. 준비된 클라이언트는 serverStartTime을 자기 오디오 클럭 시각으로 변환하고 예비박부터 스케줄한다. 진행 중인 방에 오디오 준비 없이 들어온 사용자는 `소리 켜고 합류` 클릭 뒤 다음 마디 경계에 합류한다.
7. 이후 네트워크가 끊겨도 재생은 로컬에서 결정론적으로 지속된다.

### 3.4 인증·계정 보안 흐름

- `bonifacio.work` browser production의 SSO mode는 edge가 덮어쓴 `Remote-User`를 nullable unique `User.sso_subject`에 한 번 연결하고 이후 변경을 금지한다. 교환은 subject를 먼저 찾고, 아직 subject가 없는 unique email row만 legacy owner로 한 번 연결한다. 둘 다 없으면 storage profile과 무관하게 verified active 앱 사용자를 만들며 subject와 email이 서로 다른 row를 가리키는 모든 경우는 409로 닫는다. 웹 bootstrap은 저장된 atomic app session을 먼저 `/users/me`와 필요 시 refresh로 현재 edge subject 아래 검증하고, 최종 401일 때만 SSO exchange한다. network/5xx/conflict에서는 app child를 노출하지 않고 재시도 상태에 머문다. edge는 client 입력을 덮어쓴 앱 전용 `X-Portfolio-Edge-Secret`과 v2 `Remote-Groups`를 주입한다. 서버는 SSO exchange뿐 아니라 모든 bearer HTTP API와 refresh/logout, room·annotation WebSocket의 first-frame token 인증에서 secret, token 사용자의 subject, ordered `user < admin < chief-admin` 역할과 `access-feelmyrythm` entitlement를 함께 확인한다. chief는 별도 grant 없이 전역 접근하고, 정확한 v1 세 문자열만 전환 호환하며 역할과 entitlement는 매 요청 다시 계산한다.
- 이메일 가입 첫 요청은 이름과 이메일만 저장하고 password hash나 세션을 만들지 않는다. 메일 링크의 `verificationToken`은 purpose·email·`auth_generation`·만료에 묶이며, 재발급 전에 generation을 올려 이전 링크를 무효화한다. 링크 소유자가 별도 화면에서 새 password와 확인값을 제출한 때에만 legacy 미검증 hash를 덮어쓰고 검증 시각·새 generation·세션 발급을 한 transaction 흐름으로 완료한다.
- 비밀번호 재설정 요청은 등록 여부와 무관하게 같은 202 응답을 보낸다. reset token은 purpose·email·generation·만료에 묶고, 성공 시 generation 증가와 모든 refresh session 삭제로 한 번만 쓸 수 있게 한다. 브라우저/앱은 verification/reset token을 URL fragment에서 즉시 지우고 메모리에만 두며, 새로고침 뒤에는 메일 링크를 다시 열도록 안내한다.
- local-auth profile에서 가입·재발급·reset·Google-only 탈퇴 확인 메일을 제공할 때는 SMTP enqueue **전에** 사용자별 last-attempt를 commit한다. provider timeout과 bounded queue overflow도 `Retry-After` cooldown을 유지한다. SMTP I/O는 고정 worker 수·bounded queue의 비동기 delivery manager로 요청 밖에서 수행하고, queue full/provider 오류 로그에는 recipient나 서명 URL을 남기지 않는다. shutdown은 제한 시간까지 drain한 뒤 아직 시작하지 않은 job을 취소한다. 이 profile은 SMTP와 absolute HTTPS URL이 유효하지 않으면 시작하지 않는다. SSO mode는 이 앱의 public email workflow와 SMTP sender를 닫고 중앙 identity provider에 account mail을 위임한다.
- password login은 계정 없음·비활성·미검증·Google-only에도 고정 dummy bcrypt를 실행하고, bounded 전역 verifier로 동시 bcrypt CPU 작업을 제한한다. client IP/CAPTCHA/provider quota 제한은 trusted CDN/nginx/provider에서 수행하며 앱은 임의 `X-Forwarded-For`를 신뢰하지 않는다.
- 검증된 Google 이메일이 미검증 선점 row와 같으면 그 row에 subject를 연결하고 legacy password·refresh session을 제거하며 generation을 올린다. 이미 다른 Google subject나 별도 계정에 연결된 충돌은 409다.
- password 계정 탈퇴는 현재 password를 다시 검증한다. Google-only 계정은 브라우저에서 audience·verified email·subject를 다시 검증한 Google ID token을 쓰거나, native에서도 열 수 있는 purpose=`account_delete` 만료 메일 token을 쓴다. 후자는 email·Google subject·generation에 묶고 fragment에서 즉시 제거해 메모리에만 보관한다.

### 3.5 웹 런타임·화면 상태 경계

- 웹 bootstrap은 React App을 import·mount하기 전 Cache Storage의 구형 `fmr-api`를 fail-closed로 purge한다. 그런 다음 `sw.js?fmr-safety=v1`을 `updateViaCache: none`으로 등록해 제어권 이관과 구형 same-scope worker의 `redundant`를 확인하고, 전환 중 마지막 legacy fetch가 캐시를 다시 만든 경우까지 마지막 purge로 제거한다. 캐시 상태·삭제·제어권을 증명하지 못하면 보안 시작 화면에 머물고 재시도만 허용한다.
- Workbox는 `/feelmyrythm/api/*`를 navigation fallback과 runtime cache에서 제외하고, nginx API proxy는 `Cache-Control: no-store`를 항상 부여한다. 오프라인 데이터는 Service Worker 응답 캐시가 아니라 계정별 IndexedDB snapshot만 사용한다.
- AppShell은 단일 본문 scroller의 좌표를 history entry key별로 보존해 POP에서만 복원하고 새 탐색은 맨 위에서 시작한다. 탐색 후 새 `h1`에 focus하며 browser POP은 모바일 더보기 overlay를 닫는다.
- 폭 839px 이하 AppShell은 topbar를 제거하고 Bonifacio 복귀·테마·설정·계정/로그인·managed SSO 운영 안내를 하단 `더보기`에 모은다. 840px 이상은 topbar를 유지한다. 모바일 본문은 상단 safe area를 보존하며 하단 내비게이션은 별도 grid row를 사용한다. Bonifacio 복귀 링크는 Capacitor에서는 숨긴다.
- 세션의 `악보 보기`는 route를 바꾸지 않고 같은 재생 controller 아래 악보를 표시한다. 악보는 방에 고정된 TempoMap과 position·frame source를 받아 현재 마디를 추적하며 별도 오디오 엔진을 만들지 않는다. 파트 전환과 악보 탐색은 세션 transport를 변경하지 않는다.
- workspace의 `/groups`는 전체 shape을 결정하는 권위 root 요청이다. 그 후 members·projects·repertoire leaf는 최대 6개만 동시 실행하고 `allSettled`로 건강한 그룹·곡을 유지하며, 실패한 영역은 위치와 재시도를 별도로 노출한다.
- PWA manifest는 `/feelmyrythm/` `id`·scope·start URL, `ko-KR`·category·standalone metadata, 별도의 `any`/`maskable` PNG와 180px Apple touch icon을 제공한다. theme 변경은 페이지 `data-theme`과 `theme-color`, Capacitor SystemBars를 함께 갱신하며 storage·native 실패는 웹 UI를 중단하지 않는다.

---

## 4. 핵심 도메인 모델: 템포맵 (기능 2)

### 4.1 개념

곡 전체의 시간 구조를 마디 단위로 기술한 것. "몇 마디부터 몇 마디까지 어떤 박자·어떤 템포이고, 어디서 반복하는가"의 선언적 데이터.

### 4.2 타입 정의 (packages/core)

```ts
/** 곡 하나의 템포 구조 전체 */
interface TempoMap {
  id: string;
  repertoireItemId: string;
  revision: number;            // 동기화 시 전원 동일 revision 보장용
  totalMeasures: number;
  anacrusis?: Anacrusis;       // 못갖춘마디 (박 수)
  sections: TempoSection[];    // startMeasure 오름차순, 구간은 서로 겹치지 않음
  jumps: JumpDirective[];      // 반복 구조
  countIn: CountInPolicy;      // 예비박 정책
}

/** 균질한 구간: 이 안에서는 박자·템포가 일정 (또는 선형 변화) */
interface TempoSection {
  id: string;
  label?: string;              // "Intro", "A", "Coda" 등
  startMeasure: number;        // 1-base, 포함
  endMeasure: number;          // 포함
  timeSignature: { num: number; denom: number };   // 4/4, 6/8 ...
  bpm: number;
  beatUnit: NoteValue;         // 무엇을 1박으로 셀지: quarter, dottedQuarter(6/8용) ...
  tempoChange?: { type: 'rit' | 'accel'; targetBpm: number }; // 구간 내 선형 변화(후순위)
  accentPattern?: number[];    // 박별 강세 0~2 (기본: 첫박 강)
  subdivision?: 1 | 2 | 3 | 4; // 분할 클릭 (8분·셋잇단 등)
}

/** 반복·도돌이 구조 — 악보의 진행 지시를 데이터로 표현 */
type JumpDirective =
  | { type: 'repeat';  startMeasure: number; endMeasure: number; times: number;
      endings?: { measures: [number, number]; forPass: number[] }[] }  // 1st/2nd 엔딩(볼타)
  | { type: 'dc'; atMeasure: number; alFine?: number; alCoda?: boolean }   // 다카포
  | { type: 'ds'; atMeasure: number; segnoMeasure: number; alFine?: number; alCoda?: boolean }
  | { type: 'coda'; toCodaMeasure: number; codaMeasure: number };

interface CountInPolicy {
  measures: 1 | 2;             // 예비박 마디 수
  useSectionMeter: true;       // 시작 지점 구간의 박자·템포를 따름
}
```

메트로놈의 박자표 설정을 바꿀 때는 새 박수에 맞는 `accentPattern`을 함께 반영한다. 기존 강세는 앞 박부터 보존하고, 초과한 박은 제거하며 새로 늘어난 박은 보통 강세(`1`)로 채운다.

### 4.3 PerformanceTimeline: 전개(컴파일) 결과

반복 구조가 있는 템포맵은 그대로 재생할 수 없으므로, **연주 순서대로 펼친 선형 타임라인**으로 컴파일한다. 이것이 재생·동기화·악보 하이라이트의 단일 기준이다.

```ts
interface PerformanceTimeline {
  tempoMapRevision: number;
  entries: TimelineMeasure[];  // 연주 순서. 반복되는 마디는 여러 번 등장
  totalDurationSec: number;
}

interface TimelineMeasure {
  measureNumber: number;       // 악보상 마디 번호
  pass: number;                // 몇 번째로 지나가는가 (1st/2nd 엔딩 구분)
  sectionId: string;
  startTimeSec: number;        // 타임라인 시작(t=0) 기준 절대 오프셋
  beats: { timeSec: number; accent: 0 | 1 | 2; isSubdivision: boolean }[];
}
```

**핵심 함수 (모두 순수 함수 → 단위 테스트 대상)**

```ts
expandTimeline(map: TempoMap): PerformanceTimeline
locate(tl: PerformanceTimeline, elapsedSec: number): { entryIndex; beatIndex }  // 이진 탐색
seekPoint(tl: PerformanceTimeline, measure: number, pass?: number): number      // 시작 오프셋(초)
buildCountIn(map: TempoMap, from: seekPoint): Beat[]                            // 예비박 생성
```

사용자 예시 검증: "4/4 ♩=100으로 시작, 26마디에서 ♩=130으로 변경, 반복·2번 엔딩" →
`sections: [{1–25, 4/4, 100}, {26–…, 4/4, 130}]` + `jumps: [{repeat, …, endings: […]}]` 로 표현 가능.

### 4.4 편집기 UX 요건 (요약)

- 템포맵의 값이 없는 optional 필드는 canonical JSON에서 생략한다. 서버는 입력의 생략/`null`을 받아도 저장 응답·최신본·revision 목록·특정 revision·MusicXML 초안에 `null`을 되살리지 않으며, 유효한 `false`·`0`·빈 문자열은 보존한다.
- 구간 리스트 편집(표 형태) + 마디 눈금 타임라인 뷰(구간을 색 블록으로 시각화) 병행.
- 표 모드는 스크린 리더에 행·열 관계를 유지하는 native `table`, column header, row header를 사용한다.
- 탭 템포(화면 두드려 BPM 측정), 구간 분할("이 마디에서 나누기"), 검증(구간 빈틈/겹침, 반복 무한루프 검출은 `expandTimeline`이 담당).
- 원격 Editor는 access role을 먼저 확인하고 member의 기존 맵은 읽기 전용으로 연다. 최신 맵 404와 빈 revision 목록이 함께 확인된 새 곡에서만 owner/leader에게 첫 revision 0 초안을 제공한다.
- 로컬 편집은 `/editor/:mapId?source=local`로 원격 repertoire와 구분한다. 로그인 중에도 같은 IndexedDB 맵을 유지하고 JSON 가져오기는 현재 맵의 식별자·revision을 보존한다. 저장 후 `메트로놈에서 열기`는 정확한 로컬 map ID 또는 원격 repertoire를 전달하며, 악보의 `score` 문맥은 돌아가기 경로로 보존한다.
- 로그인한 사용자의 원격 템포맵은 network failure에서만 현재 `userId`의 schema v3 snapshot으로 연다. 이때 Editor 전체를 읽기 전용으로 잠궈 편집·가져오기·저장을 막고, 연결 재확인과 JSON 내보내기만 제공한다.

---

## 5. 오디오·타이밍 엔진

### 5.1 AudioEngine 인터페이스 (플랫폼 어댑터)

```ts
interface AudioEngine {
  readonly schedulingStrategy?: 'lookahead' | 'entireTimeline';
  /** 절대 시각(오디오 클럭 기준)에 클릭음 예약 */
  scheduleClick(atAudioTime: number, kind: 'downbeat' | 'beat' | 'sub' | 'countIn'): void;
  now(): number;                    // 오디오 클럭 현재 시각 (초)
  outputLatencySec(): number;       // 추정 출력 지연
  start(): Promise<void>; stop(): void;
}
```

- 브라우저 구현: `WebAudioEngine`. Worker는 120ms lookahead 안의 `AudioBuffer`만 예약한다.
- Capacitor 구현: `NativeAudioEngine`. 전체 타임라인을 한 native batch로 넘겨 WebView가 suspend되어도 iOS `AVAudioEngine` 또는 Android Oboe callback이 절대 monotonic 시각에 클릭을 재생한다.
- `cancelScheduledFrom()`은 다음 마디 revision 전환과 stop에서 경계 이후 native queue를 제거한다. Android는 `mediaPlayback` foreground service, audio focus, MediaStyle stop action, 자연 종료 deadline을 함께 관리한다.

### 5.2 룩어헤드 스케줄러 (Two Clocks 패턴)

JS 타이머(`setTimeout`)는 수십 ms 지터가 있으므로 소리 발생 자체에 쓰지 않는다.

```
[Web Worker 타이머, 25ms 주기]
  └─ tick(): 지금부터 120ms 안에 도래할 박을 타임라인에서 찾아
             audioCtx 절대시각으로 AudioBufferSourceNode.start(t) 예약
             → 예약된 박을 beatQueue에 push (예약된 박 metadata 추적)

[메인 스레드 rAF 루프]
  └─ audioTime = engine.now() 를 읽어 transport anchor 기준 타임라인 시각 계산
     → locate()와 결정론적 박 경계로 현재 위치·progress 렌더
     → 예비박의 progress는 재생 전에 만든 예비박 계획의 경계로 계산
```

- 표시 progress는 120ms 선예약 큐에 다음 박이 들어오는 시점에 의존하지 않는다. 오디오 클럭과 전개된 타임라인 또는 예비박 계획으로 박 구간 전체의 진행률을 계산하며 오디오 예약 시각과 WS 동기화 계약은 유지한다.
- 타이머를 **Web Worker**에서 돌리는 이유: 백그라운드 탭에서 메인 스레드 타이머가 1s+로 스로틀되는 것을 회피.
- 클릭음은 실시간 합성(oscillator) 대신 **미리 디코드한 짧은 샘플 버퍼** 사용 (다운비트/일반박/분할박/예비박 4종, 음높이·음색 구분).
- 템포·구간 변경이 재생 중 일어나면: 다음 마디 경계에서 새 타임라인으로 전환 (경계 정렬 재계산).

### 5.3 예비박 (Count-in)

- `seekPoint` 시각 앞에 시작 구간의 박자·템포로 1–2마디의 예비박을 삽입.
- 소리: 본 박과 구별되는 음색(높은 우드블록 등). 시각: 일반 박 원을 생략한 단독 카운트다운 숫자, 기본 bar 사용처의 진행 track(§9). 기존 beats variant의 숫자는 canvas 높이에 맞춰 24–160px로 제한하고 reduced motion에서도 고정 track은 유지한다. 모바일의 큰 박 숫자는 실제 glyph로 계산한 fit 글자 크기의 80%를 쓰며 panel 크기·배치를 유지하고 모바일 일반 화면의 진행은 메뉴를 제외한 앱 영역의 가장 낮은 배경 레이어에서 좌→우 채움으로 표시한다.
- 예약 대기와 예비박의 화면 문맥은 최종 anchor의 마디·pass·구간·박 수를 유지한다. optional `isWaiting`은 첫 오디오 전의 대기를 나타내며 이때 박 강조·접근성 announcement·반응 배경을 억제한다. 표시 상태는 오디오 예약 시각에 영향을 주지 않는다.
- 동기 세션에서는 `serverStartTime`이 **예비박의 첫 박** 시각이 되도록 정의한다 (전원 같은 예비박을 들음).

---

## 6. 실시간 동기화 프로토콜 (기능 3)

### 6.1 목표와 접근

- 목표: 같은 방의 모든 기기에서 체감 동시성 (오디오 기준 오차 ±10ms 내, 최악 30ms).
- 접근: **박 스트리밍이 아니라 시계 합의**. 서버는 "무엇을(템포맵 revision), 어디서(마디), 언제(서버시각)" 만 브로드캐스트하고, 소리·화면은 전부 로컬에서 결정론적으로 생성. → 시작 후에는 네트워크 품질과 무관.

### 6.2 시계 동기 (NTP 유사, WS 위에서)

```
client                          server
  t0 ── PING {t0} ──────────▶
                               t1 (수신·응답 시각)
  t2 ◀── PONG {t0, t1} ──────
  offset = t1 - (t0 + t2)/2     rtt = t2 - t0
```

- 입장 직후 10회 버스트 → **RTT 최소 표본의 offset 채택** (min-RTT 필터, 비대칭 지연 영향 최소화).
- 이후 10초 주기로 재측정, 지수평활로 드리프트 보정. RTT가 급증한 표본은 폐기.
- 클라이언트 내부 시계 사상: `serverTime ↔ performance.now() ↔ audioCtx.currentTime` 두 단계 매핑을 유지 (audio clock과 monotonic clock의 대응은 주기적으로 샘플링).
- 기대 정밀도: 동일 Wi-Fi에서 offset 오차 1–5ms. **실제 지배 요인은 네트워크가 아니라 §6.5 출력 지연**이다.

### 6.3 세션(방)과 트랜스포트 상태

```ts
// 서버가 방마다 유지하는 단일 진실
interface TransportState {
  roomId: string;
  repertoireId: string; revision: number;
  status: 'idle' | 'armed' | 'playing' | 'stopped';
  anchor?: { measure: number; pass: number };
  serverStartTimeNs?: number; // 예비박 첫 박의 서버 시각 (epoch ns)
}
```

**WS 메시지 (packages/protocol)**

| 방향 | 메시지 | 내용 |
|---|---|---|
| C→S | `JOIN_ROOM` | roomId, 인증 토큰 |
| C↔S | `PING`/`PONG` | 시계 동기 (§6.2) |
| C→S | `CMD_START` | anchor(마디), 리더/권한자만 |
| C→S | `CMD_STOP`, `CMD_SEEK` | |
| S→C | `TRANSPORT` | TransportState 전체 (모든 변경 시 + 입장 시) |
| S→C | `TEMPOMAP_UPDATED` | 예약된 revision 알림. 현재 서버는 활성 방의 고정 revision을 바꾸거나 편집 결과를 broadcast하지 않음 |
| S→C | `ROOM_ROSTER` | 참가자·준비 상태 표시용 |

- `CMD_START` 처리: 서버는 `serverStartTime = serverNow + lead`(기본 3초, 최악 RTT·재생준비 여유) 를 찍어 `TRANSPORT` 브로드캐스트.
- 방 생성 시 `TempoMap` revision과 유효 `(measure, pass)` anchor 집합을 고정한다. 이후 템포맵 편집은 활성 방 revision을 바꾸거나 참가자에게 새 타임라인을 밀어 넣지 않는다.
- **늦게 합류/재접속**: 타임라인이 결정론적이므로 `elapsed = serverNow - serverStartTime` 으로 현재 위치를 계산해 **다음 마디 경계부터** 합류(중간부터 소리 냄). 시퀀스 재전송 불필요.
- 로컬 타임라인 자연 종료 시 리더가 `CMD_STOP`을 보내 서버를 `stopped`로 정리한다. `4000/4400/4404` close는 terminal, `4401`은 현재 auth session에서 token을 한 번만 갱신한 뒤 재거부 시 terminal이다.
- ready/start/stop 조작은 전송 즉시 pending으로 전환해 같은 명령을 다시 보내지 않는다. 서버의 roster/transport 변경으로 acknowledgment하거나 5초 후 timeout·재시도 안내로 해제한다.
- 초대 링크 복사가 Clipboard API 미지원·권한 거부로 실패하면 같은 URL을 선택 가능한 read-only input과 재시도 조작으로 제공한다.
- production 서버 상태는 PostgreSQL `PracticeSession` + Redis room state를 권위 경계로 삼고, 프로세스 메모리에는 해당 인스턴스의 socket만 둔다. presence는 heartbeat TTL, room은 logical expiry sorted set으로 회수하며 PING 응답 뒤 최신 transport를 다시 보내 pub/sub 유실을 복구한다.

### 6.4 동기 시작 시퀀스

```mermaid
sequenceDiagram
    participant L as 리더
    participant S as 서버
    participant M as 멤버들
    L->>S: JOIN_ROOM / 멤버들도 입장
    par 각자
        M->>S: PING×10 → offset 추정
        L->>S: PING×10 → offset 추정
    end
    Note over L,M: 사용자 준비 클릭 → prepareAudio, 아직 재생하지 않음
    M->>S: READY
    Note over L: 시작 클릭 → prepareAudio 완료
    L->>S: CMD_START {measure: 26}
    S->>L: TRANSPORT {serverStartTime = now+3s, anchor 26}
    S->>M: TRANSPORT {동일}
    Note over L,M: 각자 로컬 변환: localAudioTime = f(serverStartTime, offset, 캘리브레이션)
    Note over L,M: 예비박 1~2마디 → 26마디 본 재생 (이후 네트워크 무관)
```

### 6.5 출력 지연 캘리브레이션 (실사용 품질의 핵심)

- 기기·출력장치별 오디오 파이프라인 지연이 수십~수백 ms 편차 (특히 **블루투스 스피커/이어폰 100–300ms**).
- 대응:
  1. `AudioContext.outputLatency`/`baseLatency` 자동 반영 (지원 브라우저).
  2. **수동 캘리브레이션 화면**: 테스트 클릭에 맞춰 탭 → 중앙값으로 기기 오프셋 산출, 기기+출력장치 조합별 저장.
  3. 세션 UI에 각 참가자의 RTT·캘리브레이션 여부 표시, 블루투스 감지 시 경고.
- 시각 표시는 오디오보다 별도 오프셋(디스플레이 지연 ~1프레임)을 둔다.

---

## 7. 악보 처리 (기능 2의 마디 세기 + 기능 4)

### 7.1 입력 포맷별 전략

| 포맷 | 마디 인식 | 렌더링 | 비고 |
|---|---|---|---|
| **MusicXML** (.musicxml/.mxl) | **자동·정확** — 마디 수, 박자표, 템포 지시, 도돌이까지 파싱 → **템포맵 초안 자동 생성** | OSMD(OpenSheetMusicDisplay) 또는 Verovio | 최우선 지원 경로 |
| PDF/이미지 | 수동 매핑 기본 + 서버측 OMR(Audiveris) 초안 보조 | PDF.js | persistent job·bounded worker·원자 claim/orphan 복구, revision 고정, OMR은 베스트 에포트로 고지하고 자동 저장 금지 |
| 이미지 (스캔/사진) | PDF와 동일 | 이미지 뷰어 | |

- **수동 마디 매핑 도구**: 시스템(단) 단위로 드래그 → 마디 경계선 클릭으로 분할 → 마디 번호 자동 부여(시작 번호·못갖춘마디 보정 가능). 페이지당 1분 내 작업이 목표. 결과물이 `MeasureMap`.

```ts
interface MeasureMap {
  scoreId: string;
  regions: { page: number; measureNumber: number;
             rect: { x: number; y: number; w: number; h: number } }[]; // 페이지 정규화 좌표
  measureNumberOffset: number;  // 파트보별 번호 어긋남 보정
}
```

저장·업로드 일관성:

- `Score.kind`·`instrument`와 `MeasureMap.regions`·`measureNumberOffset`은 `PUT /scores/:id/settings`에 `expectedMeasureMapRevision`을 함께 보내 한 transaction으로 저장한다. revision이 오래됐으면 metadata와 map 어느 쪽도 바꾸지 않고 409를 반환한다.
- `PUT /scores/:id/settings`와 `PUT /scores/:id/measure-map`은 map 조회 전에 같은 `Score` parent row를 잠근다. 아직 map이 없는 최초 생성도 직렬화하며, 방어적으로 발생한 unique insert 경합은 rollback 후 409로 변환한다.
- presign은 server-only final key와 client-visible staging key를 분리해 `pending` Score와 정확한 upload 만료 시각을 먼저 저장한다. local PUT도 token뿐 아니라 해당 pending row·만료·선언 크기를 업로드 전후에 다시 검증하고 임시 파일을 atomic publish한다.
- complete는 `Score FOR UPDATE`로 reaper·parent delete와 직렬화하고 staging을 final로 멱등 promote한다. 객체 copy 뒤 DB commit이 실패해도 다음 complete가 final의 정확한 크기를 확인해 복구하며, `ready` 전에는 목록·GET에서 pending을 숨긴다.
- Score·Repertoire·Project·Group·계정 삭제는 객체 저장소를 먼저 호출하지 않는다. 논리 삭제와 final/staging key의 durable outbox enqueue를 같은 DB transaction으로 commit하고 204를 반환한다. 다중 worker는 `SKIP LOCKED` lease로 claim해 객체를 멱등 삭제하고 bounded exponential backoff로 포기 없이 재시도한다.
- stale pending reaper는 만료+grace 뒤 잠근 Score와 outbox를 원자 정리한다. presigned 요청이 늦게 도착해 삭제 후 staging object를 다시 만들 수 있으므로 worker는 `guard_until`까지 staging key를 주기적으로 재삭제한다. S3 lifecycle rule은 방어층일 뿐 correctness를 대신하지 않는다. 목록 배지의 `scoreCount`는 `ready`만 집계한다.

### 7.2 마디 기반 내비게이션

- 곡(RepertoireItem)에 속한 모든 악보(총보·파트보들)는 **마디 번호라는 공통 좌표계**를 공유한다.
- 독립 악보 화면은 선택 마디에서 시작하는 자체 재생을 제공하고, 재생 카드에 현재 마디·BPM·박자·박을 표시한다. 로컬 PDF·이미지에는 저장된 템포맵을 연결하거나 `구간 편집`에서 첫 맵을 만들어 연결할 수 있다.
- 세션 안의 악보는 방의 고정 revision과 외부 transport만 사용한다. 마디 탭은 악보 탐색만 바꾸고 시작·정지는 세션 리더 조작으로 수행한다. 템포맵을 편집한 뒤 변경본으로 합주하려면 새 방을 만든다.
- 재생 중: 현재 `TimelineMeasure.measureNumber` 에 해당하는 region 하이라이트 + 자동 페이지 넘김.
- 총보↔파트보 전환: 현재 마디 번호 유지한 채 다른 Score의 같은 마디로 점프 (`measureNumberOffset` 적용).
- 총보·파트보 선택기는 `tablist`/`tab`/`tabpanel`로 연결하고 선택 tab만 tab stop으로 두며, 화살표와 Home/End로 파트를 순환한다.
- 마디 region과 page anchor의 `x/y/w/h`는 viewport나 카드가 아니라 실제 score page surface를 기준으로 0–1 정규화한다. zoom은 표시 크기만 바꾸며 저장 좌표를 바꾸지 않는다.
- 재생 중 사용자가 이전/다음 페이지를 직접 선택하면 auto-follow를 일시 중지한다. 현재 재생 마디로 이동하며 다시 추적하는 명시적 resume CTA를 계속 제공한다.
- 독립 악보의 재생 바는 재생 중이며 보기 모드일 때만 본문 상단 sticky를 적용하고 정지·매핑·필기 중에는 일반 흐름에 둔다. 폭 600px 이상은 2열로 압축하고 재생 중 템포맵 연결 상세는 숨긴다. 세션 악보의 박·재생 조작은 상단 sticky를 유지하며 520px 이상 무대는 2열로 배치한다. 독립 악보 화면의 compact 필기·매핑 도구는 `top: auto`로 상단 위치를 해제한 safe-area 하단 overlay로 띄운다. 세션에 포함된 악보 도구는 일반 문서 흐름에 두어 세션 조작·하단 내비게이션과 겹치지 않게 한다.

### 7.3 필기·주석 레이어

- 악보 위 벡터 오버레이(SVG/캔버스): 펜 스트로크, 텍스트, 셈여림·기호 스탬프.
- 펜·시스템 매핑은 pointer down에서 현재 `pointerId`를 capture하고 move/up에서 그 pointer만 반영한다. 스타일러스 필기 중 다른 손가락이 닿아도 스트로크에 섞지 않으며 `pointercancel`은 임시 상태를 폐기한다.
- page anchor는 원본 `scoreId`·page의 정규화 좌표에 고정한다. measure anchor는 곡의 canonical 마디 번호를 저장하고, 파트 전환 시 대상 `MeasureMap`과 `measureNumberOffset`으로 다시 배치한다.
- `GET /repertoire/:id/annotations`는 그 곡의 모든 Score에서 현재 사용자가 볼 수 있는 project 주석과 본인의 private 주석을 반환해 measure anchor의 파트 간 이동을 지원한다. 기존 `GET /scores/:id/annotations`는 score별 조회 경로로 유지한다.
- 저장은 JSON(원본 파일 불변). 공유 범위는 개인 / 프로젝트 공유다. mutation은 revision을 검사하는 REST commit만 수행하고, `/ws/repertoires/:id/annotations`는 commit 이후의 upsert/delete만 fan-out한다. 첫 `JOIN_ANNOTATIONS`와 모든 재접속에서 가시 주석의 DB snapshot을 보내 누락 이벤트를 복구하며, private 이벤트는 작성자에게만 전달한다. client는 `(annotationId, revision, delete tombstone)`으로 중복·역순 이벤트를 무시한다.

### 7.4 권한·오프라인 snapshot

- `GET /repertoire/:id/access`는 현재 사용자의 `owner | leader | member` role을 반환한다. client는 upload·metadata·map 편집 UI를 선제 제한하고, 서버는 모든 쓰기 요청에서 권한을 다시 검사한다.
- IndexedDB schema v3는 마지막으로 성공한 원격 템포맵, 악보 blob, `MeasureMap`, visible annotations, repertoire practice logs를 `userId` 복합 키 store에 각각 snapshot한다. 성공한 서버 응답만 현재 사용자의 snapshot을 교체한다.
- v1/v2에서 소유자를 판별할 수 없는 원격 snapshot은 v3 migration에서 폐기하고 명시적 local 데이터와 기기 보정은 보존한다.
- browser offline이나 fetch transport 실패 같은 **network failure**일 때만 현재 사용자의 snapshot을 읽기 전용 fallback으로 사용한다. HTTP 4xx/5xx, 권한·revision·payload 오류는 server-authoritative error로 표시하며 캐시로 성공처럼 대체하지 않는다. Service Worker는 인증 API 응답을 runtime cache하지 않는다.

---

## 8. 데이터 모델

```mermaid
erDiagram
    User ||--o{ GroupMember : ""
    Group ||--o{ GroupMember : ""
    Group ||--o{ Project : "공연/시즌"
    Project ||--o{ RepertoireItem : "곡"
    RepertoireItem ||--o{ TempoMap : "revision 관리"
    RepertoireItem ||--o{ Score : "총보/파트보"
    Score ||--o| MeasureMap : ""
    Score ||--o{ Annotation : "필기"
    RepertoireItem ||--o{ PracticeLog : "연습일지"
    PracticeLog ||--o{ Todo : ""
    RepertoireItem ||--o{ PracticeSession : "실시간 세션 기록"
    User ||--o{ DeviceCalibration : "기기별 지연 오프셋"
```

주요 컬럼 메모:

- `GroupMember.role`: owner / leader / member — leader 이상만 동기 세션에서 트랜스포트 조작.
- `TempoMap`: JSON 컬럼(sections, jumps) + `revision` 정수. 수정 시 revision 증가 (동기화 일관성 근거).
- `Score.kind`: full(총보) | part, `instrument`, 파일은 backend-neutral object key 참조. 현재 local backend는 `/data/uploads` 아래에, 선택적 S3 backend는 bucket 안에 같은 key를 해석하며 DB에는 물리 root를 저장하지 않는다.
- `Annotation.scope`: private | project.
- `PracticeLog`: 마크다운 본문 + 마디/악보 위치 앵커 참조 가능. `Todo`: 내용, 담당자, 기한, 완료 여부.
- `DeviceCalibration`: userId + 기기 지문 + 출력장치 라벨 → offsetMs.

---

## 9. 박자 시각화 설계 (기능 6, 공학심리학 근거)

| 설계 결정 | 근거 |
|---|---|
| 연속 진자(펜듈럼) 대신 **이산 플래시 + 채움(fill) 예측 큐** | 움직이는 진자의 위상 판독은 시각 추적 부하가 큼. 반면 "다음 박까지 차오르는" 채움 애니메이션은 지휘자의 예비 동작처럼 **박 도래 시점을 예측**하게 해줌 (앙상블 진입에 필수) |
| 다운비트와 현재 박은 **색 + 크기 + 윤곽 + 위치**로 중복 부호화 | 전주의적(preattentive) 속성을 겹쳐 원거리와 색각 차이에서도 색 하나에 의존하지 않음 |
| 강세는 `무음·보통·강박`, 예비박은 압축 화면에서도 `예비 켬·끔`을 색과 함께 명시 | 내부 enum이나 색 의미를 기억하게 하지 않고 현재 상태·다음 행동의 mental model을 UI 안에서 완성 |
| 일시적 탭 템포 feedback은 시각 라벨과 polite status에 동시에 제공 | 안정적인 버튼 이름을 유지하면서 첫 입력 인식과 누적 횟수를 화면 읽기 도구에도 전달 |
| dialog trigger가 반응형 전환으로 사라지면 새로 보이는 동등 조작으로 focus 복구 | viewport 변경 중 모달을 닫아도 focus가 `body`로 유실되는 mode/context 오류를 방지 |
| 일반 박자에서는 마디 내 박 위치를 번호가 있는 고정 슬롯(4/4면 4칸), 고박자에서는 현재 박을 포함한 번호 window와 생략 표시로 표현 | 공간적 위치와 숫자 라벨은 순간 판독이 빠른 채널. "지금 몇 박인지"를 세거나 색을 추론하지 않고 보되, 좁은 폭에서 원을 판독 불가능하게 축소하거나 잘리는 문제를 피함 |
| 일반 모바일은 기존 박 원 위에 넓은 숫자 panel 추가, 조작은 한 줄 중앙 −5·재생/정지·+5와 오른쪽 작은 탭 | 큰 박 숫자 영역은 테두리·둥근 모서리와 박자표 없이 번호만 중앙에 표시한다. 실제 glyph로 계산한 기존 fit 글자 크기의 80%를 적용하며 panel 크기와 배치는 유지한다. 모바일 stage는 큰 박 번호 → 원형 박 → 현재 속도 숫자와 박자표 순으로 표시한다. 속도 옆 `BPM` 글자는 숨기며 박자표는 속도 숫자 옆에 둔다. 양쪽이 같은 폭인 grid로 속도 숫자의 중심을 고정하고 오른쪽 박자표와 baseline을 맞춘다. 본박 숫자는 `1..beatCount`의 최대 실측 폭을 기준으로 글꼴 크기를 고정하고 x 중심을 유지해 박마다 크기·위치가 흔들리지 않게 한다. 모바일 BPM 직접 입력은 원형 박 아래 속도 숫자를 눌러 연다. 599px 이하 page는 본문 가용 높이에서 header·원형 박·속도·박자표·조작·상태를 제외한 남는 높이를 숫자 panel에 쓰며 짧은 화면·200% 확대는 최소 높이와 스크롤로 조작을 보존한다. 예비박은 countdown, 예약 대기는 `—`이며 같은 오디오 frame rAF로 본박/예비박에만 테마 text 단색의 opacity 0.6–1 pulse를 준다. subdivision마다 반복하지 않고 정지·reduced motion에서는 pulse를 끈다. 모바일 시각·키보드 DOM 순서는 −5 → 재생/정지 → +5 → 탭으로 일치시키며 예비박은 세부 설정 dialog/인라인 panel에서 저장한다. Medium의 2열 틀과 세로 여유가 있는 화면의 빠른 시작 마디는 유지한다. 모바일 일반 메트로놈의 진행 배경은 오디오 `frame.progress`에 따라 하단 메뉴 위까지의 앱 영역을 가장 낮은 배경 레이어에서 진한 주황 `#f47a24`, opacity 0.3으로 왼쪽에서 오른쪽으로 채운다. 600–839px 가로 화면에서는 왼쪽 rail을 제외하며 메뉴는 원래 표면을 유지한다. 큰 숫자 영역에는 별도 배경 채움을 두지 않고 숫자의 pulse·fit 계산을 유지한다. 정지·예약 대기·reduced motion에서는 채움을 비우며 route 이탈·desktop·fullscreen 전환 때 장식 레이어를 제거한다. 모바일의 기존 radial 배경 반응은 끄고 원형 canvas에도 bar를 중복하지 않는다. 기본 bar·desktop/fullscreen·다른 BeatVisualizer 사용처는 기존 bar와 reduced-motion 고정 track을 유지한다. |
| 모바일 큰 박 번호로 집중 화면 전환 | 모바일 상단의 보면대 버튼은 제거하고 큰 박 번호를 누르면 인앱 집중 화면을 토글한다. 집중 화면에는 큰 번호·원형 박·속도/박자표·재생/정지만 남기고 상단·하단 메뉴, ±5·탭·설정을 숨긴다. 다시 큰 번호를 누르거나 입력 dialog가 닫힌 상태에서 Escape로 복귀하며 오디오 재생은 유지한다. 데스크톱의 기존 fullscreen 동작은 유지한다. 모바일 일반 화면의 세부 설정은 테두리 없는 아이콘만 표시하며 44px, coarse pointer에서는 48px의 터치 영역과 `세부 설정` 접근성 이름을 유지한다. |
| 모바일 탭은 조작 영역을 큰 입력판으로 전환 | 작은 진입 버튼은 BPM을 직접 바꾸지 않고 큰 입력판의 실제 탭 간격만 측정한다. 첫 탭은 기준 시각이며 열기/닫기는 미집계, 매 진입 새 측정을 사용한다. 전체 화면 modal 없이 48px target의 우상단 ×·Escape로 복귀하고 탭 버튼 focus를 복원한다. 데스크톱 직접 탭과 fullscreen 조작은 유지한다. |
| 모바일 메뉴 위 배경의 진행 채움과 기존 보면대 배경 신호 | 주변시의 움직임 인지를 보조 신호로 사용한다. 모바일 일반 화면은 메뉴를 제외한 가장 낮은 배경 레이어의 `#f47a24`·opacity 0.3 좌→우 진행 채움, desktop/fullscreen은 기존 다운비트·예비박 배경 반응을 유지하며 화면 전체를 번쩍이는 신호로 바꾸지 않는다. |
| 예비박은 일반 박 원 없이 큰 숫자 카운트다운(4·3·2·1) + 진행 track + 구별되는 색 | 숫자와 박 원의 겹침을 없애고 시작 시점을 명확히 표시 |
| BPM 단계는 20/400으로 clamp하고 끝 방향을 잠금 | 범위 근처에서 버튼이 무반응인 것처럼 보이는 gulf of execution을 없애고 조작 결과를 예측 가능하게 함 |
| 폭·높이별로 숨긴 `시작 마디`는 설정 sheet에 동일하게 제공 | 공간 절약이 과업 기능 손실로 이어지지 않게 하고 잘못된 마디에서 연주를 시작하는 slip을 예방 |
| fullscreen은 화면 뒤 AppShell chrome까지 focus에서 격리 | 보이지 않는 내비게이션으로 Tab focus가 이동하는 mode error를 막고 나가기·재생이라는 안전 조작만 남김 |
| 고대비·대형 요소, 원거리 가독 기준 | 합주실에서 수 m 거리 시인성. 일반 4/4 박 원은 micro·짧은 landscape에서도 약 40px급, Wide에서는 128px 이상 지름을 목표로 한다. 기본 반지름은 최대 72px이고 현재 다운비트는 최대 82px까지 커지며, 고박자는 현재 박이 든 번호 window로 전환한다. 진행막대가 없는 원형 박 묶음은 canvas의 가로·세로 중앙에 정렬한다. |
| 렌더링은 오디오 클럭 기준 rAF | 시각-청각 어긋남(>20ms)은 즉시 위화감 유발. §5.2 |
| 모바일: 햅틱 채널 추가 (Capacitor Haptics) | 다중 감각 중복 부호화, 소음 환경 대응 |
| 모바일 현재 마디·대기·예비박 문맥은 header 왼쪽, desktop/fullscreen은 기존 stage에 표시 | 모바일 개인 연습/Section 문맥을 숨겨 현재 재생 위치를 먼저 읽게 하되 접근 가능한 화면 제목은 유지한다. 모바일 stage는 큰 박 번호 → 원형 박 → 현재 속도 숫자와 박자표 순으로 표시한다. 속도 옆 `BPM` 글자는 숨기며 박자표는 속도 숫자 옆에 둔다. 양쪽이 같은 폭인 grid로 속도 숫자의 중심을 고정하고 오른쪽 박자표와 baseline을 맞춘다. 큰 박 번호 영역에는 박자표를 함께 그리지 않는다. BPM 직접 입력은 원형 박 아래 속도 숫자에서 기존 20–400 dialog·입력 오류·해당 숫자로의 focus 복원을 유지한다. 모바일에서는 속도 숫자를 눌러 기존 20–400 입력 dialog를 열고, 박자표를 눌러 2/4·3/4·4/4·5/4·6/8·9/8·12/8의 같은 7개 선택지를 가진 dialog를 연다. 박자표 변경 시 기존 앞 박 강세를 보존하고 초과분은 제거하며 추가 박은 보통 강세로 채운다. 설정에는 중복 템포 버튼을 두지 않는다. desktop/fullscreen은 기존 표시를 유지한다. |

---

## 10. 튜너 (기능 1)

- `getUserMedia` → `AudioWorklet` 에서 프레임 수집 → 피치 검출은 **MPM(McLeod Pitch Method) 또는 YIN** (자기상관 계열, 단음 악기에 강건). 창 2048–4096 샘플.
- 표시: 음이름 + 센트 편차 바늘(±50센트), 안정화 필터(중앙값).
- 기준음 A4 조절 가능: 440 기본, 415/430/442/443 프리셋 (고악기·오케스트라 대응).
- 마이크 시작은 single-flight이며, 권한·worklet 준비 중 stop/route 이탈 시 lifecycle generation이 늦게 도착한 stream과 graph를 즉시 정리한다.
- 완전 독립 모듈 — 다른 기능과 의존성 없음.

---

## 11. API 개요

### REST (FastAPI, JWT 인증)

```
POST /api/auth/register            # 이름+이메일만 저장, password/session 없음, generic 메일 응답
POST /api/auth/verify-email        # email token + 새 password/확인 → 검증 완료와 session 발급
POST /api/auth/resend-verification # 이전 verification token 무효화 + generic 재발급
POST /api/auth/request-password-reset, /api/auth/reset-password
POST /api/auth/login, /api/auth/google, /api/auth/refresh, /api/auth/logout
POST /api/users/me/delete-challenge # Google-only 계정의 만료 이메일 proof 요청
DELETE /api/users/me               # fresh proof, tombstone+outbox commit; 204 뒤 객체 정리는 eventual
CRUD /groups, /groups/:id/members
CRUD /projects, /projects/:id/repertoire
CRUD /repertoire/:id/tempomap     # PUT 시 revision++
POST /repertoire/:id/scores/presign # pending Score + staging-only presigned target
POST /scores/:id/complete         # staging→final 멱등 promote + ready/outbox atomic commit
DELETE /scores/:id                # 논리 삭제+객체 outbox commit; 204 뒤 eventual cleanup
GET  /repertoire/:id/access       # 현재 owner | leader | member role
PUT  /scores/:id/settings         # Score metadata + MeasureMap atomic revision write
CRUD /scores/:id/measure-map, /scores/:id/annotations
GET  /repertoire/:id/annotations  # 곡 전체 visible annotation
CRUD /repertoire/:id/logs, /repertoire/:id/todos, /todos/:id
POST /rooms                       # 연습 세션 개설 → roomId
```

### WebSocket

§6.3의 메시지 표 참조.

**타입 단일 원천 전략**: 서버의 Pydantic 모델(REST DTO + WS 메시지)이 원천이다. FastAPI가 내보내는 OpenAPI/JSON Schema에서 `openapi-typescript`로 TS 타입을 생성해 `packages/protocol`에 커밋 → 클라(TS)와 서버(Python)가 항상 같은 스키마로 검증한다. 스키마 변경 시 CI에서 생성물 불일치를 검출.

---

## 12. 비기능 요구사항 · 리스크

| 항목 | 기준 / 대응 |
|---|---|
| 박 타이밍 정밀도 (로컬) | 오디오 클럭 예약 기준 지터 < 1ms (룩어헤드 스케줄링으로 보장) |
| 동기 오차 (기기 간) | 목표 ±10ms. 지배 요인은 출력 지연 → 캘리브레이션 필수 UX로 |
| 백그라운드 동작 | 모바일 앱: 오디오 세션 유지 + 화면 꺼짐 방지 옵션. 웹: Worker 타이머 + Wake Lock API |
| 블루투스 출력 | 100–300ms 지연. 감지 시 경고 + 캘리브레이션 유도. 앙상블 모드에선 유선/내장 스피커 권장 안내 |
| OMR 정확도 | 자동 인식은 초안 생성 보조로 포지셔닝. 수동 매핑 도구가 항상 기본 경로 |
| 오프라인 | IndexedDB v3에 원격 템포맵·악보·map·주석·연습일지를 `userId`별로 snapshot. Editor를 포함해 network failure에만 현재 사용자의 읽기 전용 fallback을 허용하고 server-authoritative error는 숨기지 않음. 동기 세션은 온라인 필수 |
| PWA 보안 이행 | App mount 전 `fmr-api` fail-closed purge + versioned worker 제어권 + 전환 후 재-purge. Service Worker와 nginx의 API cache 금지. 실제 legacy worker/cache upgrade E2E로 검증 |
| 공급망·런타임 | Python·Node·nginx·uv·PostgreSQL image를 tag+digest로 고정. 생성한 ARM64 server/web image의 default CMD, migration, non-root/read-only 경계, nginx SPA/header/API proxy를 push 전 실제 container smoke |
| 확장 | Redis shared room state + participant TTL + distributed lock + pub/sub fan-out. Redis 없는 development/test만 단일 인스턴스 메모리 fallback |
