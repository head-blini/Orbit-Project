import ts from 'typescript';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { safeText } from './privacy.ts';
import { SOURCE_GRAPH_LIMITS,type SourceGraph,type SourceGraphInput,type SourceGraphNode,type SourceGraphEdge,type SourceGraphUnresolvedReason } from '../shared/source-graph.ts';

const POLICY_VERSION='orbit-typescript-source-graph-v1';
const extensions=['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'];
function canonicalExtension(path:string){const extension=extensions.find(extension=>path.toLowerCase().endsWith(extension));return extension?path.slice(0,-extension.length)+extension:path;}
function unavailable():never{throw new Error('SOURCE_GRAPH_UNAVAILABLE');}
const identifier=(kind:string,...parts:(string|number)[])=>kind+'_'+createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** The integration owner keeps this ID -> actual path map server-side; graph paths are display-only. */
export function sourceGraphFileId(path:string):string {if(typeof path!=='string')unavailable();return identifier('file',path);}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)||Reflect.ownKeys(value).length!==keys.length)unavailable();
  const descriptors=Object.getOwnPropertyDescriptors(value),result:Record<string,unknown>={};
  for(const key of keys){const field=descriptors[key];if(!field||!('value' in field))unavailable();result[key]=field.value;}return result;
}
function inputs(files:readonly SourceGraphInput[]):SourceGraphInput[]{
  if(!Array.isArray(files)||Object.getPrototypeOf(files)!==Array.prototype||files.length>SOURCE_GRAPH_LIMITS.maxFiles||Reflect.ownKeys(files).length!==files.length+1)unavailable();
  const descriptors=Object.getOwnPropertyDescriptors(files),seen=new Set<string>();let total=0;
  const copied:SourceGraphInput[]=[];
  for(let index=0;index<files.length;index++){
    const descriptor=descriptors[String(index)];if(!descriptor||!('value' in descriptor))unavailable();const file=record(descriptor.value,['path','content','changed']);
    const {path,content,changed}=file;if(typeof path!=='string'||typeof content!=='string'||typeof changed!=='boolean')unavailable();
    if(!path||path.length>512||/[\x00-\x1f\x7f\\:]/.test(path)||path.startsWith('/')
      ||path.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:\.git|\.codex|\.agents|\.aws|\.ssh|\.env.*|auth\.json.*|credentials.*)$/i.test(part))
      ||!extensions.some(extension=>path.toLowerCase().endsWith(extension)))unavailable();
    if(Buffer.from(path,'utf8').toString('utf8')!==path||Buffer.from(content,'utf8').toString('utf8')!==content)unavailable();
    const bytes=Buffer.byteLength(content,'utf8');total+=bytes;
    if(bytes>SOURCE_GRAPH_LIMITS.maxFileBytes||total>SOURCE_GRAPH_LIMITS.maxTotalBytes||seen.has(path.toLowerCase()))unavailable();seen.add(path.toLowerCase());
    copied.push({path,content,changed});
  }
  return copied.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
}
function scriptKind(path:string){path=path.toLowerCase();return path.endsWith('.tsx')?ts.ScriptKind.TSX:path.endsWith('.jsx')?ts.ScriptKind.JSX:/\.[cm]?js$/.test(path)?ts.ScriptKind.JS:ts.ScriptKind.TS;}

