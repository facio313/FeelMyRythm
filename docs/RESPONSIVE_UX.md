# FeelMyRythm 반응형·적응형 UX 명세

이 문서는 [UI_DESIGN.md](./UI_DESIGN.md)의 시각 원칙을 실제 화면 크기, 입력 방식,
접근성 설정에 적용하는 구현 계약이다. 화면을 특정 기기 이름에 맞추지 않고 **가용 폭,
가용 높이, 포인터 정밀도, safe area, 사용자 글자 크기**에 따라 적응시킨다.

## 1. 공통 불변 조건

- 페이지 자체에는 가로 스크롤이 생기지 않는다. 마디 타임라인, 악보 캔버스, 데이터 표처럼
  본질적으로 넓은 콘텐츠만 자체 스크롤 영역을 가진다.
- 주요 조작은 최소 `44 × 44px`, `any-pointer: coarse`인 혼합 입력 기기에서는 `48 × 48px`을 확보한다.
- 모든 페이지는 `100dvh`와 safe-area inset을 사용한다. 고정 하단 내비게이션과 토스트는
  `env(safe-area-inset-bottom)`을 포함한다.
- 200% 글자 확대에서도 조작과 본문이 겹치거나 잘리지 않는다. 버튼 라벨은 두 줄까지
  허용하고, 행 기반 폼은 한 열로 재배치한다. Modal의 최초 focus는 확대 후에도 dialog의
  실제 scrollport 안에 완전히 들어오도록 이동한다. 짧은 화면에 모든 메트로놈 조작이 동시에
  들어오지 않으면 재생·탭·예비박과 상태 복구 조작에 focus할 때 하단 내비게이션 위로 완전히
  드러나는 세로 스크롤 경로를 보장한다.
- `prefers-reduced-motion`에서는 페이지·큐 애니메이션을 제거하되 기능 정보인 박 플래시는
  유지한다. 색만으로 상태를 전달하지 않는다.
- 키보드, 화면 읽기 도구, 터치, 펜, 마우스가 같은 기능에 도달할 수 있어야 한다.
- 로딩은 이전 레이아웃의 크기를 유지하는 skeleton 또는 progress 상태로, 오류는 원인과
  재시도 조작을 함께, 빈 상태는 다음 행동 하나를 명확히 제시한다.

## 2. 폭·높이 구간

폭 구간은 CSS 픽셀 기준이며 각 화면은 아래 구간 사이를 자연스럽게 보간한다.

| 구간 | 가용 폭 | 기본 내비게이션 | 콘텐츠 규칙 |
|---|---:|---|---|
| Micro | `< 360px` 또는 확대 후 동등 폭 | 5개 하단 탭 + 더보기 | 1열, 카드 padding 12px, 짧은 라벨 |
| Compact | `360–599px` | 5개 하단 탭 + 더보기 | 1열, 하단 핵심 조작, sheet |
| Medium | `600–839px` | 세로형은 하단 탭, 가로형은 rail | 1–2열, master/detail은 전환형 |
| Expanded | `840–1199px` | 72px rail | 2열, 보조 패널 접기 가능 |
| Desktop | `1200–1599px` | 216px sidebar | 최대 1200px, 편집기는 2패널 |
| Wide | `≥ 1600px` | 240px sidebar | 최대 1440px, 정보 밀도만 증가 |

별도 높이 구간:

- 메트로놈 설정 sheet와 조작 압축은 폭·높이를 함께 본다. Micro/Compact(`≤599px`)는
  높이 `≤900px`, Medium(`600–839px`)은 `≤820px`, Expanded 이상은 `≤640px`에서
  설정 panel을 sheet로 옮긴다. Medium은 821px부터 stage/조작 2열을 유지하면서 인라인
  설정과 `시작 마디`를 다음 row에 복원해 세로 여유를 빈 공간으로 버리지 않는다. 모든 폭의
  `height ≤539px`에서는 헤더를 52px로 줄이고 BPM 입력 힌트를 숨긴다.
- Micro/Compact의 canvas 자체는 높이 `≤700px`에서만 84px, 상태 row가 있으면 64px까지
  강압축한다. Medium은 모든 높이에서 stage와 조작을 2열로 놓되 821px부터 canvas와 stage를
  `dvh`에 따라 점진적으로 키운다. Expanded 이상은 `≤640px`에서 2열로 놓는다. Fullscreen은
  `≤640px`에서 별도 축소하며 `≤320px`에서는 억지로 겹치지 않고
  세로 스크롤로 안전 조작에 도달하게 한다.
