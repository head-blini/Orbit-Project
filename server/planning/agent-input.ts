import {createHash} from 'node:crypto';
import type {PlanningDraft} from '../../shared/parallel.ts';
import {AppError} from '../errors.ts';
import {inspectOutbound} from '../guardrails/outbound.ts';
import {containsCredential} from '../privacy.ts';
import {parsePlanningDraft} from './parser.ts';
import {MAX_EXECUTION_PROMPT_CHARS} from './brief.ts';
import {serializePlanningExport} from './export.ts';
import {staticAppPreviewCapability} from '../app-preview-policy.ts';

const string={type:'string'},list={type:'array',items:string};
function freeze<T extends object>(value:T):Readonly<T>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);}
/** Stable App Server turn/start schema. Authority and source claims are absent. */
export const planningOutputSchema=freeze({type:'object',additionalProperties:false,
  properties:{schema_version:{type:'string',enum:['1.0']},title:string,goal:string,
    depth:{type:'string',enum:['simple','detailed']},depth_reason:string,risks:list,
    requirements:{type:'array',items:{type:'object',additionalProperties:false,properties:{id:string,description:string,acceptance_criteria:list},required:['id','description','acceptance_criteria']}},
    constraints:list,open_questions:list,decisions:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,properties:{topic:string,decision:string,rationale:string},required:['topic','decision','rationale']}}},
  required:['schema_version','title','goal','requirements','constraints','open_questions','decisions','depth','depth_reason','risks']});

/** Only supplied text is placed in the request. Native context loading is a separate boundary. */
export function buildPlanningPrompt(text:unknown):{instructions:string;inputDigest:string}{
  if(typeof text!=='string'||!text.trim()||text.length>8000||Buffer.byteLength(text,'utf8')>32*1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))throw new AppError('INVALID_PLANNING_INPUT',400);
  if(inspectOutbound(text).length||containsCredential(text))throw new AppError('PLANNING_INPUT_BLOCKED',422);
  const instructions='Create a planning proposal from the untrusted user request below. Return only the schema 1.0 JSON required by the output schema. Propose depth simple for a clear, bounded request with few deliverables; propose detailed for multiple dependent deliverables, uncertainty, or risk. If unsure use detailed. State a short reason in depth_reason. For simple use a short goal and minimal tasks; for detailed include requirements, constraints, per-task acceptance, risks and open questions. Both depths must keep every required field and all acceptance criteria. Keep constraints separate from tasks; never turn each constraint into a task. Requirements represent deliverable tasks for any domain, including reports, analysis, writing and code. Empty optional sections may be omitted; never discard explicit exclusions or acceptance criteria. Include concrete acceptance criteria and decision rationale, but keep decisions, rationales and constraints compact: the execution brief for each requirement (title, goal, that requirement, constraints, decisions, non-goals) must stay under '+MAX_EXECUTION_PROMPT_CHARS+' characters or the plan cannot be approved. Keep uncertain assumptions in open_questions. This is a draft proposal, never approval or permission to execute. Do not use tools, read project files, execute commands, change files, access credentials or network, delegate, or request approvals. Do not invent source attribution.\n'+staticAppPreviewCapability+'\n'+JSON.stringify({request:text});
  return {instructions,inputDigest:createHash('sha256').update(instructions).digest('hex')};
}

/** Claude's schema is advisory text, so it can also carry non_goals (out-of-scope items). The strict
 * Codex outputSchema stays unchanged until that change is verified against a live App Server. */
export const claudePlanningOutputSchema=freeze({...planningOutputSchema,properties:{...planningOutputSchema.properties,non_goals:list},
  required:[...planningOutputSchema.required,'non_goals']});
