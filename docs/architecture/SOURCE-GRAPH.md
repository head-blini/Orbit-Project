# Source graph: bounded in-memory TypeScript analysis

Date: 2026-10-25. Implementation: `server/source-graph.ts`; shared contracts: `shared/source-graph.ts`; focused tests: `tests/source-graph.test.ts`. Installed compiler API observed: **TypeScript 5.9.3**. No new dependency was installed and no external graph service is used.

## Integration contract

```ts
analyzeSourceGraph(
  files: readonly {path: string; content: string; changed: boolean}[],
  sourceDigest: string,
  baseSha: string
): SourceGraph

sourceGraphFileId(path: string): string
```

`SourceGraph` and `SOURCE_GRAPH_LIMITS` are exported from the shared module. Results contain:

- `status:available`, analyzer name/version/policyVersion, supplied sourceDigest/baseSha;
- file/function/class/method nodes with deterministic ID, safe display label/path, file ID, one-based line and changed flag;
- contains/imports/calls/extends edges with deterministic ID, syntax/typechecker evidence and **`staticOnly:true`**;
- changedFileIds and potential reverse-dependency impact node/file IDs, with `truncated:false`;
- aggregate unresolved total and fixed reason counters;
- analyzed file count, explicit limits, externalResolution/runtimeAccuracy false and coverage limitations.

Failures throw only `Error('SOURCE_GRAPH_UNAVAILABLE')`. No input, filename, source excerpt, compiler diagnostic, module name, exception cause or raw compiler error is attached to the error. A syntax error or limit failure rejects the entire graph; it does not produce a truncated graph that appears complete.

This parser receives **trusted server-read source**, not browser paths. The integration owner must authorize the project/worktree, use the hardened reader, compute a fresh sourceDigest, bind base SHA, verify that source did not change while reading/analyzing, and discard stale results. The analyzer validates digest syntax but does not independently authenticate or recompute the supplied repository fingerprint.

## Source and compiler isolation

Only JS/JSX/TS/TSX/MJS/CJS/MTS/CTS suffixes are supported, case-insensitively. Paths are bounded Git-style relative paths; absolute, traversal, backslash/control, invalid UTF-8 round-trip, sensitive configuration/auth paths and case-alias duplicates fail closed. Case-alias duplicates are rejected on every OS for a portable virtual project. Graph paths and labels pass through the existing credential-pattern redactor. Pattern coverage is finite and does not establish that arbitrary source identifiers contain no confidential information.

Graph paths are **display metadata**, and may contain `[REDACTED]`. Never send a graph path to a file-opening endpoint. The server keeps an authoritative `sourceGraphFileId(actualPath) -> actualPath` lookup and resolves an approved file ID through its normal safe reader. IDs are deterministic SHA-256 values, not execution or file-access authorization.

Source bodies, comments, string/template literals, import module strings and compiler diagnostic text are not serialized. Declaration labels come only from identifiers/private identifiers or the fixed constructor label. Literal/computed method names are unsupported rather than copied into a label.

The compiler uses explicitly created in-memory SourceFiles and a custom map-only CompilerHost. `fileExists`, `readFile`, `getSourceFile`, directory checks, module resolution and realpath operate only on supplied maps. `noLib:true`, `types:[]` and `noEmit:true` prevent default library loading, automatic ambient type discovery and output. No tsconfig/package metadata, filesystem directory listing, network fetch, emit, package loader or project hook is invoked during analysis. Triple-slash references cannot escape the map.

The installed TypeScript library itself is an ordinary already-installed runtime dependency. The no-read boundary concerns analysis of project/default library/configuration files; it does not claim that Node loads its own module code without the filesystem.

## Declarations and connections

Supported declarations are named function implementations, named classes, named const arrow/function-expression bindings, named function expressions, identifier/private-identifier methods/accessors and constructors. Nested declarations retain containment. Overload signatures do not create fictitious implementations. Anonymous callbacks, anonymous default declarations, computed/literal methods and other unsupported function shapes are counted as unsupported declarations; calls inside an anonymous function are not attributed to an outer function by spelling.

Local import/re-export relationships resolve only within supplied files, using explicit files, supported suffixes and index files. JS suffix imports can resolve to corresponding supplied TS/TSX/MTS/CTS source. Uppercase supported suffixes are canonicalized only inside the virtual project; actual file IDs/display paths retain the supplied path. Package imports, tsconfig path aliases, package exports and external libraries are not resolved. Import edges include type-only relationships and are potential dependencies, not proof of runtime loading.

