import type {Project,Workspace} from './types.ts';

export interface CreateProjectInput {requestId:string;name:string}
export interface CreatedProject {project:Project;workspace:Workspace}
