# FeelMyRythm 구현 로드맵

[설계문서](./DESIGN.md)를 실제로 구현하기 위한 단계별 계획. 각 단계는 **독립적으로 배포·검증 가능한 마일스톤**이며, "한 번에 전부"가 아니라 아래 순서대로 쌓아 올린다.

---

## 1. 왜 이 순서인가 — 의존성 그래프

```mermaid
graph LR
    P0["Phase 0<br/>모노레포 기반"] --> P1["Phase 1<br/>로컬 메트로놈 MVP"]
    P1 --> P2["Phase 2<br/>템포맵·구간 편집기"]
    P2 --> P3["Phase 3<br/>서버·계정·그룹"]
    P3 --> P4["Phase 4<br/>실시간 동기화 ★"]
    P3 --> P5["Phase 5<br/>악보 업로드·마디 매핑"]
    P5 --> P6["Phase 6<br/>필기·연습일지·할일"]
    P1 -.독립.-> P7["Phase 7<br/>튜너"]
    P4 --> P8["Phase 8<br/>모바일 패키징·출시"]
    P5 --> P8
```

원칙:

1. **P0 기능(템포맵·동기화)이 최단 경로에 오도록** 배치. 악보·일지는 그 뒤.
2. 타이밍 엔진(Phase 1)은 모든 것의 토대이므로 가장 먼저, 가장 단단하게. 여기서 품질이 안 나오면 이후 전부 무의미.
3. 동기화(Phase 4)는 서버·계정(Phase 3)이 선행돼야 하지만, **시계동기 수학 자체는 Phase 1부터 core 패키지에 순수 함수로 미리 작성·테스트 가능**.
4. 튜너(Phase 7)는 의존성이 없어 아무 때나 병렬 진행 가능 (기분전환용 사이드 트랙으로 적합).
5. 모바일 패키징(Phase 8)은 마지막이지만, **Capacitor 셸에서의 오디오 지연 스모크 테스트는 Phase 1 직후 1회 선행**한다(§6 리스크 참조 — 아키텍처를 뒤흔들 수 있는 리스크는 조기 검증).

---

## 2. 단계별 상세

> 기간은 1인 개발, 파트타임 기준의 감. 각 단계 끝의 **DoD(완료 기준)** 를 통과해야 다음 단계로.
>
> 모든 Phase의 DoD에는 문서 동기화가 포함된다. 앱의 코드·설정·스키마·UI·빌드·배포 동작이 바뀌면 해당 내용을 설명하는 기존 설계·기능·사용자·아키텍처·운영 문서를 같은 변경에서 함께 수정해야 한다. 관련 문서가 이전 동작을 설명한 채 남아 있으면 해당 Phase나 작업은 완료가 아니다.

### Phase 0 — 프로젝트 기반 (약 1주)

| 작업 | 내용 |
|---|---|
| 모노레포 | pnpm workspaces, `packages/{core,audio,ui,protocol}`, `apps/{web,mobile}` 골격. `apps/server`는 Python 프로젝트(uv + FastAPI) |
| 품질 도구 | JS: TypeScript strict, ESLint/Prettier, Vitest · Python: Ruff, mypy, pytest · GitHub Actions (lint+test 양쪽) |
| 디자인 토큰·앱 셸 | [UI 디자인 시스템](./UI_DESIGN.md)의 색·타이포 토큰을 Tailwind CSS 변수로 셋업. 폭 839px 이하는 topbar 없이 하단 더보기에서 Bonifacio·테마·설정·계정/로그인·managed SSO 운영 안내에 접근하며 본문 상단 safe area를 보존한다. 840px 이상은 topbar를 유지한다. |
| 배포 파이프라인 | GitHub-hosted ARM64 runner가 web/server 이미지를 GHCR에 commit SHA로 발행하고, 제한 SSH 명령으로 RPi Compose를 갱신한다. Python·Node·nginx·uv·PostgreSQL base는 tag+digest로 고정하고 exact runtime tag를 push 전 실행 smoke한다. 운영 DB는 외부 `cksDB`의 전용 DB·계정을 사용한다. |
| PWA 보안 기반 | App mount 전 `fmr-api` fail-closed purge, versioned safe Service Worker 제어권 확인·구형 worker 종료·재-purge, Workbox/nginx API no-cache, 별도 upgrade E2E를 구성한다. |

