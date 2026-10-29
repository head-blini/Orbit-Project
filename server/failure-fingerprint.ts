import {createHash} from 'node:crypto';
import {familyTuple,type FailureCategory,type FailureSource} from '../shared/failure-intelligence.ts';

/** Keep node:crypto outside the browser-shared contract. UTF-8 JSON tuple, lowercase SHA-256 hex. */
export function familyId(category:FailureCategory,code:unknown,source:FailureSource,commandIdOrGate?:string|null,runtime?:string|null):string {
  return createHash('sha256').update(JSON.stringify(familyTuple(category,code,source,commandIdOrGate,runtime))).digest('hex');
}
