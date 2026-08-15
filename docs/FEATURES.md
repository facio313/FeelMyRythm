# FeelMyRythm 구현 기능 카탈로그

함께 읽을 문서: [사용자 지침서](./USER_GUIDE.md) · [아키텍처와 코드 읽기 가이드](./ARCHITECTURE_AND_CODE_GUIDE.md) · [구현 회고](./IMPLEMENTATION_RETROSPECTIVE.md) · [운영 준비와 검증](./OPERATIONS.md)

이 문서는 현재 저장소에 실제로 구현된 기능을 사용자 화면, 핵심 동작, 구현 근거로 연결한
목록이다. [DESIGN.md](./DESIGN.md)나 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)의
계획 전체를 완료 목록으로 간주하지 않으며, 코드와 공개 테스트에서 확인되는 범위만 기록한다.

## 상태 표기

| 표기 | 의미 |
| --- | --- |
| **구현** | 현재 코드에 사용자 또는 API가 사용할 수 있는 경로가 있고 관련 테스트나 검증 코드가 있다. |
| **설정 필요** | 기능은 구현됐지만 OAuth, SMTP, S3 같은 외부 설정이 있어야 해당 경로를 사용할 수 있다. |
| **외부 검증 필요** | 앱 선언·빌드·분석 도구는 있으나 실기기나 실제 운영 인프라에서 최종 판정해야 한다. |
| **의도적 비범위** | 현재 아키텍처가 명시적으로 제공하지 않는 기능이다. 미완료 구현으로 오해하지 않는다. |

`구현`은 현재 소스의 구현 상태를 뜻한다. 실제 스토어 배포, 운영 계정 연결, 실기기 성능
기준까지 자동으로 보증한다는 뜻은 아니다.

## 한눈에 보기

| 영역 | 사용자가 얻는 기능 | 대표 화면·진입점 | 상태 |
| --- | --- | --- | --- |
| 메트로놈·오디오 | 템포맵을 오디오 시계로 정확하게 재생하고 BPM·박자·강세를 즉시 조절 | `/`, [MetronomePage.tsx](../apps/web/src/pages/MetronomePage.tsx) | 구현 |
| 템포맵 편집 | 구간, 박자, 템포 변화, 반복·이동 지시를 편집하고 revision 충돌을 해결 | `/editor`, [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx) | 구현 |
| 앙상블 동기 | 방 생성·참가, 준비 상태, 리더 시작·정지, 시계 오프셋 기반 로컬 동기 재생 | `/session`, [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx) | 구현 |
| 악보 | PDF·이미지·MusicXML 보기, 파트 전환, 마디 매핑, 필기, 재생 추적 | `/scores`, [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx) | 구현 |
| 연습 관리 | Markdown 일지, 마디 앵커, 담당자·마감일이 있는 할일 | `/practice`, [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx) | 구현 |
| 튜너·출력 보정 | 크로매틱 튜너와 장치별 클릭 출력 지연 측정·보정 | `/tuner`, `/calibration` | 구현 |
| 계정·협업 공간 | 이메일·Google 인증, 계정 삭제, 그룹·역할·프로젝트·레퍼토리 관리 | `/login`, `/dashboard`, `/settings` | 구현 / 설정 필요 |
| 오프라인·PWA | 로컬 연습 데이터, 계정별 서버 snapshot, 설치형 PWA와 안전한 캐시 이행 | 앱 시작 및 설정 | 구현 |
| 모바일 | 같은 웹 앱의 iOS·Android 래핑, 네이티브 저지연 오디오, 보안 저장소, 딥 링크, Keep Awake·햅틱 | [apps/mobile](../apps/mobile) | 구현 / 외부 검증 필요 |
| 반응형·접근성 | 256px부터 초광폭까지 재배치, 키보드·터치·펜·스크린 리더 경로 | 모든 화면 | 구현 |
| 서버·배포·검증 | REST/WS, PostgreSQL migration, 객체 생명주기, immutable ARM64 배포 게이트 | [apps/server](../apps/server), [.github](../.github) | 구현 / 외부 검증 필요 |

## 1. 메트로놈과 오디오 엔진

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 로컬 메트로놈 | 로그인하지 않아도 바로 재생하고 마지막 로컬 템포맵을 다시 사용한다. | 기본 템포맵으로 먼저 렌더링한 뒤 IndexedDB의 활성 로컬 맵을 읽으며, 로컬 설정 변경을 다시 저장한다. | [MetronomePage.tsx](../apps/web/src/pages/MetronomePage.tsx), [localDb.ts](../apps/web/src/lib/localDb.ts) |
| 즉시 템포 조절 | BPM 직접 입력, `-5/-1/+1/+5`, 탭 템포를 제공한다. BPM 범위는 20–400이다. | 연속 탭 간격의 중앙값으로 BPM을 계산하고 현재 구간만 갱신한다. | [MetronomePage.tsx](../apps/web/src/pages/MetronomePage.tsx), [MetronomePage.test.tsx](../apps/web/src/pages/MetronomePage.test.tsx) |
| 박자·강세·분할 클릭 | 박자, 각 박의 무음/보통/강박, 볼륨과 분할 클릭이 실제 클릭에 반영된다. | 템포 구간의 박 단위·강세 패턴·subdivision을 결정론적 beat 목록으로 전개한다. | [types.ts](../packages/core/src/types.ts), [timeline.ts](../packages/core/src/timeline.ts) |
| 예비박과 위치 시작 | 1·2마디 예비박을 선택하고 특정 마디와 반복 pass에서 시작할 수 있다. | 템포맵을 먼저 완전 전개하고 `seekPoint`와 `buildCountIn`으로 같은 진입점을 계산한다. | [timeline.ts](../packages/core/src/timeline.ts), [useMetronome.ts](../apps/web/src/lib/useMetronome.ts) |
| 결정론적 진행 | rit./accel., 못갖춘마디, 반복·volta, D.C., D.S., Fine, Coda를 실제 연주 순서로 재생한다. | 순수 TypeScript 코어가 마디 방문 순서와 절대 타임라인을 만들고 무한 진행을 상한으로 차단한다. | [timeline.ts](../packages/core/src/timeline.ts), [timeline.test.ts](../packages/core/test/timeline.test.ts) |
| 오디오 우선 스케줄링 | UI 부하가 있어도 클릭을 Web Audio 시각에 미리 예약한다. 강박·평박·분할·예비박 음색이 구분된다. | 미리 만든 `AudioBuffer`와 Worker tick 기반 lookahead scheduler를 사용하며 예약된 source를 정지·교체할 수 있다. | [scheduler.ts](../packages/audio/src/scheduler.ts), [webAudioEngine.ts](../packages/audio/src/webAudioEngine.ts), [scheduler.test.ts](../packages/audio/test/scheduler.test.ts) |
| 오디오 기준 시각화 | 박 표시와 현재 마디가 오디오 시계에 맞춰 움직이고 시각 오프셋만 별도 보정할 수 있다. | 예약 beat queue를 `requestAnimationFrame`에서 읽는다. 시각 오프셋은 클릭 시각을 바꾸지 않는다. | [useMetronome.ts](../apps/web/src/lib/useMetronome.ts), [BeatVisualizer.tsx](../packages/ui/src/BeatVisualizer.tsx) |
| 보면대 모드 | 전체화면에서 핵심 박·BPM·마디를 크게 보고 버튼 또는 빈 영역 더블 탭으로 나간다. | Fullscreen API 오류를 사용자에게 알리고 터치 대상 위의 더블 탭은 종료 제스처로 오인하지 않는다. | [MetronomePage.tsx](../apps/web/src/pages/MetronomePage.tsx) |
| 재생 전원 생명주기 | 재생 중 화면 꺼짐을 억제하고 정지·자연 종료·화면 이탈 때 해제한다. 네이티브에서는 박 햅틱도 제공한다. | 브라우저 Wake Lock과 native bridge를 하나의 재생 생명주기로 묶고 중복 해제를 방지한다. | [wakeLock.ts](../packages/audio/src/wakeLock.ts), [useMetronome.ts](../apps/web/src/lib/useMetronome.ts), [nativeBridge.ts](../apps/mobile/src/nativeBridge.ts) |