/** In-memory static analysis only: no tsconfig, default library, package, filesystem or network reads. */
export function analyzeSourceGraph(files:readonly SourceGraphInput[],sourceDigest:string,baseSha:string):SourceGraph {
  try{
    if(typeof sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(sourceDigest)||typeof baseSha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha))unavailable();
    const copied=inputs(files),sources=new Map<string,ts.SourceFile>(),byVirtual=new Map<string,SourceGraphInput>(),directories=new Set(['/','/orbit']);let astNodes=0;
    for(const file of copied){
      const name='/orbit/'+canonicalExtension(file.path),sf=ts.createSourceFile(name,file.content,ts.ScriptTarget.Latest,true,scriptKind(file.path));sources.set(name,sf);byVirtual.set(name,file);
      for(let directory=posix.dirname(name);;directory=posix.dirname(directory)){directories.add(directory);if(directory==='/')break;}
      const bounded=(node:ts.Node,depth:number)=>{if(++astNodes>SOURCE_GRAPH_LIMITS.maxAstNodes||depth>SOURCE_GRAPH_LIMITS.maxAstDepth)unavailable();ts.forEachChild(node,child=>bounded(child,depth+1));};bounded(sf,0);
    }
    function resolveLocal(specifier:string,containing:string):string|undefined {
      if(!/^\.{1,2}\//.test(specifier)||/[\x00-\x1f\\]/.test(specifier))return undefined;
      const base=canonicalExtension(posix.resolve(posix.dirname(containing),specifier));if(!base.startsWith('/orbit/'))return undefined;
      const substituted=base.endsWith('.js')?[base.slice(0,-3)+'.ts',base.slice(0,-3)+'.tsx']:base.endsWith('.jsx')?[base.slice(0,-4)+'.tsx']:
        base.endsWith('.mjs')?[base.slice(0,-4)+'.mts']:base.endsWith('.cjs')?[base.slice(0,-4)+'.cts']:[];
      return [...substituted,base,...extensions.map(extension=>base+extension),...extensions.map(extension=>base+'/index'+extension)].find(path=>sources.has(path));
    }
    const options:ts.CompilerOptions={target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
      allowJs:true,checkJs:true,noLib:true,types:[],noEmit:true,skipLibCheck:true,jsx:ts.JsxEmit.Preserve,allowImportingTsExtensions:true};
    const host:ts.CompilerHost={getSourceFile:name=>sources.get(name),getDefaultLibFileName:()=>'/__orbit_no_lib__.d.ts',writeFile:()=>unavailable(),
      getCurrentDirectory:()=>'/orbit',getDirectories:()=>[],getCanonicalFileName:name=>name,useCaseSensitiveFileNames:()=>true,getNewLine:()=>'\n',
      fileExists:name=>sources.has(name),readFile:name=>byVirtual.get(name)?.content,directoryExists:name=>directories.has(name),realpath:name=>name,
      resolveModuleNames:(names,containing)=>names.map(name=>{const resolved=resolveLocal(name,containing);return resolved?{resolvedFileName:resolved,isExternalLibraryImport:false}:undefined;})};
    const program=ts.createProgram([...sources.keys()],options,host);
    for(const sf of sources.values())if(program.getSyntacticDiagnostics(sf).length)unavailable();
    const checker=program.getTypeChecker(),nodes:SourceGraphNode[]=[],edges:SourceGraphEdge[]=[],nodeIds=new Map<ts.Node,string>(),symbolIds=new Map<ts.Symbol,Set<string>>(),edgeIds=new Set<string>();
    const byReason:SourceGraph['unresolved']['byReason']={external_import:0,unresolved_import:0,dynamic_import:0,unresolved_call:0,dynamic_call:0,unresolved_extends:0,unsupported_declaration:0};
    const unresolved=(reason:SourceGraphUnresolvedReason)=>{byReason[reason]++;};
    function edge(kind:SourceGraphEdge['kind'],from:string,to:string,evidence:SourceGraphEdge['evidence']){
      const id=identifier('edge',kind,from,to);if(edgeIds.has(id))return;if(edges.length>=SOURCE_GRAPH_LIMITS.maxEdges)unavailable();edgeIds.add(id);edges.push({id,kind,from,to,evidence,staticOnly:true});
    }
    function addNode(node:ts.Node,kind:SourceGraphNode['kind'],name:string,file:SourceGraphInput,sf:ts.SourceFile,parent?:string,symbolName?:ts.Node){
      if(name.length>1024||nodes.length>=SOURCE_GRAPH_LIMITS.maxNodes)unavailable();
      const fileId=sourceGraphFileId(file.path),id=kind==='file'?fileId:identifier(kind,file.path,node.getStart(sf),name);
      nodes.push({id,kind,label:safeText(name),fileId,path:safeText(file.path),line:kind==='file'?1:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,changed:file.changed});nodeIds.set(node,id);
      if(parent)edge('contains',parent,id,'syntax');
      if(symbolName){const symbol=checker.getSymbolAtLocation(symbolName);if(symbol){const ids=symbolIds.get(symbol)??new Set<string>();ids.add(id);symbolIds.set(symbol,ids);}}
      return id;
    }
    for(const [name,sf] of sources){
      const file=byVirtual.get(name)!,fileId=addNode(sf,'file',file.path,file,sf);
      function discover(node:ts.Node,parent:string){
        let owner=parent;
        if(ts.isClassDeclaration(node)){
          if(node.name)owner=addNode(node,'class',node.name.text,file,sf,parent,node.name);else unresolved('unsupported_declaration');
        }else if(ts.isFunctionDeclaration(node)){
          if(node.name&&node.body)owner=addNode(node,'function',node.name.text,file,sf,parent,node.name);else if(!node.name)unresolved('unsupported_declaration');
        }else if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))){
          owner=addNode(node,'function',node.name.text,file,sf,parent,node.name);nodeIds.set(node.initializer,owner);
        }else if(ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node)){
          if(node.body&&(ts.isIdentifier(node.name)||ts.isPrivateIdentifier(node.name)))owner=addNode(node,'method',node.name.text,file,sf,parent,node.name);else unresolved('unsupported_declaration');
        }else if(ts.isConstructorDeclaration(node)&&node.body)owner=addNode(node,'method','constructor',file,sf,parent);
        else if((ts.isArrowFunction(node)||ts.isFunctionExpression(node))&&!nodeIds.has(node)){
          if(ts.isFunctionExpression(node)&&node.name)owner=addNode(node,'function',node.name.text,file,sf,parent,node.name);else unresolved('unsupported_declaration');
        }
        ts.forEachChild(node,child=>discover(child,owner));
      }
      ts.forEachChild(sf,node=>discover(node,fileId));
    }
    const unstableIds=new Set<string>();
    function target(expression:ts.Node,valueSymbol?:ts.Symbol):string|undefined {
      let symbol=valueSymbol??checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression)?expression.name:expression);
      const seen=new Set<ts.Symbol>();
      while(symbol&&(symbol.flags&ts.SymbolFlags.Alias)){if(seen.has(symbol)||seen.size>8)return undefined;seen.add(symbol);symbol=checker.getAliasedSymbol(symbol);}
      const ids=new Set(symbol?symbolIds.get(symbol):undefined);
      // Property lookup can produce an instantiated/transient symbol rather than
      // the declaration's original symbol. Only its actual local declarations
      // may connect it; spelling alone is never a fallback.
      for(const declaration of symbol?.declarations??[]){const id=nodeIds.get(declaration);if(id)ids.add(id);}
      const id=ids.size===1?[...ids][0]:undefined;return id&&!unstableIds.has(id)?id:undefined;
    }
    // Observable rebinding and let/var arrow bindings are not stable call targets.
    // This is conservative whole-input analysis, not runtime control-flow proof.
    function writes(node:ts.Node){
      if(ts.isIdentifier(node)||ts.isPropertyAccessExpression(node)){const id=target(node);if(id)unstableIds.add(id);}
      else if(ts.isParenthesizedExpression(node)||ts.isSpreadElement(node)||ts.isSpreadAssignment(node))writes(node.expression);
      else if(ts.isArrayLiteralExpression(node))for(const element of node.elements)writes(element);
      else if(ts.isObjectLiteralExpression(node))for(const property of node.properties){
        if(ts.isPropertyAssignment(property))writes(property.initializer);
        else if(ts.isShorthandPropertyAssignment(property)){const id=target(property.name,checker.getShorthandAssignmentValueSymbol(property));if(id)unstableIds.add(id);}
        else if(ts.isSpreadAssignment(property))writes(property.expression);
      }
      else if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken)writes(node.left);
    }
    for(const sf of sources.values()){
      function assignments(node:ts.Node){
        if(ts.isVariableDeclaration(node)&&ts.isVariableDeclarationList(node.parent)&&!(node.parent.flags&ts.NodeFlags.Const)){
          const id=nodeIds.get(node);if(id)unstableIds.add(id);
        }
        if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment){
          writes(node.left);
        }
        ts.forEachChild(node,assignments);
      }
      assignments(sf);
    }
    function caller(node:ts.Node,sf:ts.SourceFile):string|undefined {
      for(let parent=node.parent;parent;parent=parent.parent){const id=nodeIds.get(parent);if(id)return id;
        if(ts.isFunctionLike(parent))return undefined;}
      return nodeIds.get(sf);
    }
    for(const [name,sf] of sources){
      const fileId=nodeIds.get(sf)!;
      function references(node:ts.Node){
        let specifier:ts.Expression|undefined;
        if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))specifier=node.moduleSpecifier;
        else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))specifier=node.moduleReference.expression;
        if(specifier){
          if(ts.isStringLiteralLike(specifier)){const resolved=resolveLocal(specifier.text,name);if(resolved)edge('imports',fileId,nodeIds.get(sources.get(resolved)!)!,'syntax');else unresolved(specifier.text.startsWith('.')?'unresolved_import':'external_import');}
          else unresolved('dynamic_import');
        }
        if(ts.isCallExpression(node)||ts.isNewExpression(node)){
          if(node.expression.kind===ts.SyntaxKind.ImportKeyword)unresolved('dynamic_import');
          else if(!ts.isIdentifier(node.expression)&&!ts.isPropertyAccessExpression(node.expression))unresolved('dynamic_call');
          else {const from=caller(node,sf),to=target(node.expression);if(from&&to)edge('calls',from,to,'typechecker');else unresolved(from?'unresolved_call':'dynamic_call');}
        }
        if(ts.isClassDeclaration(node)&&node.heritageClauses){
          const from=nodeIds.get(node);
          for(const clause of node.heritageClauses)if(clause.token===ts.SyntaxKind.ExtendsKeyword)for(const type of clause.types){
            const to=(ts.isIdentifier(type.expression)||ts.isPropertyAccessExpression(type.expression))?target(type.expression):undefined;
            if(from&&to&&nodes.find(item=>item.id===to)?.kind==='class')edge('extends',from,to,'typechecker');else unresolved('unresolved_extends');
          }
        }
        ts.forEachChild(node,references);
      }
      references(sf);
    }
    nodes.sort((a,b)=>a.id.localeCompare(b.id));edges.sort((a,b)=>a.id.localeCompare(b.id));
    const changedFileIds=nodes.filter(node=>node.kind==='file'&&node.changed).map(node=>node.id).sort();
    const reverse=new Map<string,string[]>(),fileMembers=new Map<string,string[]>();
    for(const edge of edges){const parents=reverse.get(edge.to)??[];parents.push(edge.from);reverse.set(edge.to,parents);}
    for(const node of nodes){const members=fileMembers.get(node.fileId)??[];members.push(node.id);fileMembers.set(node.fileId,members);}
    const queue=[...changedFileIds],impacted=new Set<string>();let visits=0;
    while(queue.length){if(++visits>SOURCE_GRAPH_LIMITS.maxImpactVisits)unavailable();const id=queue.shift()!;if(impacted.has(id))continue;impacted.add(id);
      queue.push(...(reverse.get(id)??[]));if(fileMembers.has(id))queue.push(...fileMembers.get(id)!);
    }
    return {status:'available',analyzer:{name:'typescript-static',version:ts.version,policyVersion:POLICY_VERSION},sourceDigest,baseSha,nodes,edges,changedFileIds,
      impact:{nodeIds:[...impacted].sort(),fileIds:nodes.filter(node=>node.kind==='file'&&impacted.has(node.id)).map(node=>node.id).sort(),evidence:'potential-static-reverse-dependency',truncated:false},
      unresolved:{total:Object.values(byReason).reduce((sum,count)=>sum+count,0),byReason},
      coverage:{files:copied.length,limits:SOURCE_GRAPH_LIMITS,externalResolution:false,runtimeAccuracy:false,limitations:[
        'Static declarations and potential dependencies only; no runtime dispatch guarantee.',
        'Only supplied JS/TS files; no tsconfig, package metadata, library or filesystem resolution.',
        'Dynamic/external/ambiguous references remain unresolved; source bodies and module strings are omitted.',
        'Credential-pattern redaction is heuristic; graph paths are display metadata, never file-access authority.',
      ]}};
  }catch{throw new Error('SOURCE_GRAPH_UNAVAILABLE');}
}
