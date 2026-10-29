import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {FailureIndex} from './failure-index.ts';
import {FailureCaseStore,type FailureCaseSourceTable} from './failure-cases.ts';
import type {FailureIndexView} from '../shared/failure-intelligence.ts';

/** FE-4 HTTP facade. Reads never create tables or rows; the failure_cases table appears only on the first confirmed write. */
const TABLES:Record<string,FailureCaseSourceTable>={'run:event':'events','check:check':'verification_checks','quality:loop':'quality_loops',
  'integration:queue':'integration_queue','worker:refusal':'worker_integration_refusals','capability:execution':'capability_executions'};
const sha=/^[a-f0-9]{64}$/;

export class FailureIntelligenceService {
  private store:Store;private index:FailureIndex;private cases:FailureCaseStore|null=null;
  constructor(store:Store){this.store=store;this.index=new FailureIndex(store);}
  private project(projectId:string){if(!this.store.projects().some(p=>p.id===projectId))throw new AppError('PROJECT_NOT_FOUND',404);}
  private caseStore(){return this.cases??=new FailureCaseStore(this.store);}
  private hasCases(){return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='failure_cases'").get();}
  view(projectId:string):FailureIndexView{
    this.project(projectId);
    const at=new Map(this.index.list(projectId).map(r=>[r.id,r.at]));
    const families=this.index.families(projectId).map(f=>({familyId:f.familyId,category:f.tuple[0],code:f.tuple[1],source:f.tuple[2],
      commandIdOrGate:f.tuple[3],runtime:f.tuple[4],taskId:f.taskId,bindingDigest:f.bindingDigest,realCount:f.realCount,mockCount:f.mockCount,
      unknownCount:f.unknownCount,lastSeen:f.evidenceIds.map(id=>at.get(id)??'').sort().pop()??'',failureIds:f.evidenceIds,
      realFailureIds:f.occurrences.filter(o=>o.evidenceSource==='native'||o.evidenceSource==='local').map(o=>o.id)}));
    const known=new Set(families.flatMap(f=>f.failureIds));
    const cases=(this.hasCases()?this.caseStore().listCases():[]).filter(c=>known.has(c.failureId))
      .map(c=>({id:c.id,familyId:c.familyId,failureId:c.failureId,createdAt:c.provenance.createdAt,sourceTable:c.provenance.sourceTable}));
    return {projectId,families,hypotheses:this.index.hypotheses(projectId),cases};
  }
  createCase(projectId:string,input:{requestId:string;failureId:string;confirmed:boolean}){
    this.project(projectId);
    const failure=this.index.observations(projectId).find(o=>o.id===input.failureId);
    if(!failure)throw new AppError('FAILURE_NOT_FOUND',404);
    const sourceTable=TABLES[failure.id.split(':').slice(0,2).join(':')];
    if(!sourceTable)throw new AppError('FAILURE_CASE_SOURCE_UNSUPPORTED',400);
    const family=this.index.families(projectId).find(f=>f.evidenceIds.includes(failure.id))!;
    const store=this.caseStore();
    const created=store.create({requestId:input.requestId,familyId:family.familyId,failureId:failure.id,sourceTable,recordId:failure.recordId,
      recordBodySha256:store.sourceBodySha256(sourceTable,failure.recordId),expected:'same_failure',
      inputDigests:sha.test(failure.bindingDigest)?{baseline:failure.bindingDigest}:{},
      conditions:{...(failure.commandIdOrGate?{commandId:failure.commandIdOrGate}:{}),...(failure.runtime?{runtime:failure.runtime}:{})},
      indexerVersion:'fe-2',confirmed:input.confirmed as true});
    return {id:created.id,familyId:created.familyId,failureId:created.failureId,createdAt:created.provenance.createdAt,sourceTable};
  }
  deleteCase(projectId:string,caseId:string,confirmed:boolean){
    this.project(projectId);
    const known=new Set(this.index.list(projectId).map(r=>r.id));
    if(!this.hasCases()||!known.has(this.caseStore().getCase(caseId).failureId))throw new AppError('FAILURE_CASE_NOT_FOUND',404);
    return this.caseStore().delete(caseId,{confirmed:confirmed as true});
  }
}
