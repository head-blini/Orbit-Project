# Browser artifact download 검증

확인일: 2026-10-25. 설치된 native agent-browser 0.39.2와 기존 제품 build를 사용했다. 제품 코드·사용자 DB·기존 live fixture를 수정하지 않았으며 모델을 실행하지 않았다.

## 결과

`node scripts/verify-artifact-download.mjs` 최종 실행 exit 0. 새 전용 Git/SQLite fixture의 Artifact를 제품 Visualization Studio에서 선택하고 **실제 PPTX/Markdown 내보내기 버튼**을 클릭했다. launch에 일반 절대 경로인 `--download-path <owned downloads directory>`를 지정하고, CLI `download` 대신 `click`을 사용했다. 다운로드 명령의 성공 메타데이터가 아니라 디스크 파일을 읽어 확인했다.

| 브라우저 저장 파일 | 바이트 | 확인 |
| --- | ---: | --- |
| PPTX | 12,721 | production Studio 출력과 byte-for-byte 일치; 독립 ZIP central/local record·CRC·12개 part·내부 relationship 확인 |
| Markdown | 221 | production Studio 출력과 byte-for-byte 일치; 원문·한글·버전 보존 |

PPTX는 native editable `p:sp` 5개와 `p:cxnSp` 1개이며 connector의 두 endpoint가 실제 shape ID를 참조한다. Python 표준 `zipfile`/`ElementTree`로 CRC, 모든 XML part parse, relationship target, 한글, shape/connector를 별도 검사했다(exit 0). PowerPoint GUI에서 직접 편집하는 검증은 수행하지 않았다.

같은 세션·같은 PPTX 버튼에서 CLI `download <ref> <path>`를 사용한 비교는 exit 1 / `Download was canceled`로 재현됐다. 따라서 **제품 UI 다운로드의 성공 경로는 확인됐지만 agent-browser `download` 명령 자체의 결함을 수정한 것은 아니다.**

## 원인 범위와 한계

동일 버전 [공식 actions.rs](https://github.com/vercel-labs/agent-browser/blob/v0.39.2/cli/src/native/actions.rs)의 `handle_download`는 목적지 directory를 `canonicalize()`한 뒤 `allowAndName` download behavior를 설정한다. [공식 browser.rs](https://github.com/vercel-labs/agent-browser/blob/v0.39.2/cli/src/native/browser.rs)의 launch `--download-path`는 입력 경로에 `allow`를 설정한다. [공식 명령 문서](https://agent-browser.dev/commands)는 `--download-path`, `click`, `download`를 지원한다.

비교 실험은 실패 범위를 CLI의 경로/behavior 처리 차이로 좁힌다. Windows `canonicalize()`의 extended path 표현이 Chrome 취소의 직접 원인이라는 설명은 아직 가설이다. raw CDP를 이용해 두 변수를 따로 변경하거나 설치된 CLI를 수정하지 않았다. allowlist는 `127.0.0.1`을 유지했고 보안 flag/HOME/profile/auth를 변경하지 않았다.

## 증거와 재현

- 성공 run: `C:\Users\lclk1\AppData\Local\Temp\orbit-download-8NErjl`
- 결과: 위 폴더 `result.json`, 명령별 기록 `logs/01.json`부터 `16.json`, 별도 `python-validation.json`.
- PPTX: `C:\Users\lclk1\AppData\Local\Temp\orbit-download-8NErjl\downloads\orbit-193463ad-944c-43c5-a05c-561e9c49efe2-v1.pptx`
- Markdown: 같은 `downloads` 폴더의 `orbit-193463ad-944c-43c5-a05c-561e9c49efe2-v1.md`.
- PPTX SHA-256: `8f6d51072f4ea4e8e73bdfb079ba70b142ea6d4db6ae3c0bbd63bea80b280786`
- Markdown SHA-256: `a761da7a40c358b128c7148ea7730e494477fc298491793ddaa3646a22a144ec`
- build `app.js` SHA-256: `b34b94ba7e0417318b566e2ad546c42cd916975cb321569349b4659435569925`.

`node --check scripts/verify-artifact-download.mjs` exit 0. 최종 run에서 원본 fixture HEAD/clean status/README 보존을 확인했고, owned browser close 응답은 `closed:true`, `browserLaunched:false`였다. HTTP server/controller/store도 `finally`에서 종료됐으며 `cleanupErrors: []`다. 생성한 fixture와 산출물은 삭제하지 않았다.

사전 실행 2개는 다운로드 비교 전에 실패했다: `orbit-download-C9KFg2`는 managed PATH에서 설치 CLI를 찾지 못했고, `orbit-download-a2EPVN`은 대기식의 따옴표 오류로 timeout됐다. 기존 설치 절대 경로 fallback 및 대기식 수정 후 위 최종 run에서 실제 다운로드 비교 1회를 수행했다. 실패 run도 각각 종료 처리했으며 성공으로 집계하지 않았다. 전체 E2E/전체 test suite는 반복하지 않았다.

재현 명령은 normal-user PowerShell에서 `node scripts/verify-artifact-download.mjs`다. 임의 URL/기존 DB/프로젝트 경로 입력을 받지 않으며 매번 새 OS temp fixture를 생성한다. 새 모델 turn이나 외부 서비스는 호출하지 않는다.
