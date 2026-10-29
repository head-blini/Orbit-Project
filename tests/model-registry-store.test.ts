import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {ModelRegistryStore} from '../server/model-registry-store.ts';
import {AppError} from '../server/errors.ts';

const provider=(id='provider')=>({id,kind:'provider',label:'Local API',connection:{adapterId:'local',endpoint:'http://127.0.0.1:8080/v1',locality:'loopback',auth:{kind:'none'},projectPaths:['/tmp/registry-project'],timeoutMs:1000,maxOutputTokens:100}});
const model=(id='model',providerId='provider',modelId='example/model')=>({id,kind:'model',label:'Model',providerId,modelId});
const error=(code:string,status=400)=>(e:unknown)=>e instanceof AppError&&e.message===code&&e.status===status;
function fixture(){const store=new Store(':memory:');return {store,registry:new ModelRegistryStore(store)};}

test('CRUD defaults, revision, idempotent disable and minimal audit',()=>{
  const {store,registry}=fixture();try{
    const created=registry.create(provider());assert.equal(created.enabled,false);assert.equal(created.origin,'user');assert.equal(created.revision,1);
    assert.deepEqual(created.declaredCapabilities,[]);assert.equal(created.cost.source,'unknown');assert.equal(created.cost.unitPrice,null);
    const saved=registry.create({...model(),declaredCapabilities:['streaming','tools']});
    assert.equal('executableCapabilities' in saved,false);assert.equal('ready' in saved,false);
    const changed=registry.update('provider',{expectedRevision:1,entry:{...provider(),enabled:true}});
    assert.equal(changed.revision,2);assert.equal(changed.createdAt,created.createdAt);
    const disabled=registry.disable('provider',{expectedRevision:2});assert.equal(disabled.enabled,false);assert.equal(disabled.revision,3);
    const seq=store.lastSeq();assert.deepEqual(registry.disable('provider',{expectedRevision:3}),disabled);assert.equal(store.lastSeq(),seq);
    assert.equal(registry.get('model').enabled,false);assert.equal(registry.list().length,2);
    assert.deepEqual(store.eventsAfter(0).map(e=>e.data),[
      {entryId:'provider',revision:1,code:'REGISTRY_CREATED'},{entryId:'model',revision:1,code:'REGISTRY_CREATED'},
      {entryId:'provider',revision:2,code:'REGISTRY_UPDATED'},{entryId:'provider',revision:3,code:'REGISTRY_DISABLED'},
    ]);
    assert.equal(store.lastSeq(),seq);
  }finally{store.close();}
});

test('unknown, wrong-kind and self references; duplicate IDs and provider/model pairs',()=>{
  const {store,registry}=fixture();try{
    assert.throws(()=>registry.create(model()),error('REGISTRY_PROVIDER_NOT_FOUND'));
    registry.create(provider());registry.create(model());
    assert.throws(()=>registry.create(provider()),error('REGISTRY_ID_CONFLICT',409));
    assert.throws(()=>registry.create(model('another')),error('REGISTRY_MODEL_CONFLICT',409));
    assert.throws(()=>registry.create(model('wrong','model')),error('REGISTRY_PROVIDER_KIND'));
    assert.throws(()=>registry.create(model('self','self')),error('REGISTRY_PROVIDER_KIND'));
    registry.create(provider('second'));registry.create(model('other','second'));
    assert.throws(()=>registry.update('other',{expectedRevision:1,entry:model('other')}),error('REGISTRY_MODEL_CONFLICT',409));
    assert.equal(registry.get('other').revision,1);
    assert.throws(()=>registry.get('missing'),error('REGISTRY_ENTRY_NOT_FOUND',404));
  }finally{store.close();}
});

