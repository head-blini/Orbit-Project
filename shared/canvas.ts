/** Inert fixed primitives shared by SVG preview and native editable PPTX. Coordinates are points. */
export type CanvasPrimitive =
  | {type:'box';id:string;x:number;y:number;width:number;height:number;geometry:'rect'|'ellipse'|'diamond';fill:'none'|'paper'|'blue'|'note'|'ink';stroke:'none'|'solid'}
  | {type:'line';id:string;x1:number;y1:number;x2:number;y2:number;dash:'solid'|'dash';arrow:'none'|'triangle'}
  | {type:'label';id:string;x:number;y:number;width:number;height:number;text:string;fontSize:number;align:'left'|'center'};
export interface CanvasSlide {id:string;width:number;height:number;elements:CanvasPrimitive[]}
export interface CanvasPresentationDocument {format:'canvas-v1';slides:CanvasSlide[]}
export const CANVAS_LIMITS=Object.freeze({width:3600,height:1200,pages:32,elementsPerPage:800,elements:8000,bytes:1024*1024});
