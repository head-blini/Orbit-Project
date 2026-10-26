import type { WorkflowDefinition } from '../shared/workflows.ts';
import { AppError } from './errors.ts';
import { readDataRecord } from './guardrails/outbound.ts';
import { containsCredential } from './privacy.ts';

const invalid=()=>new AppError('INVALID_WORKFLOW_DEFINITION',400);
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)&&!containsCredential(value);

function list(value:unknown,minimum:number,maximum:number):unknown[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<minimum||value.length>maximum
    ||Reflect.ownKeys(value).length!==value.length+1)throw invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value),result:unknown[]=[];
  for(let index=0;index<value.length;index++){
    const descriptor=descriptors[String(index)];if(!descriptor||!('value' in descriptor))throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

/** Choose the earliest declared currently-ready step, including newly-ready
 * steps. A stalled bounded traversal rejects disconnected cycles as well. */
function order(definition:WorkflowDefinition):string[]{
  const complete=new Set<string>(),result:string[]=[];
  while(result.length<definition.steps.length){
    const next=definition.steps.find(step=>!complete.has(step.id)&&step.dependsOn.every(id=>complete.has(id)));
    if(!next)throw invalid();complete.add(next.id);result.push(next.id);
  }
  return result;
}

/** Pure shape/DAG validation. commandId is a reference, not execution authority:
 * the service must separately resolve it against trusted server commands. */
export function normalizeWorkflowDefinition(input:unknown):WorkflowDefinition {
  try{
    const data=readDataRecord(input,['name','steps']);
    if(!data||typeof data.name!=='string'||/[\x00-\x1f\x7f]/.test(data.name))throw invalid();
    const name=data.name.trim();if(!name||name.length>120||containsCredential(name))throw invalid();
    const ids=new Set<string>();
    const steps:WorkflowDefinition['steps']=list(data.steps,1,12).map(input=>{
      const step=readDataRecord(input,['id','commandId','dependsOn']);
      if(!step||!identifier(step.id)||!identifier(step.commandId)||ids.has(step.id))throw invalid();
      ids.add(step.id);const seen=new Set<string>(),dependsOn:string[]=[];
      for(const dependency of list(step.dependsOn,0,12)){
        if(!identifier(dependency)||dependency===step.id||seen.has(dependency))throw invalid();
        seen.add(dependency);dependsOn.push(dependency);
      }
      return {id:step.id,commandId:step.commandId,dependsOn};
    });
    for(const step of steps)if(step.dependsOn.some(id=>!ids.has(id)))throw invalid();
    const definition:WorkflowDefinition={name,steps};order(definition);
    for(const step of steps){Object.freeze(step.dependsOn);Object.freeze(step);}Object.freeze(steps);Object.freeze(definition);
    return definition;
  }catch{throw invalid();}
}

/** Validate even typed callers, return a fresh order, and never mutate input. */
export function workflowStepOrder(definition:WorkflowDefinition):string[] {
  return order(normalizeWorkflowDefinition(definition));
}