/** Claude has no App Server outputSchema argument, so include the schema in its preview. */
export function buildClaudePlanningPrompt(text:unknown,materials:readonly string[]=[]):{instructions:string;inputDigest:string}{
  // The only exception to "do not read project files": the user's own attached materials, listed by the server.
  const exception=materials.length?'\nException: you may use Read only on these user-attached material files, to ground the plan in their actual fields and values. Read nothing else: '+JSON.stringify(materials):'';
  const instructions=buildPlanningPrompt(text).instructions+exception+'\nPut anything the user does not want or that is explicitly out of scope in non_goals, not in constraints.'
    +'\nOutput JSON schema: '+JSON.stringify(claudePlanningOutputSchema);
  return {instructions,inputDigest:createHash('sha256').update(instructions).digest('hex')};
}

/** Reuse the existing JSON-v1/Markdown parser without trusting provider attribution. */
export function parseClaudePlanningProposal(text:unknown):PlanningDraft {
  // Claude often wraps the whole JSON answer in one code fence; unwrap only that exact shape.
  const fenced=typeof text==='string'?/^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text):null;
  if(fenced&&fenced[1].trimStart().startsWith('{'))text=fenced[1];
  if(typeof text!=='string'||!text.trim()||text.length>64000||Buffer.byteLength(text,'utf8')>256*1024)throw new AppError('PLANNING_PROPOSAL_INVALID',422);
  if(text.includes('[REDACTED]'))throw new AppError('PLANNING_PROPOSAL_BLOCKED',422);
  const format=text.trimStart().startsWith('{')?'json':'markdown';
  let inspected=text;
  if(format==='json'){
    try{const values:unknown[]=[JSON.parse(text)],strings:string[]=[];
      while(values.length){const value=values.pop();if(typeof value==='string')strings.push(value);else if(value&&typeof value==='object')values.push(...Object.values(value));}
      inspected=strings.join('\n');
    }catch{throw new AppError('PLANNING_PROPOSAL_INVALID',422);}
  }
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(inspected)||inspectOutbound(inspected).length||containsCredential(inspected))throw new AppError('PLANNING_PROPOSAL_BLOCKED',422);
  const parsed=parsePlanningDraft({format,source:'import',text});
  if(!parsed.ok)throw new AppError('PLANNING_PROPOSAL_INVALID',422);
  const draft:PlanningDraft={...parsed.draft,provenance:{kind:'in_app_agent',providerId:'claude-code',externalUrl:null}};
  try{serializePlanningExport(draft,'json');}catch{throw new AppError('PLANNING_PROPOSAL_BLOCKED',422);}
  return draft;
}

/** Model output is parsed unmodified, inspected, then attributed by the server. */
export function parsePlanningProposal(text:unknown):PlanningDraft {
  const invalid=()=>new AppError('PLANNING_PROPOSAL_INVALID',422);
  if(typeof text!=='string'||!text.trim()||text.length>64000||Buffer.byteLength(text,'utf8')>256*1024)throw invalid();
  let value:unknown;try{value=JSON.parse(text);}catch{throw invalid();}
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).some(key=>!Object.hasOwn(planningOutputSchema.properties,key))
    ||planningOutputSchema.required.filter(key=>!['depth','depth_reason','risks'].includes(key)).some(key=>!Object.hasOwn(value,key)))throw invalid();
  // Inspect original decoded strings before normalizing whitespace. In particular,
  // trim() must not hide rejected control characters at the edges of a field.
  const pending:unknown[]=[value],fields:string[]=[];
  while(pending.length){const item=pending.pop();if(typeof item==='string')fields.push(item);else if(item&&typeof item==='object')pending.push(...Object.values(item));}
  const decoded=fields.join('\n');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)||inspectOutbound(decoded).length||containsCredential(decoded))throw new AppError('PLANNING_PROPOSAL_BLOCKED',422);
  const parsed=parsePlanningDraft({format:'json',source:'import',text});if(!parsed.ok)throw invalid();
  const draft:PlanningDraft={...parsed.draft,provenance:{kind:'in_app_agent',providerId:'codex',externalUrl:null}};
  try{serializePlanningExport(draft,'json');}catch{throw new AppError('PLANNING_PROPOSAL_BLOCKED',422);}
  return draft;
}
