import type {C4Diagram} from '../../shared/c4.ts';
import type {CanvasPresentationDocument} from '../../shared/canvas.ts';
import {layoutC4} from './c4-layout.ts';
import {FixedCanvasPreview} from './FixedCanvasPreview.tsx';

export function C4Preview({diagram}:{diagram:C4Diagram}){
  let document:CanvasPresentationDocument;
  try{document=layoutC4(diagram);}catch{return <p role="alert">C4 다이어그램을 표시할 수 없습니다. 입력과 전체 내용의 배치 한도를 확인하세요. 내용을 줄이거나 범위를 나누어 작성할 수 있습니다.</p>;}
  return <section className="viz-sequence viz-c4" aria-label="C4 다이어그램 미리보기">
    <p>사용자가 작성한 구조와 관계입니다. 소스 코드나 실행 환경에서 확인한 결과가 아닙니다. 한 페이지에 전체 범위를 표시하며, 가로·세로로 스크롤할 수 있습니다.</p>
    <FixedCanvasPreview document={document} label="C4"/>
  </section>;
}
