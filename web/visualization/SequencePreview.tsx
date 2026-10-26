import {useId} from 'react';
import type {SequenceDiagram,SequencePresentationDocument} from '../../shared/sequence.ts';
import {layoutSequence} from './sequence-layout.ts';

const fills={none:'none',paper:'#14242e',blue:'#315b72',note:'#403e27'};

/** Fixed primitives only: no Mermaid engine, arbitrary markup, links or external assets. */
export function SequencePreview({diagram}:{diagram:SequenceDiagram}){
  const marker=useId();let document:SequencePresentationDocument;
  try{document=layoutSequence(diagram);}catch{return <p role="alert">시퀀스 다이어그램을 표시할 수 없습니다. 지원 문법과 페이지·내용 한도를 확인하세요.</p>;}
  return <section className="viz-sequence" aria-label="시퀀스 다이어그램 미리보기">
    <p>총 {document.slides.length}페이지 · 아래로 스크롤해 순서대로 확인하세요. par·and는 병렬 분기를 나타내며 세로 배치는 원문 순서입니다.</p>
    {document.slides.map((slide,index)=><div className="viz-sequence-page" key={slide.id}>
      <h4>{index+1} / {document.slides.length}페이지</h4>
      <div className="viz-sequence-scroll" tabIndex={0} aria-label={`시퀀스 ${index+1}페이지 · 방향키로 스크롤`}><svg role="img" aria-label={`시퀀스 다이어그램 · ${index+1} / ${document.slides.length}페이지`} viewBox={`0 0 ${slide.width} ${slide.height}`} width={slide.width} height={slide.height} style={{width:slide.width,height:slide.height,maxWidth:'none',display:'block'}}>
        <title>{`시퀀스 다이어그램 · ${index+1} / ${document.slides.length}페이지`}</title>
        <defs><marker id={`${marker}-${index}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 9 5 L 0 10 Z" fill="#b9d9df"/></marker></defs>
        {slide.elements.map(element=>{
          if(element.type==='box'){
            const style={fill:fills[element.fill],stroke:element.stroke==='none'?'none':'#93b8c5',strokeWidth:1.5};
            return element.geometry==='ellipse'?<ellipse key={element.id} cx={element.x+element.width/2} cy={element.y+element.height/2} rx={element.width/2} ry={element.height/2} {...style}/>:<rect key={element.id} x={element.x} y={element.y} width={element.width} height={element.height} {...style}/>;
          }
          if(element.type==='line')return <line key={element.id} x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2} stroke="#b9d9df" strokeWidth="1.5" strokeDasharray={element.dash==='dash'?'7 5':undefined} markerEnd={element.arrow==='triangle'?`url(#${marker}-${index})`:undefined}/>;
          const x=element.align==='center'?element.x+element.width/2:element.x;
          return <text key={element.id} x={x} y={element.y+element.fontSize} fill="#e0eef1" fontSize={element.fontSize} fontFamily="Arial, sans-serif" textAnchor={element.align==='center'?'middle':'start'}><title>{element.text.replaceAll('\n','')}</title>{element.text.split('\n').map((text,line)=><tspan key={line} x={x} dy={line?22:0}>{text}</tspan>)}</text>;
        })}
      </svg></div>
    </div>)}
  </section>;
}
