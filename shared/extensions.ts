export type ExtensionKind='skills'|'hooks'|'mcp'|'plugins';
export interface ExtensionItem {
  id:string;name:string;scope:string;configuredEnabled:boolean|null;
  effective:'blocked_policy'|'unknown';version:null;
  handlerType:'command'|'mcpTool'|'prompt'|'agent'|null;
  nativeTrust:'managed'|'untrusted'|'trusted'|'modified'|'unknown';
  pluginOwned:boolean|null;
}
export interface ExtensionSection {
  kind:ExtensionKind;status:'available'|'partial'|'unknown'|'not_connected';
  issue:string|null;items:ExtensionItem[];
}
export interface ExtensionInventory {
  workspaceId:string|null;source:'codex_app_server'|'not_queried';
  status:'available'|'partial'|'unknown';checkedAt:string|null;
  sections:ExtensionSection[];
}
