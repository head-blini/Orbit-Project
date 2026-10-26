import {realpathSync} from 'node:fs';
import {tmpdir as systemTmpdir} from 'node:os';

// macOS exposes the OS temp root through /var -> /private/var. Fixtures use its
// canonical location so tests exercise their own links, not the OS alias.
// Production path/link validation is deliberately unchanged.
export function tmpdir():string {return realpathSync(systemTmpdir());}
