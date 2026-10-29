import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {addMaterials,listMaterials,MaterialHistory,replaceMaterial} from '../server/materials.ts';
import {tmpdir} from './temp.ts';

// F02-REG: existing folder as a general project; explicit material replacement keeps history.
function fixture(setup:(folder:string)=>void=()=>{},allow=true){
  const dir=mkdtempSync(join(tmpdir(),'orbit-folder-')),folder=join(dir,'report');mkdirSync(folder);
  writeFileSync(join(folder,'notes.md'),'# existing notes\n');mkdirSync(join(folder,'drafts'));writeFileSync(join(folder,'drafts','a.txt'),'draft');setup(folder);
  const store=new Store(':memory:'),projects=new Projects(store,join(dir,'workspaces'),allow?[folder]:[],join(dir,'projects'));
  return {dir,folder,store,projects};
}
const tree=(root:string):string[]=>readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?[e.name+'/',...tree(join(root,e.name)).map(p=>e.name+'/'+p)]:[e.name+':'+readFileSync(join(root,e.name),'utf8')]).sort();

test('an allowlisted existing folder registers as a general project without touching its files, idempotently',()=>{
  const f=fixture();try{
    const before=tree(f.folder),mtime=statSync(f.folder).mtimeMs,input={requestId:randomUUID(),name:'분기 보고서',path:f.folder};
    const result=f.projects.registerGeneralFolder(input);
    assert.equal(result.project.kind,'general');assert.equal(result.project.path,f.folder);assert.equal(result.workspace,null);assert.equal(result.project.writeEnabled,true);
    assert.deepEqual(tree(f.folder),before);assert.equal(statSync(f.folder).mtimeMs,mtime);
    assert.deepEqual(f.projects.registerGeneralFolder(input),result);
    assert.throws(()=>f.projects.registerGeneralFolder({...input,name:'다른 이름'}),/IDEMPOTENCY_CONFLICT/);
    assert.throws(()=>f.projects.registerGeneralFolder({...input,requestId:randomUUID()}),/PROJECT_OVERLAP/);
    assert.equal(f.store.projects().length,1);assert.equal(f.projects.generalProject(result.project.id).id,result.project.id);
    // Materials then go only into the folder's own inputs/.
    addMaterials(f.projects.generalProject(result.project.id).path,{files:[{name:'source.txt',text:'count 42'}]});
    assert.deepEqual(tree(f.folder),[...before,'inputs/','inputs/source.txt:count 42'].sort());
    // Removing the folder from the allowlist revokes the write grant.
    const revoked=new Projects(f.store,join(f.dir,'workspaces'),[],join(f.dir,'projects'));
    assert.throws(()=>revoked.generalProject(result.project.id),/PROJECT_CREATION_UNAVAILABLE/);
  }finally{f.store.close();}
});

test('registration refuses unlisted, Git, reserved, runtime-config, linked, overlapping and home folders before writing',()=>{
  const cases:[string,(folder:string)=>void,RegExp,boolean?][]=[
    ['not allowlisted',()=>{},/FOLDER_NOT_ALLOWED/,false],
    ['git',folder=>mkdirSync(join(folder,'.git')),/GIT_FOLDER_REJECTED/],
    ['nested git',folder=>mkdirSync(join(folder,'drafts','.git')),/GIT_FOLDER_REJECTED/],
    ['inputs exists',folder=>mkdirSync(join(folder,'inputs')),/FOLDER_RESERVED_NAME/],
    ['output exists',folder=>writeFileSync(join(folder,'output'),'x'),/FOLDER_RESERVED_NAME/],
    ['claude config',folder=>mkdirSync(join(folder,'.claude')),/FOLDER_UNSUPPORTED/],
    ['symlink inside',folder=>symlinkSync('/etc/hosts',join(folder,'hosts')),/LINK_REJECTED/],
  ];
  for(const [label,setup,error,allow] of cases){
    const f=fixture(setup,allow??true);try{
      const before=tree(f.folder).length;
      assert.throws(()=>f.projects.registerGeneralFolder({requestId:randomUUID(),name:'보고서',path:f.folder}),error,label);
      assert.equal(f.store.projects().length,0,label);assert.equal(tree(f.folder).length,before,label);
    }finally{f.store.close();}
  }
  const f=fixture();try{
    const link=join(f.dir,'link');symlinkSync(f.folder,link);
    assert.throws(()=>f.projects.registerGeneralFolder({requestId:randomUUID(),name:'보고서',path:link}),/LINK_REJECTED/);
    assert.throws(()=>f.projects.registerGeneralFolder({requestId:randomUUID(),name:'보고서',path:'relative/path'}),/INVALID_PATH/);
    assert.throws(()=>f.projects.registerGeneralFolder({requestId:randomUUID(),name:'api key',path:f.folder}),/INVALID_FIELDS/);
    const managed=new Projects(f.store,join(f.dir,'workspaces'),[join(f.dir,'workspaces')],join(f.dir,'projects'));
    assert.throws(()=>managed.registerGeneralFolder({requestId:randomUUID(),name:'보고서',path:join(f.dir,'workspaces')}),/PROJECT_OVERLAP/);
    const parent=new Projects(f.store,join(f.dir,'workspaces'),[f.dir],join(f.dir,'projects'));
    assert.throws(()=>parent.registerGeneralFolder({requestId:randomUUID(),name:'보고서',path:f.dir}),/PROJECT_OVERLAP/);
    assert.equal(f.store.projects().length,0);
  }finally{f.store.close();}
});

