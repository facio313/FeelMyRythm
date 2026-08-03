# FeelMyRythm

앙상블 연습을 위한 **동기화 메트로놈 + 악보/연습 관리** 앱.
곡의 템포 구조(박자·BPM 변화·반복)를 "템포맵"으로 정의하고, 앙상블 전원이 **같은 순간에 같은 박**을 듣고 보게 합니다.

- 설계: [docs/DESIGN.md](docs/DESIGN.md) · 구현 계획: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · UI: [docs/UI_DESIGN.md](docs/UI_DESIGN.md)

## 구조

```
packages/core      순수 TS: 템포맵 → 타임라인 전개(도돌이·볼타·D.C./D.S./Coda), NTP식 시계동기 수학
packages/audio     Web Audio 룩어헤드 스케줄러(Two Clocks), 클릭 합성, MPM 튜너
packages/protocol  클라-서버 공유 타입 (원천: 서버 Pydantic 스키마)
packages/ui        디자인 토큰 (다크 우선, 골드 액센트)
apps/web           React 19 + Vite + Tailwind 4 (메트로놈·편집기·세션·악보·일지·튜너)
apps/server        Python FastAPI + SQLAlchemy (REST + WS 동기화 게이트웨이)
apps/mobile        Capacitor 셸 (웹 빌드 → iOS/Android)
```

## 요구 사항

- Node.js ≥ 20 (npm workspaces)
- [uv](https://docs.astral.sh/uv/) + Python ≥ 3.12
- (선택) Docker — Postgres로 돌릴 때

## 빠른 시작

```bash
# 1) JS 의존성
npm install

# 2) 서버 (기본: SQLite dev.db — 설정 없이 바로 동작)
cd apps/server && uv sync && cd ../..
npm run dev:server        # http://localhost:8000 (OpenAPI: /docs)

# 3) 웹 (새 터미널)
npm run dev:web           # http://localhost:5173 (API/WS 프록시 내장)
```

Postgres로 돌리려면:

```bash
docker compose up -d
FMR_DATABASE_URL=postgresql+psycopg://fmr:fmr@localhost:5432/feelmyrythm npm run dev:server
```

## 테스트

```bash
npm test                  # core: 타임라인 전개·시계동기 (vitest)
npm run test:server       # server: REST + WS 통합 (pytest)
```

## 사용 흐름 (앙상블 동기)

1. 회원가입 → 그룹 생성 → 멤버 초대(이메일) → 프로젝트 → 곡 추가
2. 곡에서 **템포맵 편집** (예: 4/4 ♩=100 시작 → 26마디부터 ♩=130 → 1~8마디 도돌이 + 1st/2nd 엔딩)
   - MusicXML 파일을 가져오면 마디 수·박자·템포·도돌이를 자동 인식해 초안 생성
3. **앙상블 세션 열기** → 세션 코드를 멤버에게 공유 → 멤버가 코드로 입장
4. 각자 **캘리브레이션** 1회(출력 지연 보정) 후 리더가 "26마디부터 시작" → 전원 같은 예비박부터 동시 시작
5. 악보(PDF) 업로드 → 마디 매핑(드래그) → 마디 클릭으로 해당 마디부터 연습, 총보↔파트보 같은 마디 이동, 필기 공유
6. 연습일지·할일로 지시사항 관리 (마디 앵커 지원)

## 모바일 패키징 (로드맵 Phase 8)

```bash
npm run build             # 웹 빌드 생성
cd apps/mobile
npx cap add ios           # Xcode 필요
npx cap add android       # Android Studio 필요
npm run sync              # 웹 빌드 → 네이티브 프로젝트 반영
npx cap open ios
```

iOS는 오디오 세션을 playback 카테고리로 설정해야 무음 스위치/백그라운드에서도 클릭이 울립니다.
WebView 오디오 지연이 실측으로 문제가 되면 `packages/audio`의 `AudioEngine` 인터페이스 구현체만
네이티브 플러그인으로 교체하면 됩니다 (상위 코드 무변경 — 설계문서 §5.1).

## 환경 변수 (서버, 접두사 FMR_)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `FMR_DATABASE_URL` | `sqlite:///./dev.db` | Postgres: `postgresql+psycopg://...` |
| `FMR_JWT_SECRET` | dev용 기본값 | **운영에서 반드시 교체** |
| `FMR_UPLOADS_DIR` | `./uploads` | 악보 파일 저장 경로 (운영: S3 교체 지점) |
| `FMR_CORS_ORIGINS` | localhost:5173 | 웹 오리진 |

## 현재 구현 범위

| 기능 | 상태 |
|---|---|
| 메트로놈 (룩어헤드 스케줄링, 예비박, 분할, 탭 템포) | ✔ |
| 템포맵 (구간·박자 변화·도돌이/볼타/D.C./D.S./Coda·못갖춘마디) | ✔ |
| 실시간 동기 세션 (NTP식 시계동기, 동기 시작/정지, 늦은 합류, RTT 표시) | ✔ |
| 기기 캘리브레이션 (탭 기반 출력 지연 보정) | ✔ |
| 그룹/프로젝트/레파토리 + 템포맵 revision 공유 | ✔ |
| 악보 업로드(PDF/이미지) + 수동 마디 매핑 + 파트보 전환 + 필기 공유 | ✔ |
| MusicXML 마디/템포/도돌이 자동 인식 → 템포맵 초안 | ✔ (베스트 에포트) |
| 연습일지(마디 앵커)·할일 | ✔ |
| 튜너 (MPM, A4 프리셋) | ✔ |
| 재생 중 악보 하이라이트·자동 페이지 넘김 | 예정 (로드맵 Phase 5 후반) |
| PDF OMR 자동 마디 인식 | 예정 (Audiveris 연동, 베스트 에포트) |
| 네이티브 오디오 플러그인 / 스토어 배포 | 예정 (Phase 8) |
