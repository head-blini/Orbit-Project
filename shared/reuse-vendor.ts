export interface ReuseVendorFile {path:string;url:string;sha256:string;bytes:number}
/** licenseFile is a workspace-relative path or `license_file:absent`; never an invented license. */
export interface ReuseEvidenceEntry {name:string;version:string;license:{decision:string;package:string|null};sourceDecision:string;sourceUrl:string;files:ReuseVendorFile[];licenseFile:string;checkedAt:string;planningVersionId:string}
export interface ReuseEvidence {entries:ReuseEvidenceEntry[]}
export interface ReuseVendorDecision {planningVersionId:string;topic:string;decision:string}
export interface ReuseVendorView {evidence:ReuseEvidence;decisions:ReuseVendorDecision[]}
export interface ReuseVendorResult {status:'vendored'|'unchanged';entry:ReuseEvidenceEntry}
