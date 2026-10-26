import { validatePresentationDocument } from '../../web/visualization/presentation.ts';
import type { toPresentationDocument,PresentationDocument } from '../../web/visualization/presentation.ts';
import type { SequenceSlide } from '../../shared/sequence.ts';

type Presentation=ReturnType<typeof toPresentationDocument>;
type Element=Presentation['slides'][number]['elements'][number];
type Box=Extract<Element,{type:'shape'}>;
const A='http://schemas.openxmlformats.org/drawingml/2006/main';
const P='http://schemas.openxmlformats.org/presentationml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS=`xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}"`;
const WIDTH=9144000,HEIGHT=5143500;

function invalid():never {throw new Error('INVALID_PRESENTATION');}
// XML 1.0 characters, including valid surrogate pairs, without lossy replacement.
function xmlText(value:string):boolean {
  for(const char of value) {
    const n=char.codePointAt(0)!;
    if(!(n===9||n===10||n===13||(n>=32&&n<=0xd7ff)||(n>=0xe000&&n<=0xfffd)||(n>=0x10000&&n<=0x10ffff)))return false;
  }
  return true;
}
function escape(value:string):string {
  return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
}
function checked(value:unknown):PresentationDocument {
  if(!validatePresentationDocument(value))return invalid();
  if('format' in (value as object))return value as PresentationDocument;
  const doc=value as Presentation,slide=doc.slides[0];
  if(!slide.id.trim()||slide.id.length>160||!xmlText(slide.id))return invalid();
  for(const element of slide.elements) {
    if(!element.id.trim()||!xmlText(element.id))return invalid();
    if(element.type==='connector')continue;
    if(element.width<=0||element.height<=0||element.x+element.width>slide.width||element.y+element.height>slide.height)return invalid();
    if(!xmlText(element.type==='text'?element.text:element.kind))return invalid();
  }
  if(Buffer.byteLength(JSON.stringify(doc),'utf8')>256*1024)return invalid();
  return doc;
}

/** Small, bounded ZIP32 STORE writer. Entry names are fixed by this module, never user paths. */
function zip(parts:Record<string,string>):Uint8Array {
  const locals:Buffer[]=[],directory:Buffer[]=[];let offset=0;
  for(const [path,xml] of Object.entries(parts)) {
    const name=Buffer.from(path,'utf8'),body=Buffer.from(XML+xml,'utf8');
    let crc=0xffffffff;
    for(const byte of body) {crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(33,12); // 1980-01-01; deterministic, no user/environment metadata.
    local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
    locals.push(local,name,body);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);
    central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);
    central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);directory.push(central,name);
    offset+=local.length+name.length+body.length;
  }
  const central=Buffer.concat(directory),end=Buffer.alloc(22),count=Object.keys(parts).length;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,central,end]);
}
function relationships(entries:[string,string,string][]):string {
  return `<Relationships xmlns="${REL}">${entries.map(([id,type,target])=>`<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}
const GROUP='<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const COLOR_MAP='<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const COLOR_OVERRIDE='<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>';

