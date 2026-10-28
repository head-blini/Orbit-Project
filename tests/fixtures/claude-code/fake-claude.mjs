// Synthetic Claude Code `-p --output-format stream-json` emitter. No credentials, no network.
// Scenario comes from the prompt read on stdin so the adapter's real stdin path is exercised.
import {argv,stdin,stdout,exit} from 'node:process';
let prompt='';stdin.setEncoding('utf8');for await(const chunk of stdin)prompt+=chunk;
const session='11111111-2222-4333-8444-555555555555';
const emit=value=>stdout.write(JSON.stringify(value)+'\n');
const init=()=>emit({type:'system',subtype:'init',session_id:session,cwd:process.cwd(),model:'synthetic-model',permissionMode:argv.includes('acceptEdits')?'acceptEdits':'default',apiKeySource:'none',tools:['Read'],mcp_servers:[]});
const assistant=(content,extra={})=>emit({type:'assistant',session_id:session,message:{content},...extra});
const result=(extra)=>emit({type:'result',subtype:'success',session_id:session,is_error:false,terminal_reason:'completed',num_turns:1,duration_ms:5,total_cost_usd:0,result:'',...extra});
const quota=status=>emit({type:'rate_limit_event',session_id:session,rate_limit_info:{status,rateLimitType:'five_hour',resetsAt:1793160000,unifiedWindows:{five_hour:{utilization:status==='rejected'?1:0.08,resetsAt:1793160000,status},seven_day:{utilization:0.42,resetsAt:1793437200,status:'allowed'}}}});
const scenario=prompt.trim().split(/\s+/)[0];
if(scenario==='args'){init();assistant([{type:'text',text:JSON.stringify(argv.slice(2))}]);result({result:'args'});exit(0);}
if(scenario==='ok'){init();assistant([{type:'tool_use',id:'t1',name:'Read',input:{file_path:'/secret/path/never-store'}}]);emit({type:'user',session_id:session,message:{content:[{type:'tool_result',tool_use_id:'t1',content:'raw tool output never-store'}]}});quota('allowed');assistant([{type:'text',text:'Done. key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'}]);result({result:'Done.'});exit(0);}
if(scenario==='auth'){init();assistant([{type:'text',text:'Not logged in · Please run /login'}],{error:'authentication_failed',is_api_error_message:true});result({is_error:true,terminal_reason:'api_error',result:'Not logged in'});exit(1);}
if(scenario==='quota'){init();quota('rejected');assistant([{type:'text',text:'limit reached'}],{error:'rate_limit',is_api_error_message:true});result({is_error:true,terminal_reason:'api_error',result:'limit'});exit(1);}
if(scenario==='noresult'){init();assistant([{type:'text',text:'partial'}]);exit(0);}
if(scenario==='garbage'){stdout.write('not json\n');init();stdout.write('{"type":"unknown_future_event","x":1}\n');result({result:'fine'});exit(0);}
if(scenario==='hang'){init();assistant([{type:'text',text:'working'}]);process.on('SIGINT',()=>{exit(130);});setInterval(()=>{},1000);}
if(scenario==='ignore-sigint'){init();process.on('SIGINT',()=>{});setInterval(()=>{},1000);}
