import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {controlPlaneStatus} from '../server/control-plane.ts';
test('policy view distinguishes attestation and unverified enforcement and offers no autonomous launch',async()=>{
  const hooks=registerHooks({load(url,context,next){if(url.endsWith('/web/control-plane.tsx'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText};return next(url,context);}});
  try{
    const {PolicyReport}=await import('../web/control-plane.tsx');const html=renderToStaticMarkup(createElement(PolicyReport,{report:controlPlaneStatus('ready')}));
    assert.match(html,/Orbit 직접 통제/);assert.match(html,/네이티브 런타임 의존/);assert.match(html,/미검증/);assert.match(html,/설정 응답 확인/);
    assert.match(html,/Autonomous Execution: 비활성/);assert.match(html,/토큰·비용 상한을 보장하지/);assert.match(html,/Windows E2E/);assert.doesNotMatch(html,/<button/);
  }finally{hooks.deregister();}
});
