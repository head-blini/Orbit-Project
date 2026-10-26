export interface AppPreviewCatalog {workspaceId:string;sourceDigest:string;entries:string[]}
export interface AppPreview {id:string;workspaceId:string;sourceDigest:string;entryPath:string;createdAt:string;expiresAt:string;url:string;fileCount:number}
export interface AppPreviewInput {entryPath:string;expectedSourceDigest:string}
