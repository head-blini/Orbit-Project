import type {Project,Workspace} from './types.ts';

export interface CreateProjectInput {requestId:string;name:string;kind?:Project['kind']}
export interface CreatedProject {project:Project;workspace:Workspace|null}
/** An existing folder the operator allowlisted; Orbit only inspects it at registration. */
export interface RegisterFolderInput {requestId:string;name:string;path:string}
