# Approved local merge implementation plan

> **For agentic workers:** Use superpowers:executing-plans for shared integration and superpowers:subagent-driven-development for independent snapshot/Git/UI modules.

**Goal:** 현재 검증과 사용자 리뷰 승인이 있는 worktree 변경을 보존 가능한 스냅샷으로 만들고, 사용자가 확인한 동일 base의 clean primary branch에만 fast-forward로 반영한다.
**Architecture:** Projects 경로·Git 검증, 같은 bytes의 source fingerprint, VerificationService 승인, 기존 Runner의 bounded native process 원칙을 재사용한다. 원 worktree HEAD/index/files는 변경하지 않는다. 임시 index와 native Git raw object/tree/commit 기능으로 후보를 만든 뒤 별도 명시 apply 승인을 받는다.
**Tech Stack:** 기존 Node24/TypeScript/SQLite/React/Git2.53. 새 패키지·프레임워크 없음.
**Spec:** goal-objective D/K, docs/02-TECH-DESIGN.md 검증/리뷰, ORBIT-MASTER-PLAN.md. 이전 검증 gate322/322·browser26/26 완료 후 시작.

## Constraints and review focus

- 초기 지원은 target HEAD===source.baseSha인 현재 primary branch의 ff-only. 대상 branch/HEAD, source/checkset/approval, 후보 commit/tree를 서버 권위로 고정한다. 임의 경로/명령/ref는 요청에서 받지 않는다.
- 원본 source index·HEAD·내용과 user dirty 상태 보존. target staged/unstaged/untracked, 진행 중 Git 작업/locks, 다른 worktree의 동일 branch checkout은 거절한다. ignored 충돌도 덮지 않는다.
- 모든 manifest path를 읽기 전에 검사한다. binary/빈 파일/삭제/모드와 same-read digest를 보존한다. 민감 경로·links·submodule·변환 attributes/EOL/encoding/ident/filter는 fail-closed. 임의 전역 Git config·hooks·서명·외부 driver·protocol 실행 금지.
- candidate raw tree와 승인 bytes/mode/전체 경로를 비교한다. source·target·승인 fresh gate 후 `merge --ff-only --no-overwrite-ignore`로만 반영하고 target raw bytes/index/HEAD를 다시 확인한다. check→checkout 사이 외부 Git/파일 변경과 완전한 트랜잭션을 보장하지 않는다.
- durable intent를 Git write 전에 저장한다. 같은 request replay는 중복하지 않는다. 실패·재시작은 branch/commit/전후 SHA를 보존하고 lost/unknown을 정직하게 표시한다. reset/clean/stash/강제 rollback/자동 재시도·push·자동 충돌 해결 없음.
- 합성 임시 Git·DB에서만 실제 쓰기를 검증한다. 사용자 저장소/통합 worktree 병합은 이 개발 세션에서 수행하지 않는다.

## Tasks and ownership

- [x] Snapshot owner: `server/workspace-fingerprint.ts`, `tests/workspace-snapshot.test.ts`. 같은 bytes의 digest와 raw snapshot. focused27/27 exit0. POSIX executable 분기는 Windows에서 미실행.
- [x] Git owner: `server/git-process.ts`, `server/merge-git.ts`, `tests/merge-git.test.ts`. 원본을 보존하는 별도 index/후보·ff apply/관찰 복구. 최종 focused14/14 및 type exit0. 독립 리뷰의 autostash/external ignore P2 재현·수정 포함.
- [x] Root: `shared/merge.ts`, `server/merge-service.ts`, Projects·Controller/HTTP/SQLite/상호 배제. service5/5 및 실제 HTTP1/1 exit0. 후보 재확인 뒤 source 재변경과 이전 Run의 미확정 이력 표시 회귀 포함.
- [x] UI owner: `web/merge.tsx` 및 Development 연결. 후보와 반영 별도 승인·미확정 복구·스코프/응답 유실 경계. UI focused5/5 exit0, manual refresh만 불확정 요청 경계를 해제하는 회귀 포함.
- [x] 독립 리뷰·동결 후 전체358/358·type/build exit0·Windows browser29/29·37PNG. 세 번째 fixture에서만 실제 ff, source HEAD/index/bytes 및 기존 두 fixture 보존, refresh/restart/no replay. `orbit-e2e-MuuaOA` result/cleanup 증거, root PNG35/37 직접 확인. 서버6개·브라우저 종료·포트 닫힘·cleanupErrors0. 실제 AI/계정/외부 HTTP0. 전체 Goal은 계속 미완료.

## Official interfaces

- [git-merge](https://git-scm.com/docs/git-merge): ff-only는 fast-forward 불가 시 거절한다. no-overwrite-ignore는 ignored 파일의 묵시적 덮어쓰기를 막는다.
- [git-read-tree](https://git-scm.com/docs/git-read-tree): 별도 index에 tree를 구성한다. 사용자 index를 대상으로 reset하지 않는다.
- [git-commit-tree](https://git-scm.com/docs/git-commit-tree): 정해진 tree와 유일 parent를 가진 commit object를 만들고 서명을 비활성화한다.
