# FeelMyRythm — AGENTS.md

> 앙상블 동기화 메트로놈 + 악보/연습 관리
> 설계: [docs/DESIGN.md](docs/DESIGN.md) · 구현: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · UI: [docs/UI_DESIGN.md](docs/UI_DESIGN.md)

---

## ⚠️ Agent Authority Boundaries — MUST READ FIRST

### 1. Branch Scope per Agent

Each AI agent may only work within its own tool branch and below.
**`main` and `dev` branches are managed exclusively by the user.**

| Branch | Who controls it |
|--------|----------------|
| `main` | User only |
| `dev` | User only |
| `anthropic` | Claude Code |
| `cursor` | Cursor |
| `codex` | OpenAI Codex |
| `{tool}/feature-*` | Each respective agent |

- Agents **must not** commit, merge, or push to `main` or `dev` without an explicit user request.
- When the user explicitly asks, agents may assist with `main`/`dev` operations.

### 2. Shared Project Information → Always Update `AGENTS.md`

프로젝트 전역 규칙·아키텍처·제약이 바뀌면 **`AGENTS.md`를 갱신**한다.
개별 툴 설정만 고치면 다른 에이전트가 놓친다.

| Type of change | Where to update |
|----------------|----------------|
| Project rules, domain logic, API, constraints | `AGENTS.md` ✅ |
| Claude Code-only settings | `.claude/` |
| Cursor rule formatting | `.cursor/rules/` |
| Codex-only instructions | `AGENTS.md` (Codex reads this directly) |

개별 파일(`CLAUDE.md`, `.cursor/rules/`)은 `AGENTS.md`를 가리키는 thin wrapper다.

---

## Vowline

<!-- vowline:start -->
Always use the skill `vowline` consistently, including for all sub-agents.
<!-- vowline:end -->

| 에이전트 | 전역 스킬 경로 | 활성화 방식 |
|----------|---------------|------------|
| Claude Code | `~/.claude/skills/vowline/` | `~/.claude/CLAUDE.md` 마커 블록 |
| Codex | `~/.agents/skills/vowline/` | `~/.codex/AGENTS.md` 마커 블록 |
| Cursor | `~/.cursor/skills/vowline/` | `.cursor/rules/vowline.mdc` (alwaysApply) |

---

## Memento MCP

- **엔드포인트**: `http://localhost:57332/mcp`
- Claude Code / Cursor / Codex 모두 동일 서버에 연결
- 세션 시작: `context` → 작업 중 `recall`/`remember` → 종료 `reflect`

---

## Stack

| 영역 | 선택 |
|---|---|
| 웹 | React 19 + Vite + Tailwind 4 |
| 서버 | Python 3.13 + FastAPI + SQLAlchemy 2 |
| DB | PostgreSQL (운영은 공용 `cksDB`, 로컬 개발은 SQLite 가능) |
| 코어 | `packages/core` 순수 TS (템포맵·시계동기) |
| 오디오 | `packages/audio` Web Audio 룩어헤드 스케줄러 |
| 모바일 | Capacitor (웹 빌드 래핑) |
| 배포 | GitHub-hosted ARM64 Actions → GHCR immutable images → RPi 제한 배포기 |

### Production Routing and Deployment

- 공개 URL은 `https://bonifacio.work/feelmyrythm/`이며 Vite `base`와 React Router `basename`은 `/feelmyrythm/`을 기준으로 한다.
- 브라우저의 REST/WS 경로는 각각 `/feelmyrythm/api/*`, `/feelmyrythm/ws/*`이다. 이미지 내부 nginx가 prefix를 제거해 FastAPI의 기존 `/api/*`, `/ws/*`로 전달한다.
- 운영 이미지는 `ghcr.io/facio313/feelmyrythm-server:<commit-sha>`와 `ghcr.io/facio313/feelmyrythm-web:<commit-sha>`이다. RPi에서 소스를 빌드하지 않는다.
- 운영 Compose는 별도 DB를 생성하지 않는다. `fmrServer`를 외부 `cksDB` Docker 네트워크에 연결하고, `.env`의 `FMR_DATABASE_URL`로 공용 `cksDB` 안의 전용 DB/계정에 접속한다.
- 배포 요청은 forced-command SSH 키를 통해 `deploy feelmyrythm <40-character-sha>`만 허용한다. 배포 과정에서 전역 image prune, stack-wide `down`, DB/volume 삭제를 실행하지 않는다.

---

## Branch Strategy

### Worktree Layout

| Directory | Branch | AI Tool |
|-----------|--------|---------|
| `FeelMyRythm/` (main repo) | `main` | — (release baseline) |
| `FeelMyRythm/worktrees/codex/` | `codex` | OpenAI Codex |
| `FeelMyRythm/worktrees/cursor/` | `cursor` | Cursor |
| `FeelMyRythm/worktrees/anthropic/` | `anthropic` | Claude Code |

### Flow

```
codex/feature-name ──┐
cursor/feature-name ─┤→ {tool} → dev → main
anthropic/feat-name ─┘
```

1. Branch off the tool branch for any new feature:
   ```bash
   git checkout -b cursor/tempo-editor cursor
   ```
2. Merge completed feature back into the tool branch:
   ```bash
   git checkout cursor && git merge cursor/tempo-editor
   ```
3. Merge tool branch into `dev` after validation (user):
   ```bash
   git checkout dev && git merge cursor
   ```
4. Merge `dev` into `main` after full verification only (user).

### Naming Rules

- Tool branches: `codex`, `cursor`, `anthropic`
- Feature branches: `{tool}/{kebab-case-feature}` — e.g. `cursor/sync-session`
- English kebab-case only.

---

## Critical Constraints

- **결정론적 동기화** — 박을 스트리밍하지 않는다. 시계 합의(`serverStartTime`) + 로컬 타임라인 전개. 설계문서 §6.
- **오디오 우선** — 시각화는 오디오 클럭 기준 rAF. `setTimeout`으로 클릭/시각 금지. 설계문서 §5.
- **코어 순수성** — `packages/core`에 DOM/플랫폼 의존성 넣지 말 것.
- **템포맵 revision** — 수정 시 revision 증가. 동시 수정은 409. 동기 세션은 동일 revision 보장.
- **`.env` 커밋 금지**. `FMR_*` / DB 자격증명 / `DEPLOY_*` 하드코딩 금지.
- **배포 시크릿** — GitHub Repository Secret `DEPLOY_KEY`만 사용한다. 호스트·포트·사용자·서버 공개 host key는 워크플로에 고정되어 있다.
- **공용 DB 보호** — 앱 배포에서 `cksDB` 컨테이너·네트워크·데이터를 생성, 재시작, 삭제하지 않는다.
- 사용자 응답 **한국어**. 코드·식별자·커밋은 **영문**.