**DoD**: `pnpm test`·`pnpm build`·`pytest` 가 CI에서 통과하는 빈 골격.

### Phase 1 — 로컬 메트로놈 MVP (2–3주) ★토대

| 작업 | 내용 (설계문서 참조) |
|---|---|
| core: 타임라인 | 단일 구간 한정 `TempoMap` → `expandTimeline`, `locate`, `buildCountIn` (§4.3) — **반복(jumps)은 이 단계에선 미구현, 타입만 정의** |
| audio: 엔진 | `AudioEngine` 인터페이스 + `WebAudioEngine`: Worker 타이머 + 룩어헤드 스케줄러 (§5.2), 클릭 샘플 4종 |
| UI: 비주얼 메트로놈 | 번호가 있는 박 슬롯 + 채움 예측 큐 + 다운비트 강조 (§9), rAF는 오디오 클럭 기준. idle resize/theme redraw, DPR backing store, 폭·높이 기반 기본 원(반지름 최대 72px)·현재 다운비트(최대 82px)·track(최대 14px) 보간을 적용한다. 고박자는 현재 박을 포함한 번호 window와 생략 표시로 전환한다. 진행막대가 없는 원형 박 묶음은 canvas의 가로·세로 중앙에 정렬한다. 예비박은 일반 박 원을 함께 그리지 않고 단독 카운트다운 숫자를 표시하며 기본 bar 사용처는 진행 track을 유지한다. 예약 대기·예비박 metadata는 최종 anchor를 따르고 첫 오디오 전에는 강조·announcement·반응 배경을 억제하며 예약 시각은 유지한다. compact 내용 겹침과 tall 중앙 공백을 geometry E2E로 막고, primary/secondary/muted/accent text의 실제 표면 조합 4.5:1·control/고정 track 윤곽 3:1을 자동 계산한다. 보조 background glow는 다운비트/연속 예비박으로 빈도를 제한하고 reduced motion에서 끈다. 폭 839px 이하 일반 화면에는 기존 원형 표시 위에 숫자 panel을 두어 본박·예비박 countdown·대기 `—`만 표시한다. 큰 박 숫자 영역은 테두리·둥근 모서리와 박자표 없이 번호만 중앙에 표시한다. 실제 glyph로 계산한 기존 fit 글자 크기의 80%를 적용하며 panel 크기와 배치는 유지한다. 200px 숫자 상한은 적용하지 않는다. 모바일 stage는 큰 박 번호 → 원형 박 → 현재 속도 숫자와 박자표 순으로 표시한다. 속도 옆 `BPM` 글자는 숨기며 박자표는 속도 숫자 옆에 둔다. 양쪽이 같은 폭인 grid로 속도 숫자의 중심을 고정하고 오른쪽 박자표와 baseline을 맞춘다. 본박 숫자는 `1..beatCount`의 최대 실측 폭을 기준으로 글꼴 크기를 고정하고 x 중심을 유지해 박마다 크기·위치가 흔들리지 않게 한다. 599px 이하 page는 본문 가용 높이를 채우고 header·원형 박·속도·박자표·조작·상태를 뺀 남는 높이를 숫자 panel에 배분한다. 숫자·원형 박·속도/박자표는 세로의 일반 흐름으로 배치하며 짧은 화면·200% 확대는 최소 높이와 스크롤로 조작을 보존한다. 같은 audio frame rAF로 테마 text 단색의 opacity 0.6–1을 본박/예비박마다 pulse하고 subdivision·정지·reduced motion에서는 pulse를 끈다. 모바일 일반 메트로놈의 진행 배경은 오디오 `frame.progress`에 따라 하단 메뉴 위까지의 앱 영역을 가장 낮은 배경 레이어에서 진한 주황 `#f47a24`, opacity 0.3으로 왼쪽에서 오른쪽으로 채운다. 600–839px 가로 화면에서는 왼쪽 rail을 제외하며 메뉴는 원래 표면을 유지한다. 큰 숫자 영역에는 별도 배경 채움을 두지 않고 숫자의 pulse·fit 계산을 유지한다. 정지·예약 대기·reduced motion에서는 채움을 비우며 route 이탈·desktop·fullscreen 전환 때 장식 레이어를 제거한다. 모바일의 기존 radial 배경 반응은 끄고 원형 canvas에도 bar를 중복하지 않는다. 기본 bar·desktop/fullscreen·다른 BeatVisualizer 사용처는 기존 bar와 reduced-motion 고정 track을 유지한다. 모바일 현재 마디·대기·예비박 문맥은 header 왼쪽에 두고 개인 연습/Section은 숨기되 제목 접근성을 유지한다. desktop/fullscreen은 기존 stage 문맥을 유지한다. [UI 디자인 시스템](./UI_DESIGN.md) 적용 |
| 기본 조작 | 폭 839px 이하 일반 화면(집중 화면·fullscreen 제외)은 한 줄 중앙에 −5 → 재생/정지 → +5를 묶고 탭을 오른쪽 끝에 작고 은은한 글자로 표시한다. 시각·키보드 DOM 순서를 일치시키며 예비박은 모든 폭에서 세부 설정 dialog/인라인 panel의 `settingsControls`로 옮겨 저장 동작을 유지한다. Medium의 2열 틀과 세로 여유가 있는 화면의 빠른 시작 마디는 유지한다. 모바일 원형 박 아래 현재 속도 숫자를 눌러 직접 입력한다. `BPM` 글자는 숨기고 박자표를 속도 옆에 표시한다. 기존 20–400 dialog·입력 오류·속도 숫자로의 focus 복원은 유지하며 설정에는 중복 템포 버튼을 두지 않는다. desktop/fullscreen은 기존 표시를 유지한다. 모바일 탭은 BPM을 직접 바꾸지 않고 조작 영역을 큰 입력판으로 대체한다. 첫 실제 탭을 기준 시각으로 기존 간격 계산을 사용하며 열기/닫기는 미집계하고 매 진입 새 측정을 시작한다. 우상단 ×의 48px target과 Escape로 복귀해 탭 버튼 focus를 복원한다. 전체 화면 modal은 만들지 않으며 데스크톱 직접 탭과 fullscreen은 유지한다. BPM·박자표 설정, 예비박 on/off, 볼륨, 강세 패턴, 설정 localStorage 저장. 모바일에서는 속도 숫자를 눌러 기존 20–400 입력 dialog를 열고, 박자표를 눌러 2/4·3/4·4/4·5/4·6/8·9/8·12/8의 같은 7개 선택지를 가진 dialog를 연다. 박자표 변경 시 기존 앞 박 강세를 보존하고 초과분은 제거하며 추가 박은 보통 강세로 채운다. 모바일 일반 화면의 세부 설정은 테두리 없는 아이콘만 표시하며 44px, coarse pointer에서는 48px의 터치 영역과 `세부 설정` 접근성 이름을 유지한다. 모바일 상단의 보면대 버튼은 제거하고 큰 박 번호를 누르면 인앱 집중 화면을 토글한다. 집중 화면에는 큰 번호·원형 박·속도/박자표·재생/정지만 남기고 상단·하단 메뉴, ±5·탭·설정을 숨긴다. 다시 큰 번호를 누르거나 입력 dialog가 닫힌 상태에서 Escape로 복귀하며 오디오 재생은 유지한다. 데스크톱의 기존 fullscreen 동작은 유지한다. 메트로놈에서 박자표를 바꾸면 기존 강세를 앞 박부터 보존하고 새 박수에 맞춰 초과분을 잘라내거나 추가 박을 보통 강세로 채운다. BPM 단계는 20/400 경계로 clamp하고 끝 방향을 잠그며, 강세·예비박 상태를 색과 이름으로 중복 부호화한다. 설정의 예비박은 이름과 `켬/끔`을 보존하고 탭 feedback은 시각 라벨과 polite status에 함께 제공한다. 빠른 시작 마디가 숨는 압축 화면은 설정 dialog에 같은 field를 제공하며, 열린 dialog 중 trigger가 숨기는 높이 경계를 넘으면 인라인 시작 마디로 focus를 복구한다. |
| 스모크 테스트 | **Capacitor 빈 셸에 웹 빌드를 넣고 iPhone 실기기에서 오디오 지연·화면꺼짐 동작 확인** (리스크 조기 검증) |