- 일반·긴 화면의 메트로놈 canvas는 `dvh`에 따라 높이와 원·진행 track 크기를 함께 보간하되
  일반 화면 340px, Wide 380px에서 멈춘다. 페이지의 가변 `1fr` stretch를 fullscreen에만
  남기고 일반 stage는 내용 기반 높이를 사용한다. 잉여 공간은 설정 패널 아래에 남겨
  `시각화 → BPM → 현재 마디 → 조작` 사이가 빈 화면으로 벌어지지 않게 한다.
- 소프트 키보드가 열린 폼에서는 `dvh` 감소를 따르고 하단 내비게이션을 숨기며 현재 입력과
  저장 버튼이 가려지지 않게 한다.
- 4K·초광폭에서는 콘텐츠를 무한 확대하지 않는다. 본문은 최대 75자 폭, 편집/대시보드
  영역은 최대 1440px, 메트로놈 시각화 핵심 폭은 최대 1100px로 제한한다.

기기 형태와 실행 환경:

- 데스크톱 split view와 모바일 multi-window는 기기 종류가 아니라 실제 CSS 폭으로 판단한다.
- foldable/dual-screen에서 hinge 정보를 제공하는 경우 핵심 재생 버튼·dialog를 hinge 위에 두지
  않고 한 segment 안에 배치한다. 정보가 없으면 Medium/Expanded 단일 열 규칙으로 안전하게
  fallback한다.
- TV·프로젝터·보면대 외부 모니터에서는 `Wide` 규칙과 원거리 모드를 사용한다. hover 없이
  방향키/Enter/Escape로 이동할 수 있고 focus ring을 더 강하게 표시한다.
- 설치형 PWA·Capacitor·브라우저는 같은 콘텐츠 위계를 유지하되, 브라우저 chrome 변화에는
  `dvh`, notch·Dynamic Island·home indicator에는 safe-area를 사용한다.
- 터치스크린 노트북과 펜 태블릿처럼 coarse/fine 입력이 함께 있으면 레이아웃은 폭으로,
  target 크기와 hover는 각각 `any-pointer`/`any-hover`로 결정한다.

## 3. 앱 셸과 내비게이션

- Compact 이하의 하단 탭은 `메트로놈`, `악보`, `앙상블`, `연습`, `더보기`다. 템포맵,
  튜너, 프로젝트, 캘리브레이션, 설정, 계정은 더보기 sheet와 각 맥락 CTA 양쪽에서 접근한다.
- Micro 하단 탭 라벨은 11px보다 작아지지 않으며 최대 두 줄 안에서 아이콘과 함께 읽혀야 한다.
- Medium 세로형은 하단 탭, 가로형과 Expanded는 아이콘+라벨 rail을 사용한다.
- Desktop 이상은 sidebar를 사용하고 현재 위치를 색뿐 아니라 배경·`aria-current`로 표시한다.
- 브라우저 topbar의 `← Bonifacio` 링크는 모든 route에서 유지하고 같은 탭으로 포트폴리오 홈을 연다. 최소 크기는 44px이며 coarse pointer에서는 48px이고, 좁은 폭에서는 앱 브랜드 대신 링크를 우선 표시한다. Capacitor 네이티브 shell에서는 숨긴다.
- AppShell grid는 하단 내비게이션 row를 본문 scrollport와 분리해 같은 공간을 점유하지 않게
  한다. 브라우저 200% 글자 확대 시 두 줄 라벨은 유지하되 높이는 Compact `64–96px`, Micro
  `60–88px`로 제한한다. 본문은 24px 하단 padding과 scroll padding만 두며 이미 예약된
  내비게이션 높이를 다시 더하지 않는다.
- 다크/라이트 해·달 버튼은 모든 폭의 topbar에 44px 이상으로 유지한다. Micro에서는 계정
  바로가기를 `더보기`에 맡기고 Bonifacio 링크를 화살표 44px로 축약해 테마와 설정 조작이
  겹치거나 잘리지 않게 한다.
- 본문 시작에 skip link를 제공하고 페이지 전환 시 새 `h1`으로 초점을 이동하거나 화면
  읽기 도구에 제목 변경을 알린다.
- 본문 scroller의 좌표는 history entry별로 기억해 뒤로/앞으로 탐색에서 복원하고, 새
  탐색은 맨 위에서 시작한다. browser POP은 모바일 더보기 dialog를 닫아 복원된 화면을
  가리지 않는다.