## 2. 템포맵 편집기

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 로컬·프로젝트 맵 편집 | 로컬 맵은 기기에, 프로젝트 맵은 서버 revision으로 저장한다. | 로그인·레퍼토리 문맥에 따라 IndexedDB 또는 REST 저장 경로를 선택한다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [repertoire.py](../apps/server/app/routers/repertoire.py) |
| 곡 전체 설정 | 총 마디 수, 예비박 1·2마디, 못갖춘마디와 박 수를 편집한다. | 전체 구간의 연속 범위를 유지하며 마디 수 변경 시 구간과 이동 지시를 재검증한다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [validation.ts](../packages/core/src/validation.ts) |
| 구간 편집 | 구간 이름, BPM, 시작·끝 마디, 박자, 박 단위, 분할 클릭, 강세, rit./accel. 목표 BPM을 편집한다. | 필드별 오류를 코어 validation path에 연결하고 유효한 맵만 저장·전개한다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [validation.ts](../packages/core/src/validation.ts) |
| 구간 구조 조작 | 구간 순서 변경, 나누기, 이전 구간과 합치기, 삭제 후 실행 취소를 제공한다. | 모든 조작이 마디 범위의 빈틈·중복을 만들지 않도록 인접 경계를 함께 갱신한다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [EditorPage.test.tsx](../apps/web/src/pages/EditorPage.test.tsx) |
| 반복·이동 지시 | 반복 횟수와 volta pass, D.C./D.S., al Fine, al Coda, To Coda를 폼으로 편집한다. | jump directive를 타입별 필드로 입력받아 실제 타임라인까지 전개한 뒤 오류를 표시한다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [types.ts](../packages/core/src/types.ts) |
| 타임라인·표 보기 | 마디 타임라인 확대·축소와 native table 기반 구간 목록을 제공한다. | 표의 행·열 header와 선택 버튼을 유지해 키보드 및 화면 읽기 도구가 구조를 인식한다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [ux-accessibility.spec.ts](../e2e/ux-accessibility.spec.ts) |
| JSON 이동성 | 검증된 템포맵 JSON을 가져오고 현재 맵을 파일로 내보낸다. | 가져오기 때 schema와 실제 timeline 전개를 모두 확인하며 오프라인 원격 사본에서는 가져오기를 잠근다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx) |
| revision 충돌 해결 | 다른 사용자가 먼저 저장하면 서버 최신본 사용 또는 내 초안 재기준을 명시적으로 선택한다. 같은 revision의 다른 내용도 자동 덮어쓰지 않는다. | `expectedRevision` 불일치는 409이며, 로컬·서버 내용 fingerprint를 비교해 사용자 선택 전까지 충돌 상태를 보존한다. | [tempoMapMerge.ts](../apps/web/src/lib/tempoMapMerge.ts), [repertoire.py](../apps/server/app/routers/repertoire.py), [tempoMapMerge.test.ts](../apps/web/src/lib/tempoMapMerge.test.ts) |
| 저장 전 이탈 보호 | 변경 중 다른 화면이나 브라우저 종료로 이동하면 계속 편집, 버리고 이동, 저장 후 이동을 선택한다. | React Router blocker와 `beforeunload`를 함께 사용하고 저장 성공 뒤에만 이동한다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [EditorPage.test.tsx](../apps/web/src/pages/EditorPage.test.tsx) |
| 안전한 오프라인 fallback | 네트워크 실패 때만 현재 계정의 마지막 서버 사본을 읽기 전용으로 열고, 편집·가져오기·저장은 잠근다. | 인증·권한·404·409·검증·서버 오류는 캐시로 숨기지 않는다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [localDb.ts](../apps/web/src/lib/localDb.ts) |

