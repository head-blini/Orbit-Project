import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Controller } from './controller.ts';
import { AppError } from './controller.ts';

function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new AppError('JSON_REQUIRED',415);
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>18000)throw new AppError('BODY_TOO_LARGE',413);chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw new AppError('INVALID_JSON',400);}
}
export function createHttpServer(controller:Controller,assets:string){
  const sessions=new Map<string,{csrf:string;expires:number}>();
  const server=createServer((req,res)=>{void handle(req,res).catch(e=>{
    if(res.headersSent){res.end();return;}
    json(res,e instanceof AppError?e.status:500,{error:e instanceof AppError?e.message:'INTERNAL_ERROR'});
  });});
  server.requestTimeout=15000;server.headersTimeout=10000;
  async function handle(req:IncomingMessage,res:ServerResponse){
    const address=server.address();if(!address||typeof address==='string')throw new AppError('UNAVAILABLE',503);
    const host=`127.0.0.1:${address.port}`,origin=`http://${host}`;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const url=new URL(req.url??'/',origin);const cookieName=`aicc_${address.port}`;
    if(req.headers.host!==host || (req.headers.origin!==undefined&&req.headers.origin!==origin))throw new AppError('ORIGIN_REJECTED',403);
    if(url.pathname.startsWith('/api/') && (req.headers['sec-fetch-site']==='cross-site'||(req.headers.referer&&new URL(req.headers.referer).origin!==origin)))throw new AppError('ORIGIN_REJECTED',403);
    const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session=cookie?sessions.get(cookie):undefined;
    if(req.method==='GET'&&url.pathname==='/api/session'){
      let csrf=session&&session.expires>Date.now()?session.csrf:null;
      if(!csrf){
        for(const [id,s] of sessions)if(s.expires<=Date.now())sessions.delete(id);
        if(sessions.size>=64)throw new AppError('SESSION_LIMIT',429);
        const id=randomBytes(32).toString('hex');csrf=randomBytes(32).toString('hex');sessions.set(id,{csrf,expires:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
      }
      json(res,200,{csrfToken:csrf});return;
    }
    if(url.pathname.startsWith('/api/')){
      if(!session||session.expires<=Date.now())throw new AppError('SESSION_REQUIRED',401);
      if(req.method==='POST'){
        const token=req.headers['x-csrf-token'];
        if(req.headers.origin!==origin||typeof token!=='string'||token.length!==64||!timingSafeEqual(Buffer.from(token),Buffer.from(session.csrf)))throw new AppError('CSRF_REJECTED',403);
        const data=await body(req);
        if(url.pathname==='/api/connect'){
          if(Object.keys(data).length)throw new AppError('INVALID_FIELDS',400);await controller.connect();json(res,200,controller.snapshot());return;
        }
        if(url.pathname==='/api/runs'){
          if(Object.keys(data).sort().join(',')!=='prompt,requestId')throw new AppError('INVALID_FIELDS',400);
          const run=await controller.submit(data as {requestId:string;prompt:string});json(res,200,run);return;
        }
        const match=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/interrupt$/);
        if(match){if(Object.keys(data).length)throw new AppError('INVALID_FIELDS',400);await controller.interrupt(match[1]);json(res,200,controller.snapshot());return;}
      }
      if(req.method==='GET'&&url.pathname==='/api/state'){json(res,200,controller.snapshot());return;}
      if(req.method==='GET'&&url.pathname==='/api/events'){
        const value=req.headers['last-event-id']??url.searchParams.get('after')??'0';const after=Number(value);
        if(!Number.isSafeInteger(after)||after<0||after>controller.store.lastSeq())throw new AppError('INVALID_CURSOR',400);
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
        let cursor=after,waiting=false,closed=false,scheduled:NodeJS.Immediate|undefined;
        const pump=()=>{
          if(waiting||closed||res.destroyed||res.writableEnded)return;
          const page=controller.store.eventsAfter(cursor,100);
          for(const e of page){cursor=e.seq;if(!res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)){waiting=true;return;}}
          if(page.length===100&&!scheduled)scheduled=setImmediate(()=>{scheduled=undefined;pump();});
        };
        const drain=()=>{waiting=false;pump();};
        controller.store.on('event',pump);res.on('drain',drain);
        pump();if(!waiting)res.write(': connected\n\n');
        const heartbeat=setInterval(()=>{if(!waiting&&!closed&&!res.writableEnded&&!res.destroyed)waiting=!res.write(': heartbeat\n\n');},15000);
        const expired=setTimeout(()=>res.end(),Math.max(1,session.expires-Date.now()));
        const cleanup=()=>{closed=true;clearInterval(heartbeat);clearTimeout(expired);if(scheduled)clearImmediate(scheduled);controller.store.off('event',pump);res.off('drain',drain);};
        res.on('close',cleanup);res.on('error',cleanup);return;
      }
      throw new AppError('NOT_FOUND',404);
    }
    const files:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/app.css':['app.css','text/css']};
    const file=files[url.pathname];if(req.method!=='GET'||!file)throw new AppError('NOT_FOUND',404);
    try{const bytes=await readFile(resolve(assets,file[0]));res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8'});res.end(bytes);}
    catch{throw new AppError('BUILD_REQUIRED',503);}
  }
  return server;
}