**DoD**:
- 30분 연속 재생에서 드리프트·지터 청감 무결 (녹음 후 파형 간격 검사로 확인).
- 백그라운드 탭에서도 클릭이 끊기지 않음.
- 단위 테스트: 타임라인 전개·locate 경계값 (못갖춘마디, 6/8 dotted-quarter 등).

### Phase 2 — 템포맵·구간 편집기 (2–3주) ★기능 2 완성

| 작업 | 내용 |
|---|---|
| core: 반복 전개 | `JumpDirective` 전체(도돌이·볼타·D.C./D.S./Coda) 지원하는 `expandTimeline` 완성 + 무한루프 검출 |
| core: seek | `seekPoint(measure, pass)` — "26마디 2번째 패스부터" 시작 지원 |
| UI: 편집기 | 구간 리스트 편집 + 마디 눈금 타임라인 뷰 (§4.4), native table 표 모드, 구간 분할/병합, 유효성 표시. 저장 후 정확한 맵의 `메트로놈에서 열기`와 악보 문맥의 `악보로 돌아가기` 제공 |
| UI: 재생 | 마디 지정 시작, 현재 마디·구간 라벨·다음 변화 예고 표시. 모바일은 현재 마디·대기·예비박을 header 왼쪽에 모으고 desktop/fullscreen은 기존 stage 문맥을 유지한다. 로컬 재생 중 템포맵 변경은 다음 마디 경계에 반영하고, 동기 세션은 방 revision을 유지하므로 편집 결과는 새 방에 적용 |
| 저장 | 템포맵 다건 로컬 저장(IndexedDB), JSON 내보내기/가져오기. `source=local`은 로그인 중에도 로컬 map ID를 유지하고 가져오기는 현재 대상 ID·repertoire·revision을 보존. 재생은 `tempoMap` ID를 명시하고 누락 맵을 다른 맵으로 대체하지 않음 |

