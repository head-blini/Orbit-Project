export interface DirectoryIdentity {device:string;inode:string;birthtimeNs:string}
export interface RepositoryIdentity {repositoryId:string;commonGitDir:string;directory:DirectoryIdentity}
export interface RepositoryResource extends RepositoryIdentity {worktreePath:string;targetBranch:string;baseRevision:string}
