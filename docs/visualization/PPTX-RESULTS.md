# 실제 PPTX 직렬화 검증 — 2026-10-25

범위: `server/visualization/pptx.ts`, `tests/pptx.test.ts`. HTTP/Studio/UI 연결은 통합 담당 소유다. 의존성 설치·manifest 변경·커밋·외부 서비스 실행은 하지 않았다. 기존 사용자 DB/인증 파일은 열지 않았다.

## 인터페이스와 결과

`serializePresentation(value: unknown): Uint8Array`는 기존 `toPresentationDocument`의 단일 슬라이드 모델 또는 동일한 JSON을 받아 실제 PPTX ZIP bytes를 반환한다. 실제 반환 객체는 Buffer이며 Uint8Array와 호환된다. 잘못된 입력은 고정 `Error('INVALID_PRESENTATION')`로 거절한다. 파일·프로세스·네트워크 접근이 없는 순수 직렬화 함수다.

- 별도 편집 가능한 `p:sp` 도형 및 textbox, numeric shape ID에 연결된 `p:cxnSp` 출력. 이미지를 넣어 다이어그램을 대체하지 않는다.
- 16:9 슬라이드에 원본 좌표의 비율을 유지하여 맞춘다. 역방향·수직·자기 연결을 출력한다. 조밀한 그래프와 자기 연결의 시각적 품질은 PowerPoint GUI에서 미검증이다.
- ZIP32 STORE와 UTF-8 XML 12개 part. presentation/slide/master/layout/theme/presProps/content types 및 내부 relationships 포함. CRC, directory offset, 고정 안전 경로와 재현 가능한 ZIP 날짜를 사용한다.
- 외부 relationships·매크로·임의 파일·HTML·원격 이미지가 없다. XML 특수문자를 이스케이프하고 한글·줄바꿈을 보존한다. XML 1.0에 유효하지 않은 문자와 고립 surrogate는 거절한다.
- 기존 1슬라이드/800요소/160자/100000 좌표 상한을 재사용한다. 추가로 UTF-8 JSON 256 KiB, 양수 도형 크기 및 canvas 경계를 검사한다.

## 실행 증거

| 검사 | 종료 코드 / 결과 |
| --- | --- |
| 최초 `node --test tests/pptx.test.ts` | 1. 모듈 부재 로딩 실패이며 동작 RED로 세지 않음 |
| 빈 bytes 직렬화 stub + 같은 명령 | 1. 5개 assertion 실패: 실제 ZIP 부재와 잘못된 입력 거절 누락 |
| 실제 구현 후 같은 명령 | 0. 최초 5/5 |
| UTF-8 byte budget 검사 추가 후 같은 명령 | 0. 최종 6/6 |
| `npm.cmd run typecheck`, `npm.cmd test` | 각각 1. 현재 프로세스 PATH에 npm.cmd 없음 |
| `node C:/Users/lclk1/Projects/ai-coding-control-center/AI-Coding-Control-Center-Codex-Starter/node_modules/typescript/bin/tsc --noEmit` | 0. 이미 설치된 TypeScript 사용, 추가 설치 없음 |
| `node --test tests/*.test.ts spikes/phase0/*.test.mjs` | 0. 최초 전체 159/159, 최종 실행 시 동시 통합 변경 포함 161/161, 실패/skip 없음 |
| 번들 Python `zipfile`, `xml.etree.ElementTree`, `python-pptx` 독립 검사 | 0. CRC, 12개 XML 파싱, 모든 내부 관계 대상, native shape/text/connector, 한글 확인. textbox 수정·도형 이동·저장·재열기와 connector 참조 유지 확인 |
| `git diff --check -- server/visualization/pptx.ts tests/pptx.test.ts` | 0. 신규 파일은 Git untracked 상태이므로 tracked diff 검사 범위 한계 있음 |

Node v24.19.0, 번들 Python 3.12.14, python-pptx 1.0.2, lxml 6.1.1을 사용했다. 단위 테스트 ZIP 리더는 제품 writer의 packing/CRC/escaping 코드를 사용하지 않으며 Node zlib CRC32로 검사한다.

Python 초기 검사는 실패했다. 일반 도형의 빈 text frame까지 textbox로 세는 가정, PowerShell stdin의 비ASCII 인코딩, part 개수를 13으로 적은 수동 검사 오류를 수정했다. 합성 fixture 스크립트는 ASCII Unicode escape를 사용했고 생산 직렬화 코드는 이 때문에 바꾸지 않았다. 최종 파일의 한글은 Python XML 파싱과 python-pptx에서 원문 일치로 확인했다.

합성 출력 파일(사용자 프로젝트 자료 없음):

- `C:/Users/lclk1/AppData/Local/Temp/orbit-pptx-evidence/editable-korean.pptx`
- `C:/Users/lclk1/AppData/Local/Temp/orbit-pptx-evidence/edited-roundtrip.pptx`

## 한계와 기준 자료

실제 Microsoft PowerPoint GUI 열기·개별 요소 수정·저장과 전체 OOXML XSD 검증은 수행하지 않았다. python-pptx 재편집은 그 인수 검증을 대체하지 않는다. 제품 빌드·브라우저 다운로드도 이 모듈 담당의 검증 범위 밖이다. 전체 Visualization/Automation 완료를 주장하지 않는다.

구조는 Microsoft의 [최소 PresentationML 생성](https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-create-a-presentation-document-by-providing-a-file-name), 연결선은 [StartConnection의 shape ID와 connection-site 정의](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.startconnection?view=openxml-3.0.1)를 확인하여 구현했다. 공개 문서 질의에 프로젝트 내용은 전송하지 않았다.