## 4. 화면별 적응 규칙

### 메트로놈

- 모든 폭에서 박 슬롯 → BPM → 현재 마디 → 재생 순서를 유지한다.
- 박 슬롯은 번호를 상시 표시하고 현재 박을 색·윤곽·크기로 중복 부호화한다. 4/4 기준
  Micro·짧은 landscape는 약 40px급, Wide는 128px 이상의 원 지름을 목표로 한다. 가용 폭에
  모든 박이 읽을 수 있는 크기로 들어오지 않으면 원을 계속 줄이거나 자르지 않고 현재 박을
  포함한 번호 window만 표시하며, 앞뒤의 남은 박은 생략 표시로 알린다.
- Compact/짧은 화면에서는 재생·탭템포·예비박을 엄지 도달 영역에 고정하고 고급 설정은
  접을 수 있는 sheet로 보낸다. stage는 고정 `height`가 아니라 내용 안전 `min-height`를
  사용해 현재/다음 상태와 조작이 겹치지 않아야 하며 재생 버튼을 보기 위해 페이지를
  스크롤하게 해서는 안 된다. 빠른 `시작 마디` 입력을 숨기는 배치에서는 같은 입력을 sheet
  안에 반드시 제공한다.
- Medium 이상에서는 박 슬롯과 재생 상태를 중심에 두고 설정을 하단 패널로 배치한다.
- 정지 상태에서도 `ResizeObserver`와 viewport resize로 canvas backing store와 박 좌표를 즉시
  갱신한다. 재생 시작을 resize 복구 수단으로 사용하지 않는다.
- 박자 select는 네이티브 indicator를 제거하고 select와 같은 상대좌표 wrapper 안에서 하나의
  chevron만 수직 중앙에 둔다. 압축된 Micro 폭의 BPM 단계 조작은 `-5 / 탭 / +5`로 줄여
  overflow를 방지하며 남아 있는 ±5 조작은 정확한 증감량, 탭 조작은 항상 `탭 템포`를
  접근성 이름으로 유지한다. 범위를 넘는 단계 조작은 20 또는 400으로 clamp하고 정확한
  경계에서는 해당 방향 버튼을 비활성화해 무반응으로 보이지 않게 한다. 강세는 내부 숫자 대신
  무음·보통·강박과 다음 상태를 이름으로 알리고, 예비박은 압축 배치에서도 `예비` 식별자를
  숨기지 않은 채 색과 `켬`/`끔` 글자로 상태를 중복 부호화한다. 탭 템포의 `다시 탭`과 누적
  횟수는 보이는 라벨과 별도 polite status에 동시에 제공한다.
- 풀스크린 보면대 모드는 화면 비율과 관계없이 박 슬롯, BPM, 마디, 예비박 숫자를 보존하며,
  더블 탭/`Escape` 모두로 종료할 수 있다. BPM 입력·템포맵 편집과 보조 문맥은 `inert`와
  `aria-hidden`으로 시각·포커스 양쪽에서 제외하고 설정 panel은 grid flow에서도 제거한다.
  fullscreen 표면 뒤의 topbar·sidebar·bottom navigation도 `inert`/`aria-hidden`으로 묶어
  보이지 않는 AppShell 조작으로 Tab focus가 빠지지 않게 한다.
  템포맵 상태가 나타나면 별도 row에 두어 stage의 가변 높이와 재생 조작을 밀거나 겹치지 않는다.
  일반 화면의 다열 배치와 카드 모서리를 상속하지 않고 `border-radius: 0`의 edge-to-edge 단일
  열로 재설정해 재생 버튼을 화면 중앙에 둔다.
  높이 640px 이하에서는 canvas·BPM·문맥을 연속적으로 줄이고, 320px 이하에서는 내부 스크롤로
  전환해 모든 안전 조작을 겹침 없이 보존한다.
