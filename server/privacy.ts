// Never log raw RPC, stderr, account/config responses, or tool output.
// Text is permitted only for this tool-restricted chat; patterns are defense in depth.
export function safeText(input:string, final=true):string {
  let value=input.slice(0,64000);
  if(!final) value=value.replace(/\S+$/u,''); // hold unfinished tokens across delta boundaries
  return value
    .replace(/\bsk-[\w-]*/g,'[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/gi,'Bearer [REDACTED]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password)\s*[=:]\s*["']?[^\s"']+/gi,'[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g,'[REDACTED]');
}
export function containsCredential(input:string):boolean { return safeText(input)!==input; }