**DoD**: 사용자 시나리오 재현 — "♩=100 4/4 시작 → 26마디부터 ♩=130 → 도돌이 1st/2nd 엔딩" 템포맵을 편집기로 만들고, 임의 마디부터 예비박 포함 재생. 반복 전개 단위 테스트 통과.

### Phase 3 — 서버·계정·그룹·공유 (약 2주)

| 작업 | 내용 |
|---|---|
| 서버 | FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL, JWT 인증 (이메일 + Google OAuth) |
| 운영 SSO | 중앙 edge가 확인한 immutable subject를 우선 연결하고, unique email의 기존 계정은 한 번만 link하며 새 중앙 계정은 verified SSO-only 사용자로 provision. 저장된 app session은 현재 edge identity 아래 검증·refresh해 재사용하고 권위 있는 거부에만 재교환 |
| 도메인 CRUD | Group / Project / RepertoireItem / TempoMap(revision) — §8 스키마 |
| 클라 연동 | 로그인, 그룹·프로젝트·레파토리 화면, 템포맵 서버 저장·불러오기와 명시적 revision 충돌 선택. access role을 먼저 확인하고 새 곡의 최신 맵 404·빈 revision 목록이 확인되면 owner/leader의 첫 초안을 제공하며 member는 읽기 전용 |
| protocol | Pydantic → OpenAPI → `openapi-typescript`로 TS 타입 자동 생성 파이프라인 (CI 검증 포함). 값이 없는 optional 필드는 저장·조회·revision 목록·MusicXML 초안 응답에서 `null` 대신 생략 |

**DoD**: 두 계정이 한 프로젝트에서 같은 곡의 템포맵을 공유·수정(revision 증가)할 수 있다.

### Phase 4 — 실시간 동기화 (3–4주) ★기능 3 완성, 최고 난도

| 작업 | 내용 |
|---|---|
| 서버 WS | FastAPI WebSocket 엔드포인트: Redis 공유 방 상태·presence TTL·분산 lock·pub/sub fan-out, `TransportState`, PING/PONG 권위 상태 복구 — uvloop, 수신 즉시 타임스탬프 기록 (§6.2–6.3) |
| core: 시계동기 | min-RTT 필터 offset 추정기 + 드리프트 평활 — **순수 함수로 작성, 시뮬레이션 단위 테스트** (지연 분포를 주입해 오차 검증) |
| 클라: 변환 체인 | serverTime → performance.now() → audioCtx time 매핑 유지 |
| 세션 UX | 방 개설/입장, 참가자별 준비/대기·준비 인원수, 리더 재생 설정. 사용자 준비/시작 클릭에서 `prepareAudio()`를 기다린 뒤 명령을 보냄. 작은 화면은 박·준비·시작/정지를 일반 흐름에 먼저 두고 목록은 sheet, RTT·revision은 접는 정보로 제공. ready/start/stop은 acknowledgment/5초 timeout 전까지 잠그며 초대는 공개 URL과 clipboard fallback 제공 (§6.4) |
| 캘리브레이션 | 탭 기반 기기 오프셋 측정 화면 + 기기·출력장치별 저장 (§6.5), 블루투스 경고 |
| 복원력 | 늦은 합류·재접속 시 다음 마디 경계 합류, WS 재연결. 미준비 참가자는 `소리 켜고 합류`로 오디오를 준비. 미준비 상태는 합류 대기, 예약 뒤 첫 오디오 전은 시작 대기로 표시 |