- Micro/Compact는 높이 900px 이하에서 조작을 한 줄로 재배치하되 canvas는 700px 이하에서만
  84px(상태 row가 있으면 64px)까지 강압축한다. `600–839px`은 모든 높이에서 stage와 조작을
  2열로 나누며, 높이 820px 이하만 설정 sheet를 쓰고 821px부터 인라인 설정과 빠른 시작 마디를
  복원한다. 840px 이상은 820px 이하에서 stage를 줄인 뒤 640px 이하에서 2열로 바꾼다.
  압축·복원 경계 다음 픽셀인 `820/821`, `900/901`, `640/641`과 더 이상 전환점이 아닌
  `1180/1181`의 연속성을 검증한다. 설정 dialog가 열린 상태에서 `820→821` 또는 `900→901`로
  전환해 compact trigger가 숨겨지면, dialog를 닫은 뒤 새로 나타난 인라인 `시작 마디`로 focus를
  복구한다.
  한 줄·짧은 2열 조작의 시각·포커스 순서는 재생 → BPM 조절 → 빠른 설정이고
  `−5 / 탭 / +5`를 유지한다. 보이는 탭 라벨은 폭 419px 이하에서 `탭`, 폭 359px 이하이면서
  높이 900px 이하에서는 Gauge 아이콘만 남기지만 접근성 이름은 항상 `탭 템포`다. 일반
  Expanded/Desktop은 재생을 중앙에 두기 위해 시각적으로 BPM 조절 → 재생 → 빠른 설정을
  사용하되 DOM/포커스는 재생 우선을 유지한다. coarse pointer에서는 간격을 먼저 줄여
  재생·세 단계 BPM 조절·예비박과 상태 복구 조작의 48×48px 최소 target을 보존한다. 높이
  420px 이하에 상태 복구 row가 추가되면 폭 599px 이하는 canvas를 64px, 더 넓은 화면은
  80px로 줄이고 보조 BPM 단위·박자 또는 다음-구간 문구를 숨긴 뒤, 재생·BPM 조작을 row
  상단에 붙여 고정 내비게이션 위 첫 viewport 안에 유지한다. `359/390 × 420`에서는 상태,
  stage, 실제 조작 사각형이 본문 scrollport 경계를 넘지 않는지 직접 비교한다.

### 템포맵 편집기

- 마디 타임라인만 가로 스크롤한다. 페이지 헤더와 속성 폼에는 가로 스크롤이 없어야 한다.
- Compact는 `타임라인 → 구간 목록 → 선택 속성 → 이동 지시` 단계형 구조와 하단 저장 bar를
  사용한다. Expanded 이상은 타임라인 아래 속성/이동 지시 2패널을 사용한다.
- 표 모드는 CSS grid 모양만 낸 div가 아니라 native `table`·column header·row header로 구성한다.
- 반복·volta·D.C./D.S./Fine/Coda는 JSON이 아니라 이름, 범위, 패스가 표시되는 폼으로
  편집하며 전개 오류 위치와 해결 방법을 즉시 보여준다.
- 행 이동, 분할, 병합, 삭제는 키보드와 터치 모두 제공하며 삭제는 undo 또는 확인을 제공한다.
- 원격 템포맵을 network failure 후 현재 계정의 IndexedDB v3 snapshot으로 연 경우 편집·가져오기·
  저장을 잠그고 “오프라인 읽기 전용”·연결 재확인·내보내기를 노출한다.

### 동기 세션

- 참가 전 화면과 참가 후 무대 화면을 분리한다. 연결 중·재연결·오프라인·늦은 합류·권한 변경을
  서로 다른 상태로 표시한다.
- Compact에서는 참가자 목록을 접는 sheet로, 리더 transport는 하단 고정 bar로 둔다.
- 참가자는 읽기 전용이라는 사실과 예정된 시작 마디·revision을 큰 텍스트로 확인할 수 있다.
- ready/start/stop은 서버 roster/transport acknowledgment 또는 5초 timeout 전까지 pending으로 잠가
  중복 탭을 막는다. Clipboard API 실패 시 선택 가능한 read-only 초대 URL과 재시도를 보인다.

### 악보

- 악보가 viewport를 우선 점유하고 도구는 자동 숨김 overlay다. Compact는 하단 도구 sheet,
  펜 입력 기기는 측면 palette, Desktop은 접을 수 있는 inspector를 사용한다.
- 총보·파트보는 `tablist`/`tab`/`tabpanel`과 roving tab index를 사용하고, 화살표·Home·End로
  선택한다.
- 펜·매핑은 pointer capture한 현재 `pointerId`만 처리해 stylus 입력에 두 번째 손가락이 섞이지
  않게 하고, `pointercancel`에서 임시 입력을 폐기한다.
- 페이지 전환은 현재 마디 진행으로 자동 수행하되 사용자가 수동으로 이동하면 잠시 자동
  전환을 보류하고 복귀 CTA를 제공한다.
- PDF/이미지의 확대·이동은 악보 영역 안에서만 일어나며 앱 전체 가로 스크롤을 만들지 않는다.

