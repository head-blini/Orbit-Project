import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstance } from '../server/instance.ts';
test('second instance cannot acquire shared data; clean shutdown permits restart',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'aicc-lock-')),'instance.sqlite');
  const release=acquireInstance(path);assert.throws(()=>acquireInstance(path),/INSTANCE_RUNNING/);release();
  const again=acquireInstance(path);again();
});