test('replacing a material keeps the previous bytes, needs the current digest and never overwrites by add',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-replace-')),store=new Store(':memory:');try{
    const history=new MaterialHistory(store),keep=(prior:Parameters<MaterialHistory['keep']>[1],swap:()=>void)=>history.keep('p',prior,swap);
    const [first]=addMaterials(root,{files:[{name:'data.csv',text:'a,1\n'}]});chmodSync(join(root,'inputs','data.csv'),0o640);
    writeFileSync(join(root,'inputs','.orbit-replace-'+randomUUID()),'stale');
    assert.throws(()=>addMaterials(root,{files:[{name:'data.csv',text:'a,2\n'}]}),/MATERIAL_EXISTS/);
    assert.throws(()=>replaceMaterial(root,{name:'data.csv',text:'a,2\n',expectedSha256:'0'.repeat(64)},keep),/MATERIAL_CHANGED/);
    assert.throws(()=>replaceMaterial(root,{name:'missing.csv',text:'a,2\n',expectedSha256:first.sha256},keep),/MATERIAL_NOT_FOUND/);
    assert.throws(()=>replaceMaterial(root,{name:'data.csv',text:'key sk-abcdefghijklmnopqrstuvwxyz0123456789',expectedSha256:first.sha256},keep),/CREDENTIAL_LIKE_INPUT/);
    assert.throws(()=>replaceMaterial(root,{name:'data.csv',text:'연락처 010-1234-5678',expectedSha256:first.sha256},keep),/PERSONAL_DATA_BLOCKED/);
    assert.equal(history.counts('p').size,0);assert.equal(readFileSync(join(root,'inputs','data.csv'),'utf8'),'a,1\n');
    const [second]=replaceMaterial(root,{name:'data.csv',text:'a,2\n',expectedSha256:first.sha256},keep);
    assert.notEqual(second.sha256,first.sha256);assert.equal(readFileSync(join(root,'inputs','data.csv'),'utf8'),'a,2\n');
    assert.deepEqual(readdirSync(join(root,'inputs')),['data.csv'],'stale temporary removed, no leftovers');
    assert.equal(statSync(join(root,'inputs','data.csv')).mode&0o777,0o640,'original mode preserved');
    // Replaying the same replacement is a no-op and archives nothing more.
    assert.deepEqual(replaceMaterial(root,{name:'data.csv',text:'a,2\n',expectedSha256:first.sha256},keep),listMaterials(root));
    assert.equal(history.counts('p').get('inputs/data.csv'),1);
    assert.equal(Buffer.from(store.db.prepare('SELECT bytes FROM material_versions').get()!.bytes as Uint8Array).toString('utf8'),'a,1\n');
    assert.throws(()=>store.db.prepare('DELETE FROM material_versions').run(),/APPEND_ONLY/);
    // If history cannot be kept, the file stays unchanged.
    assert.throws(()=>replaceMaterial(root,{name:'data.csv',text:'a,3\n',expectedSha256:second.sha256},()=>{throw new Error('MATERIAL_HISTORY_FULL');}),/MATERIAL_HISTORY_FULL/);
    assert.equal(readFileSync(join(root,'inputs','data.csv'),'utf8'),'a,2\n');
    // A failed swap rolls the history row back; nothing records the current version as history.
    assert.throws(()=>replaceMaterial(root,{name:'data.csv',text:'a,3\n',expectedSha256:second.sha256},(prior,swap)=>history.keep('p',prior,()=>{throw new Error('SWAP_FAILED');})),/SWAP_FAILED/);
    assert.equal(history.counts('p').get('inputs/data.csv'),1);assert.equal(readFileSync(join(root,'inputs','data.csv'),'utf8'),'a,2\n');
    // If the transaction fails after the swap, the prior bytes are restored.
    assert.throws(()=>replaceMaterial(root,{name:'data.csv',text:'a,3\n',expectedSha256:second.sha256},(prior,swap)=>{swap();throw new Error('COMMIT_FAILED');}),/COMMIT_FAILED/);
    assert.equal(readFileSync(join(root,'inputs','data.csv'),'utf8'),'a,2\n');assert.deepEqual(readdirSync(join(root,'inputs')),['data.csv']);
    // Prior bytes are archived verbatim, including bytes that are not valid UTF-8.
    const raw=Buffer.from([0x61,0x2c,0xff,0x0a]);writeFileSync(join(root,'inputs','data.csv'),raw);
    const listed=listMaterials(root)[0];replaceMaterial(root,{name:'data.csv',text:'a,4\n',expectedSha256:listed.sha256},keep);
    assert.deepEqual(Buffer.from(store.db.prepare('SELECT bytes FROM material_versions ORDER BY id DESC').get()!.bytes as Uint8Array),raw);
    // A prior file too large to archive is refused, unchanged.
    writeFileSync(join(root,'inputs','data.csv'),'x'.repeat(128*1024+1));
    assert.throws(()=>replaceMaterial(root,{name:'data.csv',text:'a,5\n',expectedSha256:listMaterials(root)[0].sha256},keep),/MATERIAL_TOO_LARGE/);
    assert.equal(readFileSync(join(root,'inputs','data.csv'),'utf8').length,128*1024+1);
  }finally{store.close();}
});
