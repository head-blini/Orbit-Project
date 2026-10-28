import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {claudeArgs,claudeEnv,findClaude,parseClaudeLine,ClaudeCodeRun,type ClaudeEvent} from '../server/runtimes/claude-code.ts';

const fake=fileURLToPath(new URL('./fixtures/claude-code/fake-claude.mjs',import.meta.url));
// Launch the synthetic emitter with the adapter's real argument list and stdin prompt.
const fakeSpawn:typeof spawn=((_:string,args:readonly string[],options:object)=>spawn(process.execPath,[fake,...args],options)) as typeof spawn;
async function run(prompt:string,options:Partial<ConstructorParameters<typeof ClaudeCodeRun>[0]>={}){
  const events:ClaudeEvent[]=[];
  const r=new ClaudeCodeRun({executable:'/fake/claude',cwd:process.cwd(),mode:'read',spawn:fakeSpawn,env:{PATH:process.env.PATH},...options});
  const outcome=await r.start(prompt,event=>events.push(event));
  return {outcome,events,run:r};
}

test('arguments isolate tools, MCP, settings and permission prompts for each mode',()=>{
  const read=claudeArgs({mode:'read'}),write=claudeArgs({mode:'write'});
  for(const args of [read,write]){
    for(const flag of ['-p','--restricted','--strict-mcp-config','--disable-slash-commands','--no-chrome'])assert.ok(args.includes(flag),flag);
    assert.deepEqual(args.slice(args.indexOf('--output-format'),args.indexOf('--output-format')+2),['--output-format','stream-json']);
    assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
    assert.equal(args[args.indexOf('--permission-prompts')+1],'none');
    assert.ok(!args.some(arg=>/Bash|WebFetch|WebSearch|bypassPermissions|dangerously/i.test(arg)),'no shell, network tools or bypass');
  }
  assert.equal(read[read.indexOf('--tools')+1],'Read,Grep,Glob');assert.equal(read[read.indexOf('--permission-mode')+1],'plan');
  assert.equal(write[write.indexOf('--tools')+1],'Read,Grep,Glob,Edit,Write');assert.equal(write[write.indexOf('--permission-mode')+1],'acceptEdits');
  const resumed=claudeArgs({mode:'read',resume:'11111111-2222-4333-8444-555555555555'});
  assert.equal(resumed[resumed.indexOf('--resume')+1],'11111111-2222-4333-8444-555555555555');
  assert.throws(()=>claudeArgs({mode:'read',resume:'--dangerously-skip-permissions'}),/INVALID_SESSION/);
  assert.ok(!read.includes('--model'));assert.equal(claudeArgs({mode:'read',model:'sonnet'}).at(-1),'sonnet');
  assert.throws(()=>claudeArgs({mode:'read',model:'-x'}),/INVALID_MODEL/);
});

test('child environment never forwards API keys or tokens, so subscription auth is never switched to API billing',()=>{
  const env=claudeEnv({PATH:'/bin',HOME:'/h',USER:'u',ANTHROPIC_API_KEY:'sk-ant-x',ANTHROPIC_AUTH_TOKEN:'t',CLAUDE_CODE_OAUTH_TOKEN:'o',AWS_SECRET_ACCESS_KEY:'s',CLAUDE_CODE_USE_BEDROCK:'1',NODE_OPTIONS:'--require x'},'darwin');
  assert.deepEqual(Object.keys(env).sort(),['HOME','PATH','USER']);
});

test('findClaude resolves only a native executable on an absolute PATH entry',()=>{
  assert.throws(()=>findClaude({PATH:'relative/bin'},'darwin'),/CLAUDE_NOT_INSTALLED/);
  assert.throws(()=>findClaude({PATH:''},'darwin'),/CLAUDE_NOT_INSTALLED/);
});

