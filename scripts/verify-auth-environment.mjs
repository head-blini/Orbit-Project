// No inference, thread creation, token refresh, or direct auth-file access by
// this probe. Native Codex uses its normal existing authentication discovery.
// Report only whether the existing ChatGPT login is visible through Rpc's env.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rpc } from '../server/rpc.ts';
import { findCodex, codexArgs } from '../server/codex.ts';

let rpc;
const report = {initialized:false, chatgptLoginVisible:false, inferenceRequested:false, refreshRequested:false};
try {
  const cwd = mkdtempSync(join(tmpdir(), 'orbit-auth-env-'));
  rpc = new Rpc(findCodex(), codexArgs(), cwd);
  await rpc.initialize();
  report.initialized = true;
  const result = await rpc.request('account/read', {refreshToken:false});
  report.chatgptLoginVisible = result.account?.type === 'chatgpt';
  if (!report.chatgptLoginVisible) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  if (rpc) await rpc.close();
  console.log(JSON.stringify(report));
}
