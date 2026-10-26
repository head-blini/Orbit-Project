import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir as systemTmpdir} from 'node:os';
import {tmpdir} from './temp.ts';
import {createBedrockTemporary,removeBedrockTemporary} from '../server/providers/bedrock-temporary.ts';

test('default Bedrock temporary input uses the canonical OS temp root and cleans its owned files',()=>{
  const id=randomUUID(),temporary=createBedrockTemporary(id);
  try{assert.equal(dirname(temporary.path),realpathSync(systemTmpdir()));assert.equal(existsSync(temporary.config),true);}
  finally{removeBedrockTemporary(id);}
  assert.equal(existsSync(temporary.path),false);
});
test('an explicitly configured linked temporary root remains rejected',t=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-temp-policy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const alias=join(root,'alias');symlinkSync(tmpdir(),alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>createBedrockTemporary(randomUUID(),alias),/BEDROCK_TEMPORARY_INPUT_FAILED/);
});