**DoD**:
- 같은 Wi-Fi의 기기 2대(+가능하면 3대: 폰/노트북 혼합)에서 동시 재생을 녹음 → 파형 클릭 간격 차 **±10ms 이내** (블루투스 제외, 캘리브레이션 후).
- 재생 중 한 기기의 네트워크를 끊어도 해당 기기 재생 지속.
- 시계동기 추정기 시뮬레이션 테스트: 지터 50ms 분포에서 offset 오차 < 5ms.

### Phase 5 — 악보 (3–4주) ★기능 4 + 기능 2의 "마디 세기"

| 작업 | 내용 |
|---|---|
| 업로드 | final과 분리된 presigned staging 업로드, PDF/이미지/MusicXML 타입 감지. complete는 멱등 promote 뒤 `ready`+staging 삭제 outbox를 원자 commit하고, stale pending reaper·late-write guard가 client 실패를 회수하며 악보 수는 `ready`만 집계 |
| 저장 backend | DB에는 물리 경로가 아닌 backend-neutral object key·size·상태를 저장. 현재 단일 서버 운영은 Compose 밖에서 사전 생성한 external local volume을 사용하고, 다중 서버·off-host object storage가 필요할 때 같은 key 계약으로 S3를 선택 |
| MusicXML | 파싱 → 마디 수·박자표·템포·도돌이 추출 → **템포맵 초안 자동 생성** (§7.1), OSMD 렌더링 |
| PDF/이미지 | PDF.js 뷰어 + **수동 마디 매핑 도구**. pointer 좌표를 zoom과 무관한 score page surface 0–1 좌표로 저장. 로컬 악보에 저장된 템포맵을 연결하거나 `구간 편집`에서 첫 맵을 생성·연결 |
| 원자적 저장 | `PUT /scores/:id/settings`로 metadata와 MeasureMap을 revision 검증 후 함께 저장. 최초 map 생성도 Score parent lock, 경합은 rollback + 409 |
| 연동 | 독립 악보는 마디 선택 → 해당 마디부터 재생과 현재 마디·BPM·박자·박 카드 제공. 세션 내 악보는 route를 유지하고 방의 고정 revision·외부 transport를 받아 추적하며 자체 재생·seek를 만들지 않음. 수동 탐색은 auto-follow 중지 + resume CTA |
| 파트보 | Score kind/instrument, 총보↔파트보 같은 마디 점프 (`measureNumberOffset`) |
| 입력·시맨틱 | 파트보는 `tablist`/roving tab index/화살표·Home·End로 선택. 펜·매핑은 현재 `pointerId`를 capture해 stylus와 2차 pointer를 혼합하지 않음 |
| 권한 | `/repertoire/:id/access` role로 leader/owner 전용 upload·metadata·map UI를 선제 제한하고 서버에서 재검증 |
| 오프라인 | IndexedDB schema v3의 `userId` 복합 키 store에 원격 템포맵·악보·map·주석·연습일지를 성공 응답 단위로 snapshot. 구형 unscoped remote row는 migration에서 폐기하고 network failure만 현재 사용자의 읽기 전용 fallback 허용 |
| compact UI | 독립 재생 바는 재생 중+보기 모드만 sticky, 정지·매핑·필기 중은 일반 흐름. 600px 이상 2열 압축과 재생 중 맵 연결 상세 숨김. 세션의 상단 sticky와 520px 이상 2열 유지. 독립 악보의 좁은 화면 도구는 top:auto의 하단 overlay, 세션 내 악보 도구는 일반 흐름. 짧은 재생/정지·구간 편집 라벨과 자세한 접근성 이름 유지 |
| OMR 보조 | Audiveris 서버 OMR을 persistent background job으로 실행하고 PDF/이미지 마디맵 초안을 생성. 시작 revision을 고정하며 미리보기·명시적 저장 전에는 기존 맵을 변경하지 않음 |

