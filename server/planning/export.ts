import type { PlanningDraft } from '../../shared/parallel.ts';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../errors.ts';
import { inspectOutbound } from '../guardrails/outbound.ts';
import { containsCredential } from '../privacy.ts';
import { MAX_PLANNING_BYTES, PLANNING_EXPORT_MARKER, parsePlanningDraft, serializePlanningDraft } from './parser.ts';

const blocked = () => new AppError('PLANNING_EXPORT_BLOCKED',422);

function ordinaryMarkdown(draft:PlanningDraft):string {
  return [`# ${draft.title}`, '', '## Goal', draft.goal, '', '## Requirements',
    ...draft.requirements.flatMap(requirement=>[`### ${requirement.label}`,requirement.description,
      '#### Acceptance criteria',...requirement.acceptanceCriteria.map(text=>`- ${text}`),'']),
    '## Constraints',...draft.constraints.map(text=>`- ${text}`),'','## Open questions',
    ...draft.openQuestions.map(text=>`- ${text}`),'',
    ...(draft.decisions?.length?['## Decisions',...draft.decisions.flatMap(decision=>[`### ${decision.topic}`,
      '#### Decision',decision.decision,'#### Rationale',decision.rationale,''])]:[])].join('\n');
}

function roundtrips(text:string,format:'json'|'markdown',draft:PlanningDraft):boolean {
  const parsed=parsePlanningDraft({text,format,source:draft.source});
  return parsed.ok && isDeepStrictEqual(parsed.draft,draft);
}

/** Download-only serialization of the persisted normalized draft. No calls, rendering or mutation. */
export function serializePlanningExport(draft:PlanningDraft,format:'json'|'markdown'):{text:string;mime:string;extension:'json'|'md'} {
  try {
    if(format!=='json'&&format!=='markdown')throw blocked();
    const canonical=serializePlanningDraft(draft);
    let text=canonical;
    if(format==='markdown'){
      const ordinary=ordinaryMarkdown(draft);
      text=roundtrips(ordinary,'markdown',draft)?ordinary:`${PLANNING_EXPORT_MARKER}\n\`\`\`json\n${canonical}\n\`\`\`\n`;
    }
    if(Buffer.byteLength(text,'utf8')>MAX_PLANNING_BYTES)throw new AppError('PLANNING_EXPORT_TOO_LARGE',413);
    if(!roundtrips(text,format,draft))throw blocked();
    // Inspect decoded values, not JSON escape sequences. The chosen output bound
    // also bounds their combined size. Retain the existing credential detector's
    // coverage without its 64k output truncation being mistaken for a finding.
    const fields=[draft.title,draft.goal,...draft.requirements.flatMap(requirement=>[
      requirement.label,requirement.description,...requirement.acceptanceCriteria]),...draft.constraints,...draft.openQuestions,
      ...(draft.decisions??[]).flatMap(decision=>[decision.topic,decision.decision,decision.rationale]),
      ...(draft.provenance?[draft.provenance.kind,draft.provenance.providerId??'',draft.provenance.externalUrl??'',draft.provenance.author??'',
        ...(draft.provenance.references??[]).flatMap(reference=>[reference.title,reference.url])]:[])];
    const content=fields.join('\n');
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)||inspectOutbound(content).length)throw blocked();
    for(let offset=0;offset<content.length;offset+=16_000)
      if(containsCredential(content.slice(offset,offset+32_000)))throw blocked();
    return {text,mime:format==='json'?'application/json; charset=utf-8':'text/markdown; charset=utf-8',extension:format==='json'?'json':'md'};
  } catch(error) {
    if(error instanceof AppError)throw error;
    throw blocked();
  }
}