## 3. 앙상블 동기 세션

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 방 생성·참가 | owner/leader가 템포맵이 있는 레퍼토리로 방을 열고, 다른 멤버는 6자리 방 코드 또는 UUID 초대 링크로 참가한다. | 방 생성 시 최신 템포맵 revision과 총 마디 수를 고정하고, UUID `roomId`와 구두 공유용 6자리 `joinCode`를 함께 발급한다. REST는 둘 다 조회하고 WS는 canonical UUID를 사용한다. | [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx), [rooms.py](../apps/server/app/routers/rooms.py), [join_codes.py](../apps/server/app/join_codes.py), [session.spec.ts](../e2e/session.spec.ts) |
| 초대 링크 fallback | 클립보드 복사가 불가능하거나 거부되면 선택 가능한 읽기 전용 URL과 재시도를 표시한다. | Clipboard API 성공·실패를 분리하고 실패를 성공 알림으로 위장하지 않는다. | [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx), [SessionPage.test.tsx](../apps/web/src/pages/SessionPage.test.tsx) |
| 참가자·준비 상태 | 이름, 역할, RTT, 보정 여부, Bluetooth 여부, ready 상태를 보고 자신의 준비 상태를 전환한다. | roster를 WS broadcast하고 모바일에서는 참가자 목록을 dialog로 제공한다. | [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx), [rooms.py](../apps/server/app/rooms.py) |
| 리더 transport | 리더가 시작 마디·pass·예비박을 정해 3초 뒤 시작하거나 정지·seek한다. 멤버에게는 읽기 전용 상태가 보인다. | 서버가 역할을 매 명령마다 갱신하고 `armed/playing/stopped` transport anchor를 broadcast한다. | [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx), [ws.py](../apps/server/app/ws.py) |
| 중복 명령 방지 | ready/start/stop을 누른 뒤 서버 응답 또는 5초 timeout 전까지 관련 조작을 잠근다. | roster/transport 변화가 보낸 명령과 일치할 때 pending을 해제한다. | [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx), [SessionPage.test.tsx](../apps/web/src/pages/SessionPage.test.tsx) |
| 시계 동기 | 화면에 RTT와 offset을 표시하고 합의한 서버 시작 시각을 각 기기의 performance/audio clock으로 변환한다. | 10개 초기 PING 표본에서 최소 RTT 기준 offset을 잡고 이후 outlier 제한과 완만한 drift 보정을 적용한다. | [clock-sync.ts](../packages/core/src/clock-sync.ts), [roomClient.ts](../apps/web/src/lib/roomClient.ts), [clock-sync.test.ts](../packages/core/test/clock-sync.test.ts) |
| 박 비스트리밍 | 서버가 각 박을 보내지 않아도 모든 기기가 고정 revision을 내려받아 같은 로컬 타임라인을 전개한다. | WS는 revision, transport anchor, 절대 서버 시각만 합의하며 클릭 예약은 각 client의 Web Audio 엔진이 수행한다. | [main.py](../apps/server/app/main.py), [useMetronome.ts](../apps/web/src/lib/useMetronome.ts) |
| 재연결·늦은 합류 | 네트워크 단절 중 이미 시작한 로컬 오디오는 계속되고, 복구 후 다음 마디 경계에서 다시 합류한다. 인증 거부는 토큰을 한 번만 갱신한다. | terminal close code와 network reconnect를 분리하고 ClockSync를 재초기화한다. | [roomClient.ts](../apps/web/src/lib/roomClient.ts), [roomClient.test.ts](../apps/web/src/lib/roomClient.test.ts) |
| 자연 종료 정리 | 템포맵의 마지막 박이 끝나면 로컬 전원을 해제하고 리더는 서버 transport도 정지시킨다. | scheduler의 `onEnded`와 세션 리더의 transport 상태 감시를 연결한다. | [useMetronome.ts](../apps/web/src/lib/useMetronome.ts), [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx) |