**DoD**: MusicXML 업로드 → 마디 수 자동 인식·템포맵 초안 생성. PDF 업로드 → 10분 내 수동 매핑 완료 → atomic settings 저장·재생 하이라이트·파트보 점프 동작. network failure에서는 snapshot으로 열리고, 403/404/409/5xx는 캐시로 숨기지 않는다.

### Phase 6 — 필기·연습일지·할일 (2–3주, 기능 5)

| 작업 | 내용 |
|---|---|
| 필기 | 악보 벡터 오버레이 (펜/텍스트/셈여림 스탬프). `/repertoire/:id/annotations`의 measure anchor는 파트 간 재투영하고 page anchor는 원본 score에 유지. 개인/프로젝트 공유와 REST commit 이후 WebSocket fan-out, 재접속 DB snapshot 복구 (§7.3) |
| 연습일지 | 레파토리별 일지 (마크다운), 마디 위치 앵커 첨부 |
| 할일 | 일지·레파토리에 Todo (담당자·기한·완료), 프로젝트 대시보드에 집계 |

**DoD**: 일지에 "26마디 crescendo 주의" 메모를 마디 앵커로 남기면 악보 해당 위치에서 표시됨.

### Phase 7 — 튜너 (1–2주, 아무 때나 병렬 가능)

| 작업 | 내용 |
|---|---|
| 검출 | AudioWorklet + MPM/YIN (§10), 안정화 필터 |
| UI | 음이름 + 센트 바늘, A4 기준음 프리셋 (440/442/443/415) |

**DoD**: 기준 사인파 220–1760Hz에서 ±2센트 내 표시, 실악기(현·관) 청감 검증.

### Phase 8 — 모바일 패키징·출시 (2–3주)

| 작업 | 내용 |
|---|---|
| Capacitor | iOS/Android 프로젝트, 아이콘·스플래시, 딥링크(방 초대 링크). native 초대 URL은 WebView origin 대신 설정된 공개 서버 origin과 APP_BASE로 생성 |
| production SSO 인증 | system browser에서 확인한 중앙 session을 짧은 수명의 일회용 app credential로 교환하고 native callback 뒤 secure storage session을 만든다. WebView cookie 공유나 production local login에 의존하지 않음 |
| 설치 첫인상 | PWA `id`/scope/start URL·`ko-KR`·category, 분리된 `any`/`maskable` PNG, Apple touch icon을 검증. 다크/라이트는 `theme-color`와 Capacitor SystemBars까지 동기화 |
| 네이티브 보강 | `NativeAudioEngine` 구현 완료: iOS AVAudioEngine/.playback session, Android Oboe low-latency callback/foreground media service, 전체 timeline batch·경계 취소. Keep-Awake와 Haptics도 동일 bridge 수명에 연결 |
| 지연 검증 | 실기기 매트릭스에서 Phase 4 DoD 재검증. iOS/Android 녹음 파형으로 화면 꺼짐·인터럽트·기기 간 ±10ms를 확인하고 calibration 값을 기록 |
| 출시 | TestFlight/내부 테스트 → 스토어 심사 |

**DoD**: 실기기 2대(iOS+Android)에서 화면 꺼짐 상태 포함 동기 재생 오차 기준 충족, 스토어 제출.

---

## 3. MVP 컷라인 (가장 빨리 실사용에 도달하는 선)

**Phase 0 → 1 → 2 → 3 → 4** 까지가 MVP. 이 시점에 "앙상블이 같은 템포맵으로 같은 순간에 예비박부터 시작"이라는 핵심 가치가 완성된다. 악보(5)·일지(6)·튜너(7)는 MVP 이후 사용자 피드백을 받으며 추가해도 된다. 앙상블 팀에 MVP를 먼저 써보게 하는 것을 강력 권장.

## 4. 테스트 전략