function theme():string {
  const colors=['000000','FFFFFF','182C45','EDF5FF','355C86','4C7C59','A66A27','8158A6','27828A','AA4054','0563C1','954F72'];
  const names=['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
  const fill='<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const font='<a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/><a:cs typeface="Arial"/>';
  return `<a:theme xmlns:a="${A}" name="Orbit"><a:themeElements><a:clrScheme name="Orbit">${colors.map((c,i)=>`<a:${names[i]}><a:srgbClr val="${c}"/></a:${names[i]}>`).join('')}</a:clrScheme><a:fontScheme name="Orbit"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="Orbit"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525,19050,28575].map(w=>`<a:ln w="${w}">${fill}<a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

/** Native editable shapes/text and connectors; no images, external parts or macros.
 * Legacy single-slide diagrams keep their old sizing; sequence pages retain point coordinates.
 * Pure byte generation: no filesystem, process, network or authentication access.
 */
export function serializePresentation(value:unknown):Uint8Array {
  const doc=checked(value);
  if('format' in doc)return packageSlides(doc.slides.map(slide=>({id:slide.id,contents:sequenceContents(slide)})),Math.round(doc.slides[0].width*12700),Math.round(doc.slides[0].height*12700));
  const slide=doc.slides[0];
  const scale=Math.min(WIDTH/slide.width,HEIGHT/slide.height);
  const padX=(WIDTH-slide.width*scale)/2,padY=(HEIGHT-slide.height*scale)/2;
  const x=(v:number)=>Math.round(padX+v*scale),y=(v:number)=>Math.round(padY+v*scale),size=(v:number)=>Math.max(1,Math.round(v*scale));
  const ids=new Map(slide.elements.map((element,i)=>[element.id,i+2]));
  const shapes=new Map(slide.elements.filter((e):e is Box=>e.type==='shape').map(e=>[e.id,e]));
  const transform=(box:{x:number;y:number;width:number;height:number},extra='')=>`<a:xfrm${extra}><a:off x="${x(box.x)}" y="${y(box.y)}"/><a:ext cx="${size(box.width)}" cy="${size(box.height)}"/></a:xfrm>`;
  function render(element:Element):string {
    const id=ids.get(element.id)!,name=escape(element.id);
    if(element.type==='connector') {
      const from=shapes.get(element.from)!,to=shapes.get(element.to)!;
      const dx=to.x+to.width/2-from.x-from.width/2,dy=to.y+to.height/2-from.y-from.height/2;
      let start:{x:number;y:number;site:number},end:{x:number;y:number;site:number};
      const self=element.from===element.to;
      if(self) {start={x:from.x+from.width,y:from.y+from.height/2,site:3};end={x:from.x+from.width/2,y:from.y+from.height,site:2};}
      else if(Math.abs(dx)>=Math.abs(dy)) {
        start={x:from.x+(dx>=0?from.width:0),y:from.y+from.height/2,site:dx>=0?3:1};
        end={x:to.x+(dx>=0?0:to.width),y:to.y+to.height/2,site:dx>=0?1:3};
      } else {
        start={x:from.x+from.width/2,y:from.y+(dy>=0?from.height:0),site:dy>=0?2:0};
        end={x:to.x+to.width/2,y:to.y+(dy>=0?0:to.height),site:dy>=0?0:2};
      }
      const box={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};
      const flips=(start.x>end.x?' flipH="1"':'')+(start.y>end.y?' flipV="1"':'');
      return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr><a:stCxn id="${ids.get(from.id)}" idx="${start.site}"/><a:endCxn id="${ids.get(to.id)}" idx="${end.site}"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr>${transform(box,flips)}<a:prstGeom prst="${self?'bentConnector3':'line'}"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:srgbClr val="355C86"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>`;
    }
    const text=element.type==='text';
    const props=text?'<a:noFill/><a:ln><a:noFill/></a:ln>':'<a:solidFill><a:srgbClr val="EDF5FF"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="355C86"/></a:solidFill></a:ln>';
    // Presentation text is separate from its backing shape so both remain directly editable.
    const fontSize=Math.max(100,Math.min(2400,Math.round(13*scale/127)));
    const paragraphs=text?element.text.replace(/\r\n?/g,'\n').split('\n').map(line=>`<a:p><a:pPr/><a:r><a:rPr lang="ko-KR" sz="${fontSize}"><a:solidFill><a:srgbClr val="182C45"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/></a:rPr><a:t xml:space="preserve">${escape(line)}</a:t></a:r><a:endParaRPr lang="ko-KR"/></a:p>`).join(''):'';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${text?' txBox="1"':''}/><p:nvPr/></p:nvSpPr><p:spPr>${transform(element)}<a:prstGeom prst="${text?'rect':'roundRect'}"><a:avLst/></a:prstGeom>${props}</p:spPr>${text?`<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody>`:''}</p:sp>`;
  }
  const contents=[...slide.elements.filter(e=>e.type==='connector'),...slide.elements.filter(e=>e.type==='shape'),...slide.elements.filter(e=>e.type==='text')].map(render).join('');
  return packageSlides([{id:slide.id,contents}],WIDTH,HEIGHT);
}

function sequenceContents(slide:SequenceSlide):string {
  const point=(n:number)=>Math.round(n*12700);
  const transform=(x:number,y:number,w:number,h:number,extra='')=>`<a:xfrm${extra}><a:off x="${point(x)}" y="${point(y)}"/><a:ext cx="${point(w)}" cy="${point(h)}"/></a:xfrm>`;
  const fills={none:'<a:noFill/>',paper:'<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>',blue:'<a:solidFill><a:srgbClr val="EDF5FF"/></a:solidFill>',note:'<a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill>'};
  const stroke='<a:solidFill><a:srgbClr val="355C86"/></a:solidFill>';
  return slide.elements.map((e,i)=>{
    const id=i+2,name=escape(e.id);
    if(e.type==='line'){
      const flips=(e.x1>e.x2?' flipH="1"':'')+(e.y1>e.y2?' flipV="1"':'');
      return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${transform(Math.min(e.x1,e.x2),Math.min(e.y1,e.y2),Math.abs(e.x2-e.x1),Math.abs(e.y2-e.y1),flips)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="19050">${stroke}<a:prstDash val="${e.dash}"/><a:tailEnd type="${e.arrow}"/></a:ln></p:spPr></p:cxnSp>`;
    }
    const label=e.type==='label';
    const props=label?'<a:noFill/><a:ln><a:noFill/></a:ln>':`${fills[e.fill]}<a:ln w="12700">${e.stroke==='none'?'<a:noFill/>':stroke}</a:ln>`;
    const paragraphs=label?e.text.replace(/\r\n?/g,'\n').split('\n').map(line=>`<a:p><a:pPr algn="${e.align==='center'?'ctr':'l'}"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:spcAft><a:spcPts val="0"/></a:spcAft></a:pPr><a:r><a:rPr lang="ko-KR" sz="${Math.round(e.fontSize*100)}"><a:solidFill><a:srgbClr val="182C45"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/></a:rPr><a:t xml:space="preserve">${escape(line)}</a:t></a:r><a:endParaRPr lang="ko-KR" sz="${Math.round(e.fontSize*100)}"/></a:p>`).join(''):'';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${label?' txBox="1"':''}/><p:nvPr/></p:nvSpPr><p:spPr>${transform(e.x,e.y,e.width,e.height)}<a:prstGeom prst="${label?'rect':e.geometry}"><a:avLst/></a:prstGeom>${props}</p:spPr>${label?`<p:txBody><a:bodyPr wrap="none" lIns="0" rIns="0" tIns="0" bIns="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody>`:''}</p:sp>`;
  }).join('');
}

function packageSlides(slides:{id:string;contents:string}[],width:number,height:number):Uint8Array {
  const types:[string,string][]=[['presentation.xml','presentation.main'],...slides.map((_,i):[string,string]=>[`slides/slide${i+1}.xml`,'slide']),['slideMasters/slideMaster1.xml','slideMaster'],['slideLayouts/slideLayout1.xml','slideLayout'],['presProps.xml','presProps']];
  const slideParts:Record<string,string>={};
  slides.forEach((slide,i)=>{
    slideParts[`ppt/slides/slide${i+1}.xml`]=`<p:sld ${NS}><p:cSld name="${escape(slide.id)}"><p:spTree>${GROUP}${slide.contents}</p:spTree></p:cSld>${COLOR_OVERRIDE}</p:sld>`;
    slideParts[`ppt/slides/_rels/slide${i+1}.xml.rels`]=relationships([['rId1','slideLayout','../slideLayouts/slideLayout1.xml']]);
  });
  return zip({
    '[Content_Types].xml':`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types.map(([path,type])=>`<Override PartName="/ppt/${path}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
    '_rels/.rels':relationships([['rId1','officeDocument','ppt/presentation.xml']]),
    'ppt/presentation.xml':`<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_,i)=>`<p:sldId id="${256+i}" r:id="rId${i+2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels':relationships([['rId1','slideMaster','slideMasters/slideMaster1.xml'],...slides.map((_,i):[string,string,string]=>[`rId${i+2}`,'slide',`slides/slide${i+1}.xml`]),[`rId${slides.length+2}`,'theme','theme/theme1.xml'],[`rId${slides.length+3}`,'presProps','presProps.xml']]),
    ...slideParts,
    'ppt/slideMasters/slideMaster1.xml':`<p:sldMaster ${NS}><p:cSld><p:spTree>${GROUP}</p:spTree></p:cSld>${COLOR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels':relationships([['rId1','slideLayout','../slideLayouts/slideLayout1.xml'],['rId2','theme','../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml':`<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld>${COLOR_OVERRIDE}</p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels':relationships([['rId1','slideMaster','../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml':theme(),
    'ppt/presProps.xml':`<p:presentationPr ${NS}/>`
  });
}