## 4. 악보, MusicXML, 마디 매핑과 필기

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 악보 형식 | PDF, 일반 이미지, MusicXML/XML/MXL을 가져와 화면에서 본다. | PDF.js, 이미지 element, lazy-loaded OpenSheetMusicDisplay 경로를 형식별로 사용하고 렌더 오류와 재시도 가능한 상태를 표시한다. | [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [musicxml.ts](../apps/web/src/lib/musicxml.ts), [scores.spec.ts](../e2e/scores.spec.ts) |
| 로컬·프로젝트 저장 | 비로그인 악보는 IndexedDB에, 프로젝트 악보는 서버 객체 저장소에 저장한다. 업로드·삭제·정보 수정은 leader 이상만 가능하다. | UI의 access role 제한과 서버의 권한 검사를 모두 적용한다. | [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [scores.py](../apps/server/app/routers/scores.py) |
| 안전한 원격 업로드 | 프로젝트 업로드는 staging URL에 직접 전송한 뒤 complete하고, 준비 완료 전 악보는 목록에서 숨긴다. | complete가 staging 객체를 final key로 promote하고 DB 상태와 staging 삭제 outbox를 transaction으로 확정한다. | [scoreApi.ts](../apps/web/src/lib/scoreApi.ts), [scores.py](../apps/server/app/routers/scores.py), [storage_lifecycle.py](../apps/server/app/storage_lifecycle.py) |
| MusicXML 템포맵 초안 | MusicXML에서 제목, 마디 수, 박자, 템포, 못갖춘마디, 반복·volta·D.C./D.S./Fine/Coda를 분석하고 경고와 함께 검토 후 저장한다. | 원격 파일은 defused XML parser와 MXL 크기·압축비 제한을 거치며, 로컬 파일에도 간이 초안 경로가 있다. | [musicxml.py](../apps/server/app/musicxml.py), [scoreApi.ts](../apps/web/src/lib/scoreApi.ts), [test_musicxml_parser.py](../apps/server/tests/test_musicxml_parser.py) |
| 총보·파트보 | 총보/파트 종류와 악기 이름을 저장하고 tablist에서 화살표·Home·End로 파트를 전환한다. | roving tab index와 tabpanel 관계를 제공하고 현재 canonical 마디를 파트 간 유지한다. | [ScorePartTabs.tsx](../apps/web/src/pages/scores/ScorePartTabs.tsx), [scorePartNavigation.ts](../apps/web/src/pages/scores/scorePartNavigation.ts), [scores.spec.ts](../e2e/scores.spec.ts) |
| 마디 매핑 | PDF·이미지의 한 단을 드래그하고 마디 경계를 찍거나, 키보드로 정규화 좌표를 입력해 영역을 만든다. | 좌표를 확대율과 무관한 0–1 page surface로 저장하고 현재 `pointerId`만 pointer capture한다. | [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [scoreGeometry.ts](../apps/web/src/pages/scores/scoreGeometry.ts), [useScoreSurfaceGestures.ts](../apps/web/src/pages/scores/useScoreSurfaceGestures.ts), [scoreApi.ts](../apps/web/src/lib/scoreApi.ts) |
| 마디 번호 보정 | 파트보의 인쇄 마디와 곡의 canonical 마디가 다르면 공통 offset을 저장한다. | Score metadata와 MeasureMap을 하나의 `/settings` 요청과 transaction으로 revision 검증해 저장한다. | [scoreApi.ts](../apps/web/src/lib/scoreApi.ts), [scores.py](../apps/server/app/routers/scores.py), [test_permissions_revision.py](../apps/server/tests/test_permissions_revision.py) |
| 필기 | 펜, 텍스트, 기호를 페이지 또는 마디에 두고 나만 보기/프로젝트 공유 범위를 선택한다. | 필기별 revision 충돌을 검사하며 작성자 또는 리더 권한에 따라 수정·삭제한다. | [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [ScoreOverlay.tsx](../apps/web/src/pages/scores/ScoreOverlay.tsx), [scores.py](../apps/server/app/routers/scores.py) |
| 마디 필기 재투영 | 한 파트에 만든 마디 앵커 텍스트·기호를 다른 파트의 같은 canonical 마디 위치에도 표시한다. 페이지 좌표 필기는 원래 악보에만 보인다. | 레퍼토리 전체 annotation을 읽고 대상 파트의 MeasureMap으로 좌표를 다시 계산한다. | [scoreVisibility.ts](../apps/web/src/pages/scores/scoreVisibility.ts), [scoreApi.ts](../apps/web/src/lib/scoreApi.ts) |
| 악보에서 재생 | 현재 마디부터 템포맵을 재생하고 매핑된 페이지와 마디를 따라간다. | 수동 페이지 이동은 auto-follow를 끄고 `재생 위치로 돌아가기`를 제공한다. | [ScoreStage.tsx](../apps/web/src/pages/scores/ScoreStage.tsx), [useMetronome.ts](../apps/web/src/lib/useMetronome.ts) |
| 연습 메모 연계 | 악보 위에서 연습일지 앵커를 보고 현재 마디의 Markdown 메모를 읽는다. | 레퍼토리 로그의 score/page/measure anchor를 현재 MeasureMap에 투영한다. | [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx) |
| 원격 오프라인 읽기 | network failure 때 마지막으로 성공한 악보·마디맵·필기를 열어 연습할 수 있지만 서버 데이터 수정은 잠긴다. | 계정별 IndexedDB snapshot을 사용하며 HTTP 오류는 오래된 사본으로 대체하지 않는다. | [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [localDb.ts](../apps/web/src/lib/localDb.ts) |

## 5. 연습일지와 할일

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| Markdown 일지 | 작성/미리보기를 전환해 연습 메모를 저장하고 작성자와 시간을 본다. | 비로그인은 localStorage, 로그인 프로젝트는 REST와 DB에 저장한다. | [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx), [MarkdownContent.tsx](../apps/web/src/components/MarkdownContent.tsx) |
| 마디 앵커 | 일지에 선택적으로 마디 번호를 연결하고 한 번에 해당 악보·마디로 이동한다. | 앵커가 같은 레퍼토리의 score만 참조하도록 서버가 검증하며, query parameter로 악보와 메트로놈 진입점을 전달한다. | [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx), [repertoire.py](../apps/server/app/routers/repertoire.py) |
| 팀 할일 | 일지마다 내용, 담당자, 마감일을 추가하고 완료/미완료를 전환한다. | owner/leader 또는 생성자·담당자 권한을 UI와 API에서 검사한다. | [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx), [practiceApi.ts](../apps/web/src/lib/practiceApi.ts), [repertoire.py](../apps/server/app/routers/repertoire.py) |
| 안전한 삭제 | 자신이 쓴 일지 또는 리더 권한이 있는 일지를 확인 dialog 뒤 삭제한다. | 일지 삭제 시 하위 todo 관계도 DB 모델의 생명주기를 따른다. | [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx), [models.py](../apps/server/app/models.py) |
| 오프라인 snapshot | network failure 때 현재 계정의 마지막 일지·할일을 읽기 전용으로 표시하고 재연결을 제공한다. | 서버 성공 응답을 userId별 IndexedDB store에 함께 snapshot한다. | [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx), [localDb.ts](../apps/web/src/lib/localDb.ts) |

## 6. 튜너와 출력 지연 보정

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 크로매틱 튜너 | 음이름·옥타브, ±50 cent, Hz, 명료도를 실시간으로 표시한다. | AudioWorklet이 4096 sample frame을 수집하고 순수 TS YIN + 5개 중앙값 안정화로 50–2000Hz 단음을 분석한다. | [TunerPage.tsx](../apps/web/src/pages/TunerPage.tsx), [tuner.ts](../packages/audio/src/tuner.ts), [tuner.test.ts](../packages/audio/test/tuner.test.ts) |
| 기준음 선택 | A4 415·430·440·442·443Hz를 버튼과 키보드 화살표/Home/End로 선택하고 기기에 기억한다. | ARIA radiogroup과 roving tab index를 사용하며 기준 변경 시 안정화 window를 초기화한다. | [TunerPage.tsx](../apps/web/src/pages/TunerPage.tsx), [TunerPage.test.tsx](../apps/web/src/pages/TunerPage.test.tsx) |
| 마이크 오류 복구 | 권한 거부·미지원 상태를 안내하고 같은 화면에서 다시 시도한다. | start generation으로 늦게 도착한 권한 응답이 이미 중지한 engine을 되살리지 못하게 한다. | [TunerPage.tsx](../apps/web/src/pages/TunerPage.tsx), [tuner.ts](../packages/audio/src/tuner.ts) |
| 탭 캘리브레이션 | 9번의 클릭을 듣고 탭하며 첫 적응 표본을 제외한 8개의 중앙값으로 지연을 계산한다. | AudioContext output latency를 고려한 예상 audible time과 `performance.now()` 차이를 저장한다. | [CalibrationPage.tsx](../apps/web/src/pages/CalibrationPage.tsx), [calibration.ts](../packages/core/src/calibration.ts) |
| 장치별 보정 | 출력 이름과 기기 fingerprint별 보정값을 로컬에 저장하고, 로그인 시 서버와 병합한다. 재생 예약 시 양수 offset만큼 앞당긴다. | 서버 calibration CRUD와 IndexedDB 사본을 제공하며 서버 sync 실패에도 로컬 저장을 유지한다. | [CalibrationPage.tsx](../apps/web/src/pages/CalibrationPage.tsx), [calibrations.py](../apps/server/app/routers/calibrations.py) |
| 무선 출력 경고 | 출력 장치 이름으로 Bluetooth 가능성을 감지하고 이름이 가려지면 사용자가 직접 무선 출력을 표시한다. 세션에도 상태를 보낸다. | `enumerateDevices`, permission 재확인, `devicechange`를 처리하고 감지 불가와 미감지를 구분한다. | [CalibrationPage.tsx](../apps/web/src/pages/CalibrationPage.tsx), [SessionPage.tsx](../apps/web/src/pages/SessionPage.tsx) |

## 7. 인증, 계정과 협업 공간

### 인증과 계정

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 이메일 가입 | 첫 화면에서는 이름·이메일만 제출하고, 메일 링크를 연 뒤 새 비밀번호를 정해야 계정이 완성된다. 인증 메일 재전송도 제공한다. | 인증 전 password hash를 만들지 않고 최신 generation의 만료 token만 허용한다. cooldown 시각은 SMTP enqueue 전에 commit한다. | [LoginPage.tsx](../apps/web/src/pages/LoginPage.tsx), [auth.py](../apps/server/app/routers/auth.py), [test_auth.py](../apps/server/tests/test_auth.py) |
| 이메일·비밀번호 로그인 | 검증된 계정으로 로그인하고 원래 요청한 화면으로 돌아간다. | 존재하지 않음·미검증·Google-only 경로에도 dummy bcrypt를 수행하고 동시 verifier 수를 제한한다. | [LoginPage.tsx](../apps/web/src/pages/LoginPage.tsx), [security.py](../apps/server/app/security.py) |
| 비밀번호 재설정 | 계정 존재 여부를 노출하지 않는 요청 화면과 만료 링크의 새 비밀번호 설정 화면을 제공한다. | 재설정 성공 시 auth generation을 올리고 기존 refresh session을 모두 폐기한다. | [LoginPage.tsx](../apps/web/src/pages/LoginPage.tsx), [auth.py](../apps/server/app/routers/auth.py) |
| Google 로그인 | 설정된 웹 배포에서는 Google ID credential로 로그인·가입한다. 미검증 password 선점 계정은 확인된 Google identity가 안전하게 인수한다. | Google subject·정규화 email 충돌은 409이며 Capacitor WebView에서는 웹 GIS 버튼을 숨긴다. | [GoogleSignInButton.tsx](../apps/web/src/components/GoogleSignInButton.tsx), [auth.py](../apps/server/app/routers/auth.py) |
| 토큰 갱신 | access token 만료 시 요청을 한 번 갱신해 재시도하며 동시 refresh를 합친다. 일시적 network/5xx 오류는 현재 로그인 정보를 지우지 않는다. | access/refresh JWT, refresh rotation, 사용자 auth generation, client single-flight와 generation guard를 함께 사용한다. refresh endpoint의 401만 세션을 폐기한다. | [api.ts](../apps/web/src/lib/api.ts), [security.py](../apps/server/app/security.py), [api.test.ts](../apps/web/src/lib/api.test.ts) |
| 원자적 client session | token과 user가 한 envelope로 저장돼 한쪽만 이전 계정 값인 상태를 만들지 않는다. | browser는 localStorage, native는 platform secure storage를 같은 비동기 인터페이스로 사용한다. | [auth.tsx](../apps/web/src/lib/auth.tsx), [secureStorage.ts](../apps/mobile/src/secureStorage.ts) |
| 계정 삭제 | 설정에서 이메일과 현재 비밀번호 또는 fresh Google/email proof를 확인한 뒤 영구 삭제한다. 앱 밖에서도 `/delete-account`에서 절차를 시작할 수 있다. | 이메일 proof는 URL fragment에서 즉시 제거해 메모리에만 두고 올바른 계정 id·email이 맞은 경우에만 modal을 재개한다. | [SettingsPage.tsx](../apps/web/src/pages/SettingsPage.tsx), [AccountDeletionPage.tsx](../apps/web/src/pages/AccountDeletionPage.tsx), [accountDeletionChallenge.ts](../apps/web/src/lib/accountDeletionChallenge.ts) |
| 삭제 생명주기 | 소유 그룹·프로젝트·악보와 개인 데이터를 삭제하고, 공유 감사 참조에는 `Deleted user` tombstone만 남긴다. | 탈퇴 transaction이 score 객체 삭제 outbox를 함께 기록하고 refresh session, 멤버십, 개인 필기·일지·보정을 정리한다. | [auth.py](../apps/server/app/routers/auth.py), [test_account_deletion.py](../apps/server/tests/test_account_deletion.py) |
| 메일 전달 경계 | 인증·reset·탈퇴 메일을 요청 thread 밖에서 전송한다. | 고정 worker 수와 bounded queue, STARTTLS/SSL SMTP adapter를 사용하고 실패 로그에 이메일·서명 URL을 남기지 않는다. | [mailer.py](../apps/server/app/mailer.py), [test_mail_delivery.py](../apps/server/tests/test_mail_delivery.py) |

Google 로그인과 실제 메일 발송은 각각 OAuth client ID와 SMTP 설정이 필요한 **설정 필요**
기능이다.

### 그룹, 프로젝트와 레퍼토리

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 협업 계층 | 그룹 아래 프로젝트, 프로젝트 아래 레퍼토리를 만들고 이름·작곡가를 수정하거나 삭제한다. | REST CRUD와 DB 관계를 제공하며 삭제되는 하위 악보 객체를 outbox에 함께 기록한다. | [DashboardPage.tsx](../apps/web/src/pages/DashboardPage.tsx), [groups.py](../apps/server/app/routers/groups.py), [repertoire.py](../apps/server/app/routers/repertoire.py) |
| 역할 | owner, leader, member를 구분한다. owner는 그룹·멤버, leader 이상은 프로젝트·레퍼토리·악보·템포맵·세션을 관리한다. | 공용 access helper를 모든 서버 route에서 사용하고 UI도 `/access`와 `myRole`로 관리 조작을 선제 제한한다. | [access.py](../apps/server/app/access.py), [DashboardPage.tsx](../apps/web/src/pages/DashboardPage.tsx) |
| 멤버 초대·관리 | owner가 가입·이메일 검증을 마친 사용자 이메일로 초대하고 leader/member 역할을 변경하거나 내보낸다. owner 자신은 변경·제거할 수 없다. | email 정규화와 중복 membership, verified/active 상태를 서버에서 검증한다. | [DashboardPage.tsx](../apps/web/src/pages/DashboardPage.tsx), [groups.py](../apps/server/app/routers/groups.py) |
| 부분 실패 workspace | 일부 그룹의 멤버·프로젝트·레퍼토리 요청이 실패해도 성공한 항목은 유지하고 누락 영역 재시도를 제공한다. | `/groups`만 root 권위 요청으로 두고 leaf 요청을 최대 6개 동시 실행해 `allSettled` 결과를 조립한다. | [workspace.ts](../apps/web/src/lib/workspace.ts), [workspace.test.ts](../apps/web/src/lib/workspace.test.ts) |
| 비로그인 프로젝트 안내 | 로컬 템포맵과 로컬 연습은 유지하면서 로그인 시 열리는 공유 기능을 별도 CTA로 설명한다. | 인증 여부에 따라 remote workspace를 요청하지 않고 local IndexedDB 목록을 표시한다. | [DashboardPage.tsx](../apps/web/src/pages/DashboardPage.tsx) |

## 8. 오프라인, PWA와 모바일

### 오프라인·PWA

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| 로컬 연습 데이터 | 비로그인 템포맵·악보·마디맵·필기·보정을 기기에 보존한다. | IndexedDB schema와 practice localStorage를 사용하며 서버 없이 CRUD할 수 있다. | [localDb.ts](../apps/web/src/lib/localDb.ts), [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx) |
| 계정별 remote snapshot | 마지막 성공한 템포맵·악보·마디맵·필기·연습일지를 `userId`별로 분리한다. | IndexedDB v3 복합 키를 사용하고 소유자를 알 수 없는 v1/v2 원격 행은 migration에서 폐기한다. | [localDb.ts](../apps/web/src/lib/localDb.ts), [localDb.test.ts](../apps/web/src/test/localDb.test.ts) |
| 보수적 fallback | 실제 network failure에서만 snapshot을 읽고 편집은 잠근다. | 권한·인증·404·409·422·5xx를 cache hit로 숨기지 않는 화면별 분기를 둔다. | [EditorPage.tsx](../apps/web/src/pages/EditorPage.tsx), [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [PracticePage.tsx](../apps/web/src/pages/PracticePage.tsx) |
| 설치형 PWA | 고정 app id/scope/start URL, 한국어 metadata, 일반·maskable icon, Apple touch icon으로 설치한다. | Vite PWA manifest와 Workbox precache/runtime cache를 생성한다. PDF·OSMD chunk와 public image/font만 runtime cache한다. | [vite.config.ts](../apps/web/vite.config.ts), [public](../apps/web/public) |
| 인증 API 비캐시 | Service Worker와 nginx가 `/api/*` 응답을 저장하지 않는다. | navigation fallback denylist와 origin/path runtime filter, nginx `no-store` 정책을 함께 둔다. | [vite.config.ts](../apps/web/vite.config.ts), [nginx.conf](../nginx/nginx.conf) |
| 구형 PWA 안전 이행 | 앱을 보여주기 전에 과거 `fmr-api` 캐시를 삭제하고 안전 generation worker의 제어권과 구형 worker 종료를 확인한다. 증명할 수 없으면 시작을 중단하고 재시도 화면만 보인다. | 교체 전·후 두 번 민감 cache 부재를 확인하는 fail-closed bootstrap을 사용한다. | [pwaCache.ts](../apps/web/src/lib/pwaCache.ts), [main.tsx](../apps/web/src/main.tsx), [pwa-upgrade.pwa.ts](../e2e/pwa-upgrade.pwa.ts) |
| 테마·저장 공간 | 다크/라이트 테마, 메트로놈 기본값, 시각 오프셋, 브라우저 저장 공간 사용량을 설정한다. | `data-theme`, theme-color, native SystemBars를 함께 갱신하고 Storage Estimate 미지원·오류를 구분한다. | [SettingsPage.tsx](../apps/web/src/pages/SettingsPage.tsx), [theme.ts](../apps/web/src/lib/theme.ts) |

### Capacitor 모바일 경계

| 기능 | 사용자에게 보이는 동작 | 구현 내용 | 근거 |
| --- | --- | --- | --- |
| iOS·Android shell | 같은 React 앱이 iOS·Android 네이티브 프로젝트에서 실행된다. | Capacitor 8 프로젝트와 mobile 전용 상대 base 빌드, 동기화 후 참조 자산 검증 script가 있다. | [capacitor.config.ts](../apps/mobile/capacitor.config.ts), [package.json](../apps/mobile/package.json), [verify-web-assets.mjs](../apps/mobile/scripts/verify-web-assets.mjs) |
| 웹·API 원점 분리 | WebView local origin에서는 상대 UI 자산을 쓰되 REST/WS는 운영 `https://bonifacio.work`로 연결한다. | Vite mobile mode와 path helper가 UI base와 server origin을 별도 계산한다. | [vite.config.ts](../apps/web/vite.config.ts), [paths.ts](../apps/web/src/lib/paths.ts) |
| 네이티브 보안 저장 | native 인증 envelope는 WebView localStorage가 아니라 iOS Keychain 또는 Android Keystore 보호 저장소에 둔다. | 공용 TypeScript plugin contract와 Swift/Java 구현이 있으며 Android backup·data extraction을 차단한다. | [secureStorage.ts](../apps/mobile/src/secureStorage.ts), [SecureStoragePlugin.swift](../apps/mobile/ios/App/App/SecureStoragePlugin.swift), [SecureStoragePlugin.java](../apps/mobile/android/app/src/main/java/work/bonifacio/feelmyrythm/SecureStoragePlugin.java) |
| 딥 링크 | custom URL과 제한된 HTTPS 링크로 방, 가입 완료, reset, 탈퇴 proof 화면을 연다. | 허용 host·정확한 route·fragment key를 allowlist하고 query, 복수 credential, 신뢰하지 않는 origin을 거부한다. | [deepLink.ts](../apps/mobile/src/deepLink.ts), [deepLink.test.ts](../apps/mobile/src/deepLink.test.ts) |
| 네이티브 저지연 오디오 | 재생을 시작하면 WebView가 중단돼도 전체 클릭 타임라인이 네이티브 오디오 clock에서 계속된다. | iOS는 AVAudioEngine queue와 playback session을, Android는 Oboe low-latency stream과 mediaPlayback foreground service를 사용한다. 정지·교체·자연 종료를 공용 adapter로 되돌린다. | [nativeAudio.ts](../apps/mobile/src/nativeAudio.ts), [NativeAudioPlugin.swift](../apps/mobile/ios/App/App/NativeAudioPlugin.swift), [NativeAudioPlugin.java](../apps/mobile/android/app/src/main/java/work/bonifacio/feelmyrythm/NativeAudioPlugin.java) |
| 네이티브 기능 bridge | 재생 중 Keep Awake, 박별 햅틱, 테마별 system bar, cold/live deep link를 웹 코드가 한 인터페이스로 호출한다. | 플랫폼 지원 실패가 웹 UI 전체를 막지 않도록 best-effort 경계를 둔다. | [nativeBridge.ts](../apps/mobile/src/nativeBridge.ts) |
| 서명 빌드 진입점 | 환경변수가 없으면 실패하는 iOS archive와 Android App Bundle script를 제공한다. | signing asset과 password를 저장소 밖에 두고 플랫폼별 검증 뒤 sync/build한다. | [archive-ios.sh](../apps/mobile/scripts/archive-ios.sh), [verify-android-signing.mjs](../apps/mobile/scripts/verify-android-signing.mjs), [README.md](../apps/mobile/README.md) |

네이티브 shell과 빌드 경계는 구현됐지만 서명 archive 설치, Universal/App Link 검증,
무음·잠금·백그라운드 동작은 **외부 검증 필요** 항목이다.

## 9. 반응형 UX와 접근성

| 기능 | 구현된 동작 | 근거 |
| --- | --- | --- |
| 폭·높이 적응 | 256px 유효 폭부터 2560px 초광폭, 짧은 가로 화면, safe area와 `dvh`에 맞춰 1열·rail·sidebar 구조를 전환한다. | [RESPONSIVE_UX.md](./RESPONSIVE_UX.md), [index.css](../apps/web/src/index.css), [responsive.spec.ts](../e2e/responsive.spec.ts) |
| 모바일 내비게이션 | 메트로놈·악보·앙상블·연습과 더보기의 하단 내비게이션을 제공하고 더보기 dialog에 편집기·튜너·프로젝트·보정·설정을 둔다. | [AppShell.tsx](../apps/web/src/components/AppShell.tsx) |
| 터치 타깃과 overflow | 핵심 조작은 최소 44px, `any-pointer: coarse`의 공용 input/select와 핵심 타깃은 48px이다. 문서 전체 가로 overflow는 허용하지 않고 넓은 편집 영역만 자체 스크롤한다. | [primitives.css](../packages/ui/src/primitives.css), [responsive.spec.ts](../e2e/responsive.spec.ts) |
| 키보드 위젯 | 테마·튜너는 radiogroup, 악보 파트는 tablist, 편집기는 native table, dialog는 focus trap을 사용한다. 화살표/Home/End/Escape 경로를 제공한다. | [primitives.tsx](../packages/ui/src/primitives.tsx), [ux-accessibility.spec.ts](../e2e/ux-accessibility.spec.ts) |
| 포커스·스크롤 | skip link를 제공하고 새 route의 `h1`으로 초점을 옮긴다. history POP은 entry별 본문 scroll을 복원하고 모바일 더보기 dialog를 닫는다. | [AppShell.tsx](../apps/web/src/components/AppShell.tsx), [AppShell.test.tsx](../apps/web/src/components/AppShell.test.tsx), [navigation.spec.ts](../e2e/navigation.spec.ts) |
| 상태 전달 | loading은 status/`aria-busy`, 오류는 alert와 재시도, 동적 값은 필요한 범위에 `aria-live`를 사용한다. 색 외에 text·icon·badge로 상태를 구분한다. | [PageHeader.tsx](../apps/web/src/components/PageHeader.tsx), [primitives.tsx](../packages/ui/src/primitives.tsx), [responsive.spec.ts](../e2e/responsive.spec.ts) |
| 펜·멀티포인터 안전 | 악보 매핑·펜 입력은 capture한 하나의 `pointerId`만 처리하고 `pointercancel`에서 초안을 버린다. | [ScoresPage.tsx](../apps/web/src/pages/ScoresPage.tsx), [scores.spec.ts](../e2e/scores.spec.ts) |
| 사용자 모션·테마 | `prefers-reduced-motion`에서 장식 애니메이션을 줄이고 다크·라이트 색 토큰과 focus ring을 유지한다. | [index.css](../apps/web/src/index.css), [tokens.css](../packages/ui/src/tokens.css) |

## 10. 백엔드, 저장소와 데이터 무결성

| 기능 | 구현 내용 | 근거 |
| --- | --- | --- |
| REST 계약 | FastAPI Pydantic schema가 camelCase JSON/OpenAPI의 단일 원본이고 TypeScript client 타입을 생성한다. | [schemas.py](../apps/server/app/schemas.py), [export_openapi.py](../apps/server/scripts/export_openapi.py), [openapi.ts](../packages/protocol/src/openapi.ts) |
| DB와 migration | SQLAlchemy 2 모델과 Alembic migration을 사용한다. 개발·test는 SQLite를 쓸 수 있고 운영·CI migration은 PostgreSQL을 대상으로 한다. | [models.py](../apps/server/app/models.py), [alembic](../apps/server/alembic), [test_postgres_migration.py](../apps/server/tests/test_postgres_migration.py) |
| 권한 경계 | 그룹 역할과 객체 소유 관계를 공통 helper에서 검사하고 존재하지 않음과 접근 불가를 안전하게 처리한다. | [access.py](../apps/server/app/access.py), [test_permissions_revision.py](../apps/server/tests/test_permissions_revision.py) |
| revision·원자성 | 템포맵, MeasureMap, annotation은 `expectedRevision`으로 낙관적 동시성을 적용한다. Score metadata+MeasureMap은 한 transaction으로 저장한다. | [repertoire.py](../apps/server/app/routers/repertoire.py), [scores.py](../apps/server/app/routers/scores.py) |
| 로컬·S3 객체 저장 | 개발/test에서는 서명된 local upload URL, 운영에서는 S3 presigned staging upload와 download URL을 사용한다. | [storage.py](../apps/server/app/storage.py), [config.py](../apps/server/app/config.py) |
| durable 객체 삭제 | Score·레퍼토리·프로젝트·그룹·계정 삭제 transaction이 객체 키를 outbox에 기록하고 worker가 lease·멱등 삭제·지수 backoff로 계속 재시도한다. | [storage_lifecycle.py](../apps/server/app/storage_lifecycle.py), [storage_cleanup.py](../apps/server/app/routers/storage_cleanup.py), [test_storage_lifecycle.py](../apps/server/tests/test_storage_lifecycle.py) |
| 미완료 업로드 회수 | 만료 pending upload와 staging 객체를 reaper가 회수하며 late upload guard가 삭제 뒤 늦게 도착한 객체도 다시 제거한다. | [storage_lifecycle.py](../apps/server/app/storage_lifecycle.py), [test_storage_lifecycle.py](../apps/server/tests/test_storage_lifecycle.py) |
| 실시간 프로토콜 | 첫 frame의 access-token `JOIN_ROOM`, PING/PONG, READY, START/STOP/SEEK와 typed server envelope를 제공한다. | [ws.py](../apps/server/app/ws.py), [schemas.py](../apps/server/app/schemas.py), [test_websocket.py](../apps/server/tests/test_websocket.py) |
| 서버 생명주기 | 앱 시작·종료 때 DB, bounded mail workers, storage lifecycle worker, room manager를 순서대로 시작하고 정리한다. | [main.py](../apps/server/app/main.py) |
| 운영 fail-fast | production에서 S3 bucket/region, storage worker, JWT·웹 URL·SMTP 등 필수 설정이 없거나 안전하지 않으면 시작을 거부한다. | [config.py](../apps/server/app/config.py), [docker-compose.prod.yml](../docker-compose.prod.yml) |

## 11. 빌드, 배포와 자동 검증

| 기능 | 구현 내용 | 근거 |
| --- | --- | --- |
| monorepo 게이트 | Prettier, ESLint, TypeScript, Vitest, Ruff, mypy, pytest, audio-quality test와 production build를 한 명령으로 실행한다. | [package.json](../package.json), [vitest.workspace.ts](../vitest.workspace.ts) |
| 계약 재생성 검증 | 서버 OpenAPI와 생성된 TypeScript 타입을 다시 만든 뒤 git diff로 불일치를 실패시킨다. | [package.json](../package.json), [ci.yml](../.github/workflows/ci.yml) |
| 브라우저 E2E | navigation, 템포맵 충돌·오프라인, 동기 세션, 악보·필기, 접근성, 13개 viewport를 실제 Chromium에서 검사한다. | [e2e](../e2e), [playwright.config.ts](../playwright.config.ts) |
| 실제 PWA upgrade E2E | 구형 worker와 `fmr-api` cache를 만든 뒤 새 worker 교체 도중의 마지막 write까지 제거되는지 별도 브라우저 server로 검사한다. | [pwa-upgrade.pwa.ts](../e2e/pwa-upgrade.pwa.ts), [pwa.config.ts](../e2e/pwa.config.ts) |
| PostgreSQL migration smoke | pinned PostgreSQL service에 Alembic upgrade를 적용하고 실제 DB에서 두 storage worker가 outbox batch를 중복 없이 claim하는지 검사한다. | [ci.yml](../.github/workflows/ci.yml), [test_postgres_migration.py](../apps/server/tests/test_postgres_migration.py) |
| 오디오 품질 분석 | 30분 click recording과 여러 기기 recording에서 간격, drift, 누락·중복, 기기 간 오차를 계산하는 도구와 test fixture가 있다. | [audio_quality](../scripts/audio_quality), [README.md](../scripts/audio_quality/README.md) |
| immutable ARM64 이미지 | 검증 성공한 `main`의 정확한 40자 SHA로 server/web ARM64 이미지를 만들고 그 태그를 실행해 migration, health, non-root, nginx SPA·header·API proxy를 smoke한 뒤 GHCR에 push한다. | [deploy.yml](../.github/workflows/deploy.yml), [smoke-runtime-images.sh](../.github/scripts/smoke-runtime-images.sh) |
| 제한 배포 | RPi에는 소스를 보내 빌드하지 않고 forced-command SSH로 `deploy feelmyrythm <sha>`만 요청한다. publish와 deploy job 권한도 분리한다. | [deploy.yml](../.github/workflows/deploy.yml), [docker-compose.prod.yml](../docker-compose.prod.yml) |
| 운영 container 경계 | server는 non-root, read-only root filesystem과 `/tmp` tmpfs로 실행하며 앱 stack이 공용 `cksDB`를 생성·재시작·삭제하지 않는다. | [Dockerfile](../apps/server/Dockerfile), [docker-compose.prod.yml](../docker-compose.prod.yml) |

## 12. 아직 “완료 기능”으로 세지 않는 경계

| 항목 | 상태 | 현재 제공되는 것 | 완료 판정에 필요한 것 |
| --- | --- | --- | --- |
| iOS 무음 스위치·잠금·백그라운드 오디오 | 외부 검증 필요 | AVAudioEngine 전체-timeline queue, playback session/background mode, interruption resume, Keep Awake | 서명된 실제 iPhone에서 무음·잠금·전화/오디오 인터럽트 장시간 측정 |
| Android 백그라운드·제조사 절전 | 외부 검증 필요 | Oboe low-latency stream, mediaPlayback foreground service/audio focus/notification stop, Keep Awake | 서명된 실제 Android 기기와 제조사별 절전 상태 검증 |
| 기기 간 ±10ms 동기 기준 | 외부 검증 필요 | 시계 estimator, server anchor, calibration, 파형 분석 도구 | 2–3대 실제 기기의 동시 녹음 파형과 장시간 drift 측정 |
| Universal Links·Android App Links | 외부 검증 필요 | 제한된 associated-domain/intent-filter·URL parser, signed identity 기반 association generator와 public preflight | 운영 게시 후 실제 설치 기기 검증 |
| 스토어 archive·제출 | 외부 검증 필요 | signing 값을 요구하는 archive/bundle script와 개인정보·탈퇴 공개 화면 | 실제 인증서·provisioning·keystore, 설치·스토어 심사 |
| SMTP·Google OAuth 운영 | 설정 필요 / 외부 검증 필요 | provider adapter, token 검증, bounded queue, TLS/auth 및 opt-in delivery preflight | 실제 client ID·도메인·SMTP quota/반송/전달률 및 abuse 정책 |
| S3·공용 cksDB·RPi 배포 | 설정 필요 / 외부 검증 필요 | S3 backend/outbox, CORS·lifecycle/canary preflight, Alembic-head 검사, immutable deploy workflow | 실제 DB backup/restore, forced deploy와 rollback rehearsal |
| CDN/IP abuse 제한 | 의도적 외부 경계 | 앱 내부 cooldown, dummy bcrypt, bounded verifier | trusted proxy/CDN에서 IP rate limit, CAPTCHA와 provider quota 설정 |
| native Google/Apple 로그인 | 의도적 비범위 | native에서는 이메일 인증 로그인만 제공 | 제3자 native 로그인과 스토어 정책을 별도 설계·구현하기 전에는 제공하지 않음 |
| 서버의 beat 스트리밍 | 의도적 비범위 | revision·anchor·서버 시각만 합의 | 추가 구현 대상이 아니라 결정론적 로컬 전개를 지키기 위한 설계 원칙 |
| 원격 snapshot 오프라인 편집·자동 merge | 의도적 비범위 | 검증된 마지막 응답의 읽기 전용 fallback | 명시적 충돌·동기화 모델을 새로 설계하기 전에는 쓰기를 허용하지 않음 |
| RPi 소스 빌드·별도 운영 DB 생성 | 의도적 비범위 | smoke한 immutable image와 외부 `cksDB` 연결 | 운영 안전 경계를 깨므로 배포 경로에서 제공하지 않음 |

이 표의 외부 검증 항목은 관련 선언이나 도구가 없다는 뜻이 아니다. 저장소 안에서 증명할 수
있는 범위까지는 구현돼 있지만, 실제 기기·계정·인프라를 사용하지 않은 상태에서 성능과 운영
완료를 선언하지 않는다는 뜻이다.