| 대상 | 방법 |
|---|---|
| 타임라인 전개 (반복·볼타·D.C.) | 순수 함수 단위 테스트가 주력. 악보 예제 케이스를 픽스처로 축적 |
| 시계동기 추정기 | 네트워크 지연 분포 주입 시뮬레이션 (결정론적 시드) |
| 오디오 타이밍 | 재생 녹음 → 클릭 온셋 간격 자동 분석 스크립트 (회귀 검사용) |
| 동기 오차 | 기기 2대 동시 녹음 → 파형 교차상관으로 오프셋 측정 (Phase 4 DoD 도구) |
| 서버 API/WS | pytest + httpx/WebSocket 테스트 클라이언트 (FastAPI 내장 지원) |
| UI/플로우 | Playwright: 편집기 시나리오, 방 개설→시작 (WS 목서버) |
| PWA upgrade | 구형 API-caching worker와 `fmr-api`를 실제 브라우저에 seed. safe worker 전환 중 legacy late write를 재현한 뒤 App mount 전 purge·network API 응답·manifest icon을 별도 Playwright 게이트로 검증 |
| 앱 셀·대규모 workspace | history POP scroll 복원·새 탐색 top·overlay close, leaf 동시성 6 상한, 일부 503에서 건강한 곡 유지·재시도를 단위/UI 테스트로 검증 |
| 악보 동시성 | Score parent lock, 최초 MeasureMap insert 경합, stale settings 409와 metadata/map transaction rollback을 PostgreSQL + API 테스트로 검증 |
| 악보 cache/UX | network error와 HTTP error 분기, IndexedDB v3 user partition/migration/snapshot, Service Worker 인증 API cache 부재, zoom 좌표, manual page resume, compact fixed overlay를 단위·Playwright 테스트로 검증 |
| 반응형·접근성 | [RESPONSIVE_UX.md](./RESPONSIVE_UX.md)의 52개 viewport × 12개 주요 route 기본 상태에서 overflow·고정 UI 비가림·44px 타깃·CTA 도달성과 route heading focus를 검증한다. 메트로놈의 기본 상태/조작 비겹침은 이 전체 matrix에서 확인하고 recovery banner는 폭별 압축 구간, 375–390px 초단축 landscape와 `420/421`, `820/821`, `900/901`, `640/641` 경계 표본에 주입한다. `359/390 × 420` recovery는 실제 status·stage·controls rect가 scrollport 안에 있는지 직접 비교한다. Medium의 `1180/1181`은 더 이상 배치 전환점이 아니며 연속성 표본으로 비교한다. Fullscreen 상태 유무와 뒤 AppShell focus 차단, `390 × 600`·`256 × 480`의 32px root font 확대, 32px root font에서 `256/320/359/390/419 × 480`과 `599 × 700`의 내비게이션 상한·focus reveal, coarse pointer 48px target과 예비박 식별자, compact/Medium의 시작 마디 가용성, 열린 설정 dialog의 `820→821`·`900→901` focus 복구, dialog focus·키보드 경로와 테마별 선택 text/control 대비는 별도 대표 시나리오에서 검증한다. |
| 런타임 이미지 | tag+digest로 고정한 base로 ARM64 image를 빌드한 뒤 exact publish tag의 server default CMD/Alembic/health/non-root/read-only 경계와 nginx config/SPA/header/API proxy를 실제 container로 smoke |
| SSO·provider 운영 계약 | SSO session 재사용·거부 후 재교환·오류 차단 UI와 local form 비노출을 단위 테스트한다. preflight는 인증, SMTP, storage, mobile association을 독립 조건으로 판정하고 runtime image의 현재 운영 안내 문구를 확인한다. |

## 5. 리스크 관리 (검증 시점을 앞당긴 것들)

| 리스크 | 영향 | 대응·검증 시점 |
|---|---|---|
| WKWebView 오디오 지연/백그라운드 제약 | 아키텍처 재고 수준 | NativeAudioEngine 전체-timeline queue와 Android foreground service로 WebView timer 의존 제거. 실제 기기 파형 gate는 유지 |
| 블루투스 출력 지연 | 동기 체감 파괴 | 설계에 캘리브레이션·경고 내장 (Phase 4). 제거 불가능한 물리 제약으로 UX로 관리 |
| OMR(PDF 자동 인식) 정확도 | 기대 불일치 | 수동 매핑을 기본 경로로 설계, OMR은 초안 보조로만. Phase 5 후반에 별도 검증 |
| 반복 구조 엣지케이스 (D.S. al Coda 중첩 등) | 잘못된 전개 | 실제 악보 픽스처 테스트 축적, 편집기에서 전개 결과 미리보기 제공 |
| 1인 개발 범위 과다 | 지연 | MVP 컷라인(§3) 준수, Phase 5 이후는 피드백 기반 우선순위 재조정 |