test('stale mutations and malformed revisions never change entries or audit',()=>{
  const {store,registry}=fixture();try{
    registry.create(provider());registry.update('provider',{expectedRevision:1,entry:{...provider(),enabled:true}});
    const before=registry.list(),seq=store.lastSeq();
    for(const revision of [0,1]){
      assert.throws(()=>registry.update('provider',{expectedRevision:revision,entry:provider()}),error('REGISTRY_REVISION_STALE',409));
      assert.throws(()=>registry.disable('provider',{expectedRevision:revision}),error('REGISTRY_REVISION_STALE',409));
    }
    for(const revision of [-1,1.5,'2',null,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>registry.disable('provider',{expectedRevision:revision}),error('INVALID_FIELDS'));
    assert.deepEqual(registry.list(),before);assert.equal(store.lastSeq(),seq);
  }finally{store.close();}
});

test('strict fields, credential detection, invalid authentication and destinations',()=>{
  const {store,registry}=fixture();try{
    const p=provider();
    const invalid=[null,[],{...p,extra:true},{...p,revision:7},{...p,enabled:'yes'},
      {...p,connection:{...p.connection,headers:{Authorization:'value'}}},
      {...p,connection:{...p.connection,auth:{kind:'env_ref',env:'OTHER_KEY'}}},
      {...p,connection:{...p.connection,auth:{kind:'native_session'}}},
      {...p,connection:{...p.connection,endpoint:'http://user:password@127.0.0.1:8080/v1'}},
      {...p,connection:{...p.connection,timeoutMs:0}},
      {...p,cost:{kind:'unknown',source:'unknown',checkedAt:null,currency:'USD',unit:'token',unitPrice:0,sourceUrl:null}},
      {...p,declaredCapabilities:['tools','tools']},
    ];
    for(const input of invalid)assert.throws(()=>registry.create(input),e=>e instanceof AppError&&e.status===400);
    for(const input of [{...p,label:'sk-fixture-secret'},{...p,id:'sk-fixture-secret'},
      {...p,declaredCapabilities:['sk-fixture-secret']},{...p,connection:{...p.connection,auth:{kind:'env_ref',env:'sk-fixture-secret'}}}]){
      assert.throws(()=>registry.create(input),error('REGISTRY_CREDENTIAL_INPUT'));
    }
    assert.deepEqual(registry.list(),[]);assert.equal(store.lastSeq(),0);
  }finally{store.close();}
});

test('native and declared-only connections support metadata without execution authority',()=>{
  const {store,registry}=fixture();try{
    for(const adapterId of ['codex','claude-code','other-cli','web']){
      const auth=adapterId==='codex'||adapterId==='claude-code'?{kind:'native_session'}:{kind:'declared',method:'browser_session'};
      registry.create({id:adapterId,kind:'provider',label:adapterId,connection:{adapterId,auth}});
      const runtime=registry.create({id:adapterId+'-runtime',kind:'runtime',label:'Runtime',providerId:adapterId,adapterId});
      assert.equal(runtime.enabled,false);
    }
    assert.throws(()=>registry.create({id:'bad-runtime',kind:'runtime',label:'Runtime',providerId:'codex',adapterId:'claude-code'}),error('REGISTRY_ADAPTER_MISMATCH'));
    assert.throws(()=>registry.create({id:'bad',kind:'provider',label:'Bad',connection:{adapterId:'other-cli',auth:{kind:'none'},command:'echo hello'}}),error('INVALID_FIELDS'));
  }finally{store.close();}
});

test('env and builtin origins cannot be created, updated or disabled',()=>{
  const {store,registry}=fixture();try{
    for(const origin of ['env','builtin']){
      assert.throws(()=>registry.create({...provider(),origin}),error('REGISTRY_READ_ONLY',403));
      const entry=registry.create(provider(origin));
      // Simulate a non-user row to prove the store also refuses mutation at rest.
      store.db.prepare('UPDATE registry_entries SET body=? WHERE id=?').run(JSON.stringify({...entry,origin}),origin);
      assert.throws(()=>registry.update(origin,{expectedRevision:1,entry:provider(origin)}),error('REGISTRY_READ_ONLY',403));
      assert.throws(()=>registry.disable(origin,{expectedRevision:1}),error('REGISTRY_READ_ONLY',403));
    }
    registry.create(provider());
    assert.throws(()=>registry.update('provider',{expectedRevision:1,entry:{...provider(),origin:'env'}}),error('REGISTRY_READ_ONLY',403));
  }finally{store.close();}
});

test('restart preserves entries and additive tables without rewriting existing data',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-registry-')),path=join(dir,'test.sqlite');let store=new Store(path);
  try{
    store.setMeta('existing','preserved');let registry=new ModelRegistryStore(store);
    registry.create(provider());registry.create(model());registry.update('model',{expectedRevision:1,entry:{...model(),enabled:true}});
    const entries=registry.list(),events=store.eventsAfter(0);store.close();store=new Store(path);registry=new ModelRegistryStore(store);
    assert.deepEqual(registry.list(),entries);assert.deepEqual(store.eventsAfter(0),events);assert.equal(store.getMeta('existing'),'preserved');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM registry_validations').get()!.n,0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('registry_entries','registry_validations')").get()!.n,2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('audit failure rolls back entry mutation and event persistence',()=>{
  const {store,registry}=fixture();try{
    registry.create(provider());const before=registry.list(),seq=store.lastSeq();
    store.db.exec("CREATE TRIGGER fail_registry_audit BEFORE INSERT ON events WHEN NEW.kind='registry.updated' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
    assert.throws(()=>registry.update('provider',{expectedRevision:1,entry:{...provider(),enabled:true}}),/audit failure/);
    assert.deepEqual(registry.list(),before);assert.equal(store.lastSeq(),seq);
  }finally{store.close();}
});

test('HTTP and AWS references validate names without resolving credentials',()=>{
  const {store,registry}=fixture();try{
    const p=provider();
    registry.create({...p,connection:{...p.connection,auth:{kind:'env_ref',env:'ORBIT_MODEL_KEY_UNSET_FIXTURE'}}});
    const aws={id:'aws',kind:'provider',label:'AWS',connection:{adapterId:'bedrock',cliPath:'/usr/local/bin/aws',region:'us-east-1',
      auth:{kind:'aws_env_refs',accessKeyId:'ORBIT_BEDROCK_ACCESS',secretAccessKey:'ORBIT_BEDROCK_SECRET',sessionToken:null},
      projectPaths:['/tmp/registry-project'],timeoutMs:1000,maxOutputTokens:100}};
    registry.create(aws);registry.create(model('aws-model','aws','example.model-v1'));
    for(const connection of [
      {...aws.connection,auth:{...aws.connection.auth,secretAccessKey:'AWS_SECRET_ACCESS_KEY'}},
      {...aws.connection,auth:{...aws.connection.auth,secretAccessKey:'ORBIT_BEDROCK_ACCESS'}},
      {...aws.connection,auth:{...aws.connection.auth,sessionToken:'ORBIT_MODEL_KEY_TOKEN'}},
      {...aws.connection,cliPath:'/tmp/registry-project/aws'},
      {...aws.connection,region:'unknown'},
    ])assert.throws(()=>registry.create({...aws,id:'invalid',connection}),error('REGISTRY_CONNECTION_INVALID'));
    assert.throws(()=>registry.create(model('bad-model','aws','global.example.model')),error('INVALID_FIELDS'));
    assert.equal(registry.list().length,3);
  }finally{store.close();}
});

test('parent disable and re-enable invalidate child digest without changing child or evidence',()=>{
  const {store,registry}=fixture();try{
    registry.create({...provider(),enabled:true});const child=registry.create({...model(),enabled:true});
    const digest=registry.configDigest('model');assert.equal(registry.isEnabled('model'),true);
    const evidence={id:'validation',requestId:'request',entryId:'model',revision:1,configDigest:digest,requestDigest:'a'.repeat(64),kind:'local',state:'passed',createdAt:child.createdAt,finishedAt:child.createdAt,evidenceRefs:[],code:'REGISTRY_LOCAL_VALID'};
    store.db.prepare('INSERT INTO registry_validations VALUES(?,?,?,?,?,?,?,?,?,?)').run(evidence.id,evidence.requestId,evidence.entryId,evidence.revision,evidence.configDigest,evidence.requestDigest,evidence.state,JSON.stringify(evidence),evidence.createdAt,evidence.finishedAt);
    registry.disable('provider',{expectedRevision:1});assert.equal(registry.isEnabled('model'),false);assert.notEqual(registry.configDigest('model'),digest);
    registry.update('provider',{expectedRevision:2,entry:{...provider(),enabled:true}});
    assert.equal(registry.isEnabled('model'),true);assert.notEqual(registry.configDigest('model'),digest);
    assert.deepEqual(registry.get('model'),child);
    assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT body FROM registry_validations').get()!.body)),evidence);
  }finally{store.close();}
});

test('mutations reject kind changes, forged metadata and unknown wrapper fields',()=>{
  const {store,registry}=fixture();try{
    registry.create(provider());const before=registry.list(),seq=store.lastSeq();
    for(const input of [
      {expectedRevision:1,entry:{...provider(),createdAt:'forged'}},
      {expectedRevision:1,entry:{...provider(),enabled:true},extra:true},
      {expectedRevision:1,entry:provider('different')},
    ])assert.throws(()=>registry.update('provider',input),error('INVALID_FIELDS'));
    assert.throws(()=>registry.update('provider',{expectedRevision:1,entry:model('provider','another')}),error('REGISTRY_KIND_IMMUTABLE'));
    assert.throws(()=>registry.disable('provider',{expectedRevision:1,extra:true}),error('INVALID_FIELDS'));
    assert.deepEqual(registry.list(),before);assert.equal(store.lastSeq(),seq);
  }finally{store.close();}
});

test('unsafe object shapes and credentials are rejected before serialization or storage',()=>{
  const {store,registry}=fixture();try{
    let calls=0;const getter={...provider()};Object.defineProperty(getter,'label',{get(){calls++;return 'Label';},enumerable:true});
    const hidden={...provider()};Object.defineProperty(hidden,'hidden',{value:true});
    const sparse=Array(1);Object.assign(sparse,{extra:'tools'});
    for(const input of [getter,hidden,{...provider(),toJSON(){calls++;return provider();}},
      {...provider(),[Symbol('extra')]:true},{...provider(),declaredCapabilities:sparse},
      {...provider(),connection:Object.create(provider().connection)},
    ])assert.throws(()=>registry.create(input),error('INVALID_FIELDS'));
    assert.equal(calls,0);
    registry.create(provider());const seq=store.lastSeq();
    assert.throws(()=>registry.update('provider',{expectedRevision:1,entry:{...provider(),label:'password=fixture-value'}}),error('REGISTRY_CREDENTIAL_INPUT'));
    assert.equal(registry.get('provider').label,'Local API');assert.equal(store.lastSeq(),seq);
    assert.equal(JSON.stringify(store.eventsAfter(0)).includes('fixture-value'),false);
    const row=registry.get('provider');store.db.prepare('UPDATE registry_entries SET body=? WHERE id=?').run(JSON.stringify({...row,label:'sk-fixture-secret'}),'provider');
    assert.throws(()=>registry.get('provider'),error('REGISTRY_STORED_DATA_INVALID',409));
    assert.throws(()=>registry.list(),error('REGISTRY_STORED_DATA_INVALID',409));
  }finally{store.close();}
});

test('user pricing remains declared, cannot claim provider-reported evidence',()=>{
  const {store,registry}=fixture();try{
    const declared={kind:'metered_api',source:'user_declared',checkedAt:'2026-10-29T00:00:00.000Z',sourceUrl:'https://example.com/pricing',currency:'USD',unit:'million_input_tokens',unitPrice:1};
    const entry=registry.create({...provider(),cost:declared});assert.equal(entry.cost.source,'user_declared');assert.equal(entry.cost.unitPrice,1);
    assert.throws(()=>registry.update('provider',{expectedRevision:1,entry:{...provider(),cost:{...declared,source:'provider_reported'}}}),error('REGISTRY_COST_SOURCE_INVALID'));
    assert.equal(registry.get('provider').revision,1);
  }finally{store.close();}
});

test('two database connections enforce revision and duplicate model conflicts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-registry-cas-')),path=join(dir,'test.sqlite');const first=new Store(path),second=new Store(path);
  try{
    const a=new ModelRegistryStore(first),b=new ModelRegistryStore(second);a.create(provider());
    const revision=b.get('provider').revision;a.update('provider',{expectedRevision:revision,entry:{...provider(),enabled:true}});
    assert.throws(()=>b.update('provider',{expectedRevision:revision,entry:provider()}),error('REGISTRY_REVISION_STALE',409));
    a.create(model());assert.throws(()=>b.create(model('duplicate')),error('REGISTRY_MODEL_CONFLICT',409));
    assert.deepEqual(a.list(),b.list());
  }finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});
