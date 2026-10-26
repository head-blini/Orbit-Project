import { validateArchitecture } from './mermaid.ts';

// Implementation-local element model; shared/parallel.ts remains integration-owned.
type Element =
  | {type:'shape';id:string;x:number;y:number;width:number;height:number;kind:string}
  | {type:'text';id:string;x:number;y:number;width:number;height:number;text:string}
  | {type:'connector';id:string;from:string;to:string};

export function toPresentationDocument(graph:{nodes:{id:string;label:string;kind:string}[];edges:{from:string;to:string;label?:string}[]}) {
  if(!validateArchitecture(graph).ok) throw new Error('INVALID_ARCHITECTURE');
  // One expandable canvas keeps every connector on the same slide as its endpoints.
  const columns=Math.min(4,graph.nodes.length),rows=Math.ceil(graph.nodes.length/columns);
  const positions=new Map(graph.nodes.map((node,i)=>[node.id,{x:40+(i%columns)*260,y:40+Math.floor(i/columns)*160}]));
  const elements:Element[]=[];
  graph.nodes.forEach(node=>{
    const p=positions.get(node.id)!;
    elements.push({type:'shape',id:node.id,...p,width:220,height:100,kind:node.kind});
    elements.push({type:'text',id:`text:${node.id}`,x:p.x+12,y:p.y+12,width:196,height:76,text:node.label});
  });
  graph.edges.forEach((edge,i)=>{
    elements.push({type:'connector',id:`edge:${i}`,from:edge.from,to:edge.to});
    if(edge.label) {
      const from=positions.get(edge.from)!,to=positions.get(edge.to)!;
      elements.push({type:'text',id:`edgeText:${i}`,x:(from.x+to.x)/2,y:(from.y+to.y)/2+110,width:220,height:40,text:edge.label});
    }
  });
  return {slides:[{id:'architecture',width:columns*260+40,height:rows*160+40,elements}]};
}

// Match XML 1.0's character range without replacing invalid input during export.
function xmlText(value:string):boolean {
  for(const char of value) {
    const n=char.codePointAt(0)!;
    if(!(n===9||n===10||n===13||(n>=32&&n<=0xd7ff)||(n>=0xe000&&n<=0xfffd)||(n>=0x10000&&n<=0x10ffff)))return false;
  }
  return true;
}
const validId=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=160&&xmlText(value);

export function validatePresentationDocument(value:unknown):boolean {
  if(!value || typeof value!=='object' || Array.isArray(value)) return false;
  const doc=value as Record<string,unknown>;
  if(Object.keys(doc).some(k=>k!=='slides') || !Array.isArray(doc.slides) || doc.slides.length!==1) return false;
  const slide=doc.slides[0];
  if(!slide || typeof slide!=='object' || Object.keys(slide).some(k=>!['id','width','height','elements'].includes(k)) || !validId(slide.id) || !Array.isArray(slide.elements) || slide.elements.length>800) return false;
  const finite=(n:unknown)=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=100000;
  if(!finite(slide.width)||!finite(slide.height)||slide.width===0||slide.height===0) return false;
  const ids=new Set<string>(), shapes=new Set<string>();
  for(const element of slide.elements) {
    if(!element || typeof element!=='object' || !validId(element.id) || ids.has(element.id)) return false;
    ids.add(element.id);
    const common=['type','id'];
    if(element.type==='connector') {
      if(Object.keys(element).some(k=>![...common,'from','to'].includes(k)) || typeof element.from!=='string' || typeof element.to!=='string') return false;
    } else if(element.type==='text'||element.type==='shape') {
      const prop=element.type==='text'?'text':'kind';
      if(Object.keys(element).some(k=>![...common,'x','y','width','height',prop].includes(k)) || !['x','y','width','height'].every(k=>finite(element[k])) || element.width<=0 || element.height<=0 || element.x+element.width>slide.width || element.y+element.height>slide.height || typeof element[prop]!=='string' || element[prop].length>160 || !xmlText(element[prop])) return false;
      if(element.type==='shape') shapes.add(element.id);
    } else return false;
  }
  return shapes.size>0 && slide.elements.every((e:Element)=>e.type!=='connector'||(shapes.has(e.from)&&shapes.has(e.to))) && new TextEncoder().encode(JSON.stringify(doc)).length<=256*1024;
}

/** Injection boundary only. No PPTX serializer is supplied by this module. */
export async function exportPresentation(graph:Parameters<typeof toPresentationDocument>[0], exporter:{export(document:ReturnType<typeof toPresentationDocument>):Promise<Uint8Array>}):Promise<Uint8Array> {
  return exporter.export(toPresentationDocument(graph));
}
