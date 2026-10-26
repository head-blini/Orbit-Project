import type {ClassDiagram} from '../../shared/uml-class.ts';
import type {CanvasPresentationDocument} from '../../shared/canvas.ts';
import {layoutClassDiagram} from './uml-class-layout.ts';
import {FixedCanvasPreview} from './FixedCanvasPreview.tsx';

export function ClassDiagramPreview({diagram}:{diagram:ClassDiagram}){
  let document:CanvasPresentationDocument;
  try{document=layoutClassDiagram(diagram);}catch{return <p role="alert">클래스 다이어그램을 표시할 수 없습니다. 지원 문법과 배치 한도를 확인하세요. 클래스·멤버·관계의 범위를 나누어 작성할 수 있습니다.</p>;}
  return <section className="viz-sequence viz-class" aria-label="UML 클래스 다이어그램 미리보기">
    <p>사용자가 작성한 클래스와 관계입니다. 소스 코드나 실행 구조를 검증한 결과가 아닙니다. 다중성은 클래스 접점 가까이에 표시하며, 선의 교차는 연결을 뜻하지 않습니다.</p>
    <FixedCanvasPreview document={document} label="UML 클래스"/>
  </section>;
}
