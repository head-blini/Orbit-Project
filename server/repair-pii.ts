// The Quality Loop repair prompt is JSON.stringify({baseline,failures}) (Controller.repairQuality). Random digit runs in
// UUID/SHA-256 identifiers match phone/national-id patterns, so PII inspection blanks only baseline.id, baseline.digest
// and failures[].reviewerId when UUID/digest-shaped. Free text (criteria, evidence) and credential checks still see everything.
const opaqueId=(v:unknown)=>typeof v==='string'&&/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(v);
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Text for PII inspection of a repair prompt. Never send this text; non-JSON input is returned unchanged. */
export function repairPiiInspectionText(prompt:string):string {
  let value:unknown;
  try{value=JSON.parse(prompt);}catch{return prompt;}
  if(!isObject(value))return prompt;
  const {baseline,failures}=value;
  if(isObject(baseline))for(const key of ['id','digest'])if(opaqueId(baseline[key]))baseline[key]='';
  if(Array.isArray(failures))for(const failure of failures)if(isObject(failure)&&opaqueId(failure.reviewerId))failure.reviewerId='';
  return JSON.stringify(value);
}
