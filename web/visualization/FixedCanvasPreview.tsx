import {useId} from 'react';
import type {CanvasPresentationDocument} from '../../shared/canvas.ts';
import type {SequencePresentationDocument} from '../../shared/sequence.ts';
import {validatePresentationDocument} from './presentation.ts';

const fills={none:'none',paper:'#14242e',blue:'#315b72',note:'#403e27',ink:'#b9d9df'};

/** Fixed primitives only; user text is escaped by React and never used as markup or URLs. */
export function FixedCanvasPreview({document,label}:{document:CanvasPresentationDocument|SequencePresentationDocument;label:string}){
  const marker=useId();
  if(!document||(document.format!=='canvas-v1'&&document.format!=='sequence-v1')||!validatePresentationDocument(document))return <p role="alert">유효하지 않은 도형 문서입니다.</p>;
  return <>
    {document.slides.map((slide,index)=><div className="viz-sequence-page" key={slide.id}>
      <h4>{index+1} / {document.slides.length}페이지</h4>
      <div className="viz-sequence-scroll" tabIndex={0} aria-label={`${label} ${index+1}페이지 · 방향키로 스크롤`}><svg role="img" aria-label={`${label} 다이어그램 · ${index+1} / ${document.slides.length}페이지`} viewBox={`0 0 ${slide.width} ${slide.height}`} width={slide.width} height={slide.height} style={{width:slide.width,height:slide.height,maxWidth:'none',display:'block'}}>
        <title>{`${label} 다이어그램 · ${index+1} / ${document.slides.length}페이지`}</title>
        <defs><marker id={`${marker}-${index}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 9 5 L 0 10 Z" fill="#b9d9df"/></marker></defs>
        {slide.elements.map(element=>{
          if(element.type==='box'){
            const style={fill:fills[element.fill],stroke:element.stroke==='none'?'none':'#93b8c5',strokeWidth:1.5};
            if(element.geometry==='diamond')return <polygon key={element.id} points={`${element.x+element.width/2},${element.y} ${element.x+element.width},${element.y+element.height/2} ${element.x+element.width/2},${element.y+element.height} ${element.x},${element.y+element.height/2}`} {...style}/>;
            return element.geometry==='ellipse'?<ellipse key={element.id} cx={element.x+element.width/2} cy={element.y+element.height/2} rx={element.width/2} ry={element.height/2} {...style}/>:<rect key={element.id} x={element.x} y={element.y} width={element.width} height={element.height} {...style}/>;
          }
          if(element.type==='line')return <line key={element.id} x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2} stroke="#b9d9df" strokeWidth="1.5" strokeDasharray={element.dash==='dash'?'7 5':undefined} markerEnd={element.arrow==='triangle'?`url(#${marker}-${index})`:undefined}/>;
          const x=element.align==='center'?element.x+element.width/2:element.x;
          return <text key={element.id} x={x} y={element.y+element.fontSize} fill="#e0eef1" fontSize={element.fontSize} fontFamily="Arial, sans-serif" textAnchor={element.align==='center'?'middle':'start'}><title>{element.text.replaceAll('\n','')}</title>{element.text.split('\n').map((text,line)=><tspan key={line} x={x} dy={line?Math.ceil(element.fontSize*1.2):0}>{text}</tspan>)}</text>;
        })}
      </svg></div>
    </div>)}
  </>;
}
