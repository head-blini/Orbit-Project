import type {Project,Workspace} from './types.ts';

export interface CreateProjectInput {requestId:string;name:string;kind?:Project['kind']}
export interface CreatedProject {project:Project;workspace:Workspace|null}
