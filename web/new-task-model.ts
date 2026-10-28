import type {Material} from '../shared/deliverables.ts';

/** Pure helpers of the home new-task panel. Limits mirror server/materials.ts. */
export const extensions=['.csv','.md','.txt','.json'],maxFiles=10,maxBytes=128*1024;
export function projectNameFrom(text:string){
  const name=text.replace(/[\x00-\x1f\x7f/\\<>:=`$|;&]/g,' ').replace(/\s+/g,' ').trim().replace(/^-+/,'').slice(0,40).trim();
  return name.length>=1?name:'새 작업';
}
export function materialIssue(files:readonly {name:string;size:number}[]){
  if(files.length>maxFiles)return `자료는 최대 ${maxFiles}개까지 첨부할 수 있습니다.`;
  const bad=files.find(file=>!extensions.some(ext=>file.name.toLowerCase().endsWith(ext)));
  if(bad)return `${bad.name}: 현재는 텍스트 자료(${extensions.join(', ')})만 첨부할 수 있습니다.`;
  const big=files.find(file=>file.size>maxBytes);
  if(big)return `${big.name}: 파일당 128 KB까지 첨부할 수 있습니다.`;
  return '';
}
export function planningRequestText(text:string,materials:readonly Pick<Material,'path'>[]){
  return materials.length?`${text.trim()}\n\n첨부 자료(프로젝트 폴더에 저장됨, 읽기 전용):\n${materials.map(item=>'- '+item.path).join('\n')}`:text.trim();
}