### 대시보드·연습·설정

- 카드 grid는 Compact 1열, Medium 2열, Desktop 3열, Wide 4열이다.
- 표는 Compact에서 label/value 카드 행으로 바꾸며 핵심 동작을 overflow 메뉴에 숨기지 않는다.
- workspace leaf 요청은 최대 6개만 동시 실행하고, 일부가 실패해도 건강한 카드를 남기며
  누락 영역·개수·재시도를 상단에 안내한다. root 그룹 요청 실패만 전체 오류로 처리한다.
- 연습 로그 작성과 TODO 입력은 키보드가 열린 상태에서도 저장/취소가 보이도록 sticky action을
  사용한다. Markdown preview와 마디 anchor를 악보 링크로 제공한다.

### 튜너·캘리브레이션·로그인

- 튜너 음이름과 센트 값은 짧은 가로형에서도 동시에 보인다. 마이크 권한 거부 상태에는 OS별
  설정 안내와 재시도를 제공한다.
- 캘리브레이션은 한 화면에 한 단계만 보여주고 진행률, 취소, 다시 측정을 항상 제공한다.
- 로그인 폼은 암호 관리자와 자동 완성을 지원하고 오류를 필드 가까이 연결한다.
- SSO build는 local 이메일·비밀번호 폼을 노출하지 않는다. 중앙 session 확인 중에는 app content를 먼저 보이지 않고, network/provider 오류는 viewport 안의 설명과 44px 이상의 `중앙 세션 다시 확인` 동작으로 복구한다.

## 5. 검증 매트릭스

자동 반응형 smoke는 최소 아래 viewport에서 모든 주요 route를 검사한다.

| 용도 | viewport |
|---|---|
| 200% 확대 효과 폭 | `256 × 568` |
| 최소 Android/확대 경계 | `320 × 568` |
| 소형 iPhone | `375 × 667` |
| 현대 phone | `390 × 844` |
| 큰 phone | `430 × 932` |
| phone landscape | `667 × 375` |
| Compact 높이·폭 경계군 | `320/375/390/430/599 × 701`, `390/599/600/768/820 × 821` |
| Compact 압축 전환 | `599 × 900/901` |
| 작은 tablet portrait | `600 × 960` |
| tablet portrait | `768 × 1024` |
| Medium 경계·연속성 표본 | `839 × 820/840`, `839 × 1180/1181` |
| tablet landscape | `1024 × 768` |
| Expanded 짧은 경계 | `840/844/1024 × 390`, `840 × 420/421`, `840 × 640/641` |
| notebook | `1280 × 720` |
| desktop | `1440 × 900` |
| large desktop | `1920 × 1080` |
| 4K/초광폭 대표 | `2560 × 1440` |

현재 자동 matrix는 52개 viewport의 12개 주요 route 기본 상태에서 페이지 가로 overflow,
viewport 밖 이탈, primary CTA가 viewport 또는 한 번의 정상 세로 스크롤 안에 있는지, 44px
target, 고정 내비게이션 비가림과 새 route `h1` focus를 검사한다. 메트로놈의 기본 상태/조작
비겹침은 이 전체 matrix에서 확인하고, recovery banner는 폭별 압축 구간과
`420/421`, `820/821`, `900/901`, `640/641` 경계 표본에 주입한다. `1180/1181`은 Medium 배치가
두 픽셀 사이에서 연속적인지 별도 비교한다. Fullscreen은 상태 유무 양쪽을
12개 대표 크기에서, coarse pointer의 48px target은 16개 대표 크기에서 검사한다. 32px root
font 확대는 `390 × 600` 대표 context의 핵심 표시 묶음과 조작, `256 × 480`의 BPM dialog
및 `256/320/359/390/419 × 480`, `599 × 700`의 모바일 내비게이션·focus-scroll 경로에서
최초 focus 가시성을 확인하며, dialog focus trap, 키보드 widget 경로, empty/loading/error
변형은 별도 targeted spec에서 검증한다.

다크·라이트 자동 대비 검증은 primary/secondary/muted text의
background/surface/surface-raised 조합, accent의 background/surface 조합과
`--on-accent`/accent를 4.5:1 이상으로 확인한다. `--control-border`는
surface/surface-raised 대비, 고정 progress track은 background 대비를 3:1 이상으로 확인한다.
별도로 고대비/forced-colors, safe-area, 소프트 키보드, 오프라인/재연결을 수동 확인한다.