test('stream events are projected without tool inputs, tool outputs or credentials',async()=>{
  const {outcome,events}=await run('ok');
  assert.equal(outcome.status,'completed');assert.equal(outcome.sessionId,'11111111-2222-4333-8444-555555555555');assert.equal(outcome.exit,'observed');
  assert.deepEqual(events.map(e=>e.kind),['session','tool','quota','message','result']);
  const serialized=JSON.stringify(events)+JSON.stringify(outcome);
  assert.doesNotMatch(serialized,/never-store|secret\/path|sk-ant-abcdef/);
  assert.equal(events.find(e=>e.kind==='tool')!.kind==='tool'&&(events.find(e=>e.kind==='tool') as {name:string}).name,'Read');
  const session=events[0] as Extract<ClaudeEvent,{kind:'session'}>;assert.equal(session.auth,'subscription');
  const quota=events.find(e=>e.kind==='quota') as Extract<ClaudeEvent,{kind:'quota'}>;
  assert.deepEqual(quota.windows.map(w=>[w.id,w.status]),[['five_hour','allowed'],['seven_day','allowed']]);
  assert.equal(quota.windows[0].resetsAt,'2026-10-28T04:00:00.000Z');
});

test('the adapter passes the prompt on stdin, never as an argument',async()=>{
  const {events}=await run('args --dangerously-skip-permissions');
  const text=(events.find(e=>e.kind==='message') as {text:string}).text;
  assert.doesNotMatch(text,/dangerously-skip-permissions/);
});

test('a result with is_error is never success: login and quota failures are classified',async()=>{
  const auth=await run('auth');assert.equal(auth.outcome.status,'auth_required');
  const quota=await run('quota');assert.equal(quota.outcome.status,'quota_exhausted');
  assert.ok(quota.events.some(e=>e.kind==='quota'&&e.status==='rejected'));
});

test('a process that exits without a result event is unknown, not completed',async()=>{
  const {outcome}=await run('noresult');assert.equal(outcome.status,'unknown');assert.equal(outcome.exit,'observed');
});

test('malformed and unknown lines are counted and ignored without failing the run',async()=>{
  const {outcome,events}=await run('garbage');
  assert.equal(outcome.status,'completed');assert.equal(outcome.ignoredLines,2);
  assert.ok(!events.some(e=>JSON.stringify(e).includes('unknown_future_event')));
  assert.equal(parseClaudeLine('{"type":"assistant","message":{"content":"bad"}}'),null);
});

test('interrupt_request_not_exit_confirmation: interruption is confirmed only by an observed exit',async()=>{
  const events:ClaudeEvent[]=[];
  const r=new ClaudeCodeRun({executable:'/fake/claude',cwd:process.cwd(),mode:'read',spawn:fakeSpawn,env:{PATH:process.env.PATH}});
  const pending=r.start('hang',event=>{events.push(event);if(event.kind==='message')assert.equal(r.interrupt(),'requested');});
  const outcome=await pending;
  assert.equal(outcome.status,'interrupted');assert.equal(outcome.exit,'observed');assert.equal(r.interrupt(),'not_running');
});

test('an interrupt that is ignored stays unconfirmed until the kill deadline and is reported as such',async()=>{
  const r=new ClaudeCodeRun({executable:'/fake/claude',cwd:process.cwd(),mode:'read',spawn:fakeSpawn,env:{PATH:process.env.PATH},killAfterMs:200});
  const pending=r.start('ignore-sigint',event=>{if(event.kind==='session')r.interrupt();});
  const outcome=await pending;
  assert.equal(outcome.status,'interrupted');assert.equal(outcome.forced,true);
});

test('a run cannot be started twice',async()=>{
  const r=new ClaudeCodeRun({executable:'/fake/claude',cwd:process.cwd(),mode:'read',spawn:fakeSpawn,env:{PATH:process.env.PATH}});
  const first=r.start('ok',()=>{});await assert.rejects(r.start('ok',()=>{}),/RUN_ALREADY_STARTED/);await first;
});
