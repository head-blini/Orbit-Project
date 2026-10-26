import type {SequenceDiagram,SequencePresentationDocument} from '../../shared/sequence.ts';
import {layoutSequence} from './sequence-layout.ts';
import {FixedCanvasPreview} from './FixedCanvasPreview.tsx';

/** Fixed primitives only: no Mermaid engine, arbitrary markup, links or external assets. */
export function SequencePreview({diagram}:{diagram:SequenceDiagram}){
  let document:SequencePresentationDocument;
  try{document=layoutSequence(diagram);}catch{return <p role="alert">시퀀스 다이어그램을 표시할 수 없습니다. 지원 문법과 페이지·내용 한도를 확인하세요.</p>;}
  return <section className="viz-sequence" aria-label="시퀀스 다이어그램 미리보기">
    <p>총 {document.slides.length}페이지 · 아래로 스크롤해 순서대로 확인하세요. par·and는 병렬 분기를 나타내며 세로 배치는 원문 순서입니다.</p>
    <FixedCanvasPreview document={document} label="시퀀스"/>
  </section>;
}
