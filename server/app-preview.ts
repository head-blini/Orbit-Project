import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {extname} from 'node:path';
import {AppError} from './controller.ts';
import type {WorkspaceFileSnapshot} from './workspace-fingerprint.ts';
import type {AppPreview,AppPreviewCatalog,AppPreviewInput} from '../shared/app-preview.ts';

const types:Record<string,string>={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
const ttl=10*60*1000;
const html=(path:string)=>/\.html?$/i.test(path);
function allowed(path:string){return path.length<=512&&!/[\\\x00-\x20\x7f#?%:]/.test(path)&&path.split('/').every(segment=>!!segment&&!segment.startsWith('.'))&&!!types[extname(path).toLowerCase()];}
type Snapshot={sourceDigest:string;files:WorkspaceFileSnapshot[]};
type RecordValue={view:AppPreview;files:Map<string,Buffer>;expires:number};

/** Immutable, ephemeral byte hosting only. Never runs repository scripts or reads a request path from disk. */
export class AppPreviewHost {
  private readonly read:(workspaceId:string)=>Snapshot;
  private readonly now:()=>number;
  private readonly records=new Map<string,RecordValue>();
  private readonly server=createServer((req,res)=>this.handle(req,res));
  private orbitOrigin='';
  private ownOrigin='';
  private stopped=false;
  private starting:Promise<void>|null=null;
  constructor(read:(workspaceId:string)=>Snapshot,now=Date.now){
    this.read=read;this.now=now;this.server.requestTimeout=5000;this.server.headersTimeout=5000;this.server.maxHeadersCount=40;
  }
  get origin(){return this.ownOrigin;}
  async listen(orbitOrigin:string){
    if(this.stopped||this.starting||!/^http:\/\/127\.0\.0\.1:\d+$/.test(orbitOrigin))throw new AppError('APP_PREVIEW_UNAVAILABLE',503);
    this.orbitOrigin=orbitOrigin;
    this.starting=new Promise<void>((resolve,reject)=>{const fail=(error:Error)=>{this.server.off('listening',ready);reject(error);};const ready=()=>{this.server.off('error',fail);resolve();};this.server.once('error',fail);this.server.once('listening',ready);this.server.listen(0,'127.0.0.1');});
    await this.starting;if(this.stopped)throw new AppError('APP_PREVIEW_UNAVAILABLE',503);
    const address=this.server.address();if(!address||typeof address==='string')throw new AppError('APP_PREVIEW_UNAVAILABLE',503);
    this.ownOrigin='http://127.0.0.1:'+address.port;this.server.unref();
    this.server.on('error',()=>{this.ownOrigin='';this.records.clear();});
  }
  catalog(workspaceId:string):AppPreviewCatalog {
    const snapshot=this.read(workspaceId);
    return {workspaceId,sourceDigest:snapshot.sourceDigest,entries:snapshot.files.filter(file=>file.presence==='present'&&allowed(file.path)&&html(file.path)).map(file=>file.path).sort()};
  }
  create(workspaceId:string,input:AppPreviewInput):AppPreview {
    if(!this.ownOrigin||this.stopped)throw new AppError('APP_PREVIEW_UNAVAILABLE',503);
    if(!input||Object.keys(input).sort().join(',')!=='entryPath,expectedSourceDigest'||typeof input.entryPath!=='string'||typeof input.expectedSourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedSourceDigest))throw new AppError('INVALID_FIELDS',400);
    const snapshot=this.read(workspaceId);
    if(snapshot.sourceDigest!==input.expectedSourceDigest)throw new AppError('APP_PREVIEW_STALE',409);
    const entries=snapshot.files.filter(file=>file.presence==='present'&&allowed(file.path));
    const entry=entries.find(file=>file.path===input.entryPath);
    if(!entry||!html(entry.path))throw new AppError('APP_PREVIEW_ENTRY',422);
    const files=new Map<string,Buffer>();let size=0;
    for(const file of entries){
      if(file.presence!=='present')continue;
      // Only the chosen HTML is navigable; other documents are not exposed as subresources.
      if(html(file.path)&&file.path!==entry.path)continue;
      size+=file.bytes.byteLength;
      if(files.size>=256||size>8*1024*1024||html(file.path)&&file.bytes.byteLength>1024*1024)throw new AppError('APP_PREVIEW_LIMIT',413);
      files.set(file.path,Buffer.from(file.bytes));
    }
    this.prune();const previous=[...this.records].find(([,record])=>record.view.workspaceId===workspaceId);
    if(!previous&&this.records.size>=4)throw new AppError('APP_PREVIEW_QUOTA',429);
    const id=randomBytes(32).toString('hex'),time=this.now();
    const view:AppPreview={id,workspaceId,entryPath:entry.path,sourceDigest:snapshot.sourceDigest,createdAt:new Date(time).toISOString(),expiresAt:new Date(time+ttl).toISOString(),url:this.ownOrigin+'/'+id+'/'+entry.path.split('/').map(encodeURIComponent).join('/'),fileCount:files.size};
    if(previous)this.records.delete(previous[0]);
    this.records.set(id,{view,files,expires:time+ttl});return {...view};
  }
  private prune(){for(const [id,record] of this.records)if(record.expires<=this.now())this.records.delete(id);}
  clear(){this.records.clear();}
  private handle(req:IncomingMessage,res:ServerResponse){
    // Cookie is deliberately never consulted or reflected. Different loopback ports do not isolate cookies.
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-DNS-Prefetch-Control','off');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox; frame-ancestors 'none'");
    const deny=(status:number)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end('Preview unavailable');};
    if(req.method!=='GET'){deny(405);return;}
    if(!this.ownOrigin||req.headers.host!==this.ownOrigin.slice(7)||req.headers.origin!==undefined&&req.headers.origin!=='null'&&req.headers.origin!==this.orbitOrigin){deny(403);return;}
    const raw=req.url??'',match=/^\/([a-f0-9]{64})\/([^?#]+)$/.exec(raw);
    if(!match){deny(404);return;}this.prune();const record=this.records.get(match[1]);
    if(!record){deny(404);return;}
    let path:string;try{path=decodeURIComponent(match[2]);}catch{deny(404);return;}
    if(!allowed(path)||path.split('/').map(encodeURIComponent).join('/')!==match[2]){deny(404);return;}
    const bytes=record.files.get(path);if(!bytes){deny(404);return;}
    const destination=req.headers['sec-fetch-dest'];
    if(html(path)?destination!=='iframe':!['script','style','image','font','empty'].includes(String(destination))){deny(403);return;}
    const base=this.ownOrigin+'/'+match[1]+'/';
    res.setHeader('Content-Security-Policy',`default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src data: ${base}; font-src data: ${base}; connect-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${this.orbitOrigin}`);
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=(), publickey-credentials-get=(), publickey-credentials-create=()');
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
    res.writeHead(200,{'Content-Type':types[extname(path).toLowerCase()],'Content-Length':bytes.byteLength});res.end(bytes);
  }
  async close(){
    this.stopped=true;this.records.clear();this.ownOrigin='';await this.starting?.catch(()=>{});this.server.closeAllConnections();
    if(this.server.listening)await new Promise<void>(resolve=>this.server.close(()=>resolve()));
  }
}