Call targets use TypeScript symbols, import/re-export aliases and actual local declaration identity. Transient/instantiated method symbols are mapped through their declarations. No same-name or text-search fallback is used: a callback parameter named like a file-level function does not connect to that function. Named let/var arrow bindings and callable bindings written by binary assignment, including array/object/rest/default/shorthand destructuring, remain unresolved. Assignment targets are traversed without treating right-hand replacement values as writes; shorthand bindings use the checker's value-symbol API. This is conservative observed-write handling, not exhaustive JavaScript mutation/control-flow analysis. Element/computed calls and unresolved targets do not invent an edge. CommonJS require/eval or returned callables are not interpreted to discover arbitrary modules or executable strings.

Class extends edges connect only to a resolved supplied class declaration. Factory/mixin/dynamic bases remain unresolved. A method call can identify the TypeScript static declaration while runtime dispatch selects an override or patched function. **All edges therefore say staticOnly; runtimeAccuracy remains false.** This is not a runtime call graph, control-flow proof, full semantic typecheck, execution trace or security analysis.

Unresolved reason counters are `external_import`, `unresolved_import`, `dynamic_import`, `unresolved_call`, `dynamic_call`, `unresolved_extends`, `unsupported_declaration`. They count encountered constructs, not a percentage of repository completeness. Aggregate counters intentionally omit raw names, expressions and module strings.

## Change impact

Changed flags must come from the authoritative Git view. The analyzer seeds changed files, their declarations, then traverses reverse imports/calls/extends/contains relationships. Reaching a file conservatively includes its members. Cycles terminate through a visited set. Disconnected files are not marked impacted.

The result is explicitly `potential-static-reverse-dependency`. It does not prove that every impacted item changes behavior or that every dynamic dependent was discovered. Config/assets/ignored source, generated code, external packages, runtime registration, reflection, string imports and other omitted files may affect behavior outside the graph. A sourceDigest can cover more files than the JS/TS subset; coverage.files reports only this analyzer's supplied subset.

The root service should compare the graph sourceDigest with a fresh current snapshot before display/export and label a mismatch stale. Saved immutable graph artifacts remain historical evidence, not a claim that today's source still matches them. Artifact creation and editable diagram/UI conversion are owned by the integration layer, not this parser.

## Bounds

`SOURCE_GRAPH_LIMITS` is frozen and exported for the reader/UI:

| Bound | Limit |
|---|---:|
| Supplied files | 100 |
| UTF-8 bytes per file | 256 KiB |
| Total UTF-8 source bytes | 4 MiB |
| AST nodes across input | 100,000 |
| AST traversal depth | 128 |
| Output nodes | 2,000 |
| Output edges | 5,000 |
| Reverse impact queue visits | 10,000 |

Paths are at most 512 characters and declaration names at most 1,024. Excess fails the complete operation. No hidden source/declaration/edge truncation is used. These bounds constrain workload and output; synchronous TypeScript parsing/type resolution is not a hard preemptible wall-clock sandbox for adversarial source.

## Verification record

Initial stub focused run failed the first behavior test, exit 1. Expanded contracts then reported 9 fail / 2 pass before implementation. The first implementation produced 10 pass / 1 fail: instance method lookup used a transient symbol not directly present in the declaration map. Mapping only actual local declarations fixed that failure and produced 11/11.

Two additional regressions were observed failing before their fixes: reader-supported uppercase suffixes were rejected, and explicitly rebound/mutable function variables could be presented as stable call targets. Suffix canonicalization and conservative rebinding checks produced 13/13 pass. Independent review then identified a P2: destructuring LHS writes did not invalidate an original callable. The new focused regression failed first for array assignment, then exposed a shorthand value-symbol distinction after recursive write traversal was added. Recursive array/object/rest/default/nested target handling and the checker shorthand API fixed both; the replacement function's valid edge remains intact. The final focused run passed **14/14**, no skipped tests:

```powershell
node --test tests/source-graph.test.ts
```

Targeted TypeScript initially found unknown-value narrowing errors in the input validator; explicit local primitive validation corrected them. Final targeted command passed, exit 0:

```powershell
node ../../node_modules/typescript/bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --allowImportingTsExtensions shared/source-graph.ts server/source-graph.ts tests/source-graph.test.ts
```

Focused fixtures verify local aliases/re-exports/JS imports, declaration kinds/containment, calls/extends, method static-only semantics, shadowing/reassignment, cycles and disconnected impact, deterministic ordering, sensitive output omission, syntax/size/count failures and map-only operation while `ts.sys.readFile/readDirectory/fileExists` throw. They do not execute analyzed source or contact a model/service. No user credentials, user DB or unrelated repository is read. Whole-product build/browser/artifact validation is the integration owner's separate gate.

The primary API reference is Microsoft's [Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API). Its Program/CompilerHost/SourceFile and custom-host concepts inform this implementation; installed 5.9.3 declarations and focused runtime results define the verified API version. The default filesystem-backed host described in examples is deliberately not used here.
