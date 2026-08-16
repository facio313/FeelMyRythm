# FeelMyRythm — Claude Gitflow Guide

> Claude (Anthropic) 에이전트 전용 브랜치 운영 규칙. 전체는 `AGENTS.md` 참고.

---

## 브랜치 구조

```
main                       ← 배포 기준 (직접 커밋 금지)
└── dev                    ← 통합 브랜치
    ├── anthropic          ← Claude 상주·기본 작업 브랜치 ✅
    ├── cursor             ← Cursor 에이전트 (수정 금지)
    └── codex              ← Codex 에이전트 (수정 금지)
```

---

## Claude 작업 규칙

| 항목 | 규칙 |
|------|------|
| 상주 브랜치 / 워크트리 | `anthropic` / `worktrees/anthropic/` |
| 기본 작업 위치 | `anthropic`에 직접 커밋·푸시 |
| 기능 브랜치 | 사용자 명시 요청 때만 `anthropic-feature-<feature-name>` 허용 |
| 병합 방향 | `anthropic` → `dev` → `main` |
| `main` / `dev` 직접 커밋 | **금지** (사용자 명시 요청 시에만) |
| `cursor-feature-*` / `codex-feature-*` | **수정 금지** (읽기만) |
