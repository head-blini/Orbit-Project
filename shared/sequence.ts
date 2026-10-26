/** Inert, bounded subset of Mermaid sequenceDiagram. No markup, links or runtime code. */
export type SequenceEvent =
  | {type:'message';from:string;to:string;arrow:'solid'|'dashed';text:string}
  | {type:'note';placement:'left'|'right'|'over';participants:[string]|[string,string];text:string}
  | {type:'activation';participant:string;action:'activate'|'deactivate'}
  | {type:'fragment-start';id:string;kind:'alt'|'opt'|'loop'|'par';text:string}
  | {type:'fragment-branch';id:string;kind:'else'|'and';text:string}
  | {type:'fragment-end';id:string};
export interface SequenceDiagram {
  kind:'sequence';
  participants:{id:string;label:string;kind:'participant'|'actor'}[];
  autonumber:boolean;
  events:SequenceEvent[];
}
export const SEQUENCE_LIMITS=Object.freeze({participants:10,events:120,notes:24,fragments:16,depth:4,activationDepth:4,lines:1024,text:160,sourceBytes:256*1024,issues:32});

/** Fixed primitives shared by SVG preview and native editable PPTX. Coordinates are points. */
export type SequencePrimitive =
  | {type:'box';id:string;x:number;y:number;width:number;height:number;geometry:'rect'|'ellipse';fill:'none'|'paper'|'blue'|'note';stroke:'none'|'solid'}
  | {type:'line';id:string;x1:number;y1:number;x2:number;y2:number;dash:'solid'|'dash';arrow:'none'|'triangle'}
  | {type:'label';id:string;x:number;y:number;width:number;height:number;text:string;fontSize:number;align:'left'|'center'};
export interface SequenceSlide {id:string;width:number;height:number;elements:SequencePrimitive[]}
export interface SequencePresentationDocument {format:'sequence-v1';slides:SequenceSlide[]}
export const SEQUENCE_CANVAS_LIMITS=Object.freeze({width:3600,height:1200,pages:32,elementsPerPage:800,elements:8000,bytes:1024*1024});
