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

/** Compatibility names preserve the existing sequence format and geometry. */
import type { CanvasPrimitive,CanvasSlide } from './canvas.ts';
export type SequencePrimitive=CanvasPrimitive;
export type SequenceSlide=CanvasSlide;
export interface SequencePresentationDocument {format:'sequence-v1';slides:SequenceSlide[]}
export {CANVAS_LIMITS as SEQUENCE_CANVAS_LIMITS} from './canvas.ts';
