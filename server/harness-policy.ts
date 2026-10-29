import {createHash} from 'node:crypto';
import {containsCredential} from './privacy.ts';
import {outboundDenial} from './providers/policy.ts';
import {HARNESS_ALLOWED, HARNESS_CONTROL_CHARS, HARNESS_MAX_LINE_CHARS, HARNESS_MAX_LINES, HARNESS_REASON_ORDER,
  type HarnessClass, type HarnessClassification, type HarnessReason, type HarnessTarget, type HarnessVersion} from '../shared/harness.ts';

/** Content digest of {class,target,lines}; a candidate and the version promoted from it share it. */
export function harnessDigest(value: {class: HarnessClass; target: HarnessTarget; lines: readonly string[]}): string {
  return createHash('sha256').update(JSON.stringify(['orbit-harness/1', value.class, value.target, value.lines])).digest('hex');
}

/** v0: the empty overlay, identical to current behaviour and the final rollback point. */
export function harnessV0(target: HarnessTarget): HarnessVersion {
  return {versionId: `harness-v0-${target}`, class: 'execution_guidance', target, revision: 0, lines: [], parentId: null,
    digest: harnessDigest({class: 'execution_guidance', target, lines: []})};
}

// The structural allow table (class/target, append-only, size caps) is the primary defence; the patterns
// below are a secondary, finite net. They over-block by design and cannot catch paraphrase or obfuscation.
const near = (a: string, b: string, gap = 40) => new RegExp(`(?:${a})[^]{0,${gap}}?(?:${b})|(?:${b})[^]{0,${gap}}?(?:${a})`, 'u');

const KO_PROTECTED = /권한|샌드박스|승인|인증|로그인|자격\s*증명|비밀\s*번호|토큰|api\s*키|네트워크|인터넷|외부\s*(?:전송|호출|요청|접속|서버)|유료|과금|결제|요금|스케줄러|리뷰어|검토자|검증\s*(?:설정|정책)|우회|업로드|배포|푸시|하네스/u;
const KO_CRITERIA = '기준|목표|수용\\s*조건|완료\\s*조건|요구\\s*사항|하지\\s*않을\\s*것|제약';
const KO_CHANGE = '변경|바꾸|바꿔|바뀐|바뀌|수정|완화|삭제|제거|생략|무시|재해석|대체|축소|낮추|낮춰|어기|어겨|따르지';
const KO_CHECKS = '검사|테스트|검증|린트|타입\\s*(?:체크|검사)|훅|체크|ci';
const KO_SKIP = '생략|건너뛰|건너뜀|건너띄|스킵|하지\\s*마|하지\\s*말|비활성|끄(?:고|기|세요|십시오|어|다)|꺼|무시|우회|빼|제외|주석\\s*처리';
const EN_CRITERIA = '\\bcriteri\\w*|\\bacceptance\\b|\\bgoals?\\b|\\bobjectives?\\b|\\brequirements?\\b|\\bnon-?goals?\\b|\\bconstraints?\\b';
const EN_CHANGE = '\\b(?:chang|modif|alter(?:s|ed|ing)?\\b|ignor|disregard|relax|loosen|overrid|rewrit|drop|remov|delet|replac|reinterpret|redefin|lower|weaken|bypass|skip|narrow)';
const EN_CHECKS = '\\bchecks?\\b|\\btest\\w*|\\blint\\w*|\\bverif\\w*|\\bvalidat\\w*|\\btype-?\\s?check\\w*|\\bhooks?\\b|\\bci\\b|\\bassert\\w*|quality gate';
const EN_SKIP = "\\b(?:skip|disabl|bypass|omit|ignor|suppress|silenc|comment(?:ing)?\\s+out|turn(?:ing)?\\s+off|don'?t\\s+run|do\\s+not\\s+run|without\\s+running|avoid\\s+running)|\\.skip\\b|\\.only\\b|xfail";

const OVERRIDE_PATTERNS: readonly RegExp[] = [
  near(KO_CRITERIA, KO_CHANGE), near(KO_CHECKS, KO_SKIP), near(EN_CRITERIA, EN_CHANGE), near(EN_CHECKS, EN_SKIP),
  KO_PROTECTED,
  /(?:통과|성공|완료)\s*(?:했다고|됐다고|되었다고|한\s*것으로|된\s*것으로|으로|로|라고)\s*(?:보고|표시|선언|처리|간주|기록|적)/u,
  /(?:이전|위의?|앞의?|기존|상위|시스템)\s*(?:의\s*)?(?:모든\s*)?(?:지침|지시|규칙|문장|명령|프롬프트)\S{0,4}\s*(?:무시|따르지|잊)/u,
  /\b(?:mark|report|declare|claim|treat|record)\w*\s+(?:\S+\s+){0,3}as\s+(?:passed|passing|green|successful|success|completed?|done|verified)\b/u,
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding|system|orbit|safety)\b|\byou\s+are\s+now\b|\bnew\s+instructions\b/u,
  /--no-verify|--dangerously\w*|--yolo|\[skip ci\]|\bskip[-_]?ci\b|@ts-(?:ignore|nocheck|expect-error)|eslint-disable|\bnoqa\b|type:\s*ignore/u,
  /\bpermission\w*|\bsandbox\w*|\bapprov\w*|\bauth\b|\bauthenticat\w*|\bauthoriz\w*|\boauth\b|\blog-?\s?in\b|\bcredential\w*|\bpassword\w*|\bapi[-_\s]?keys?\b|\btokens?\b/u,
  /\bnetwork\w*|\binternet\b|https?:\/\/|\bcurl\b|\bwget\b|\bpaid\b|\bbilling\b|\bpayments?\b|\bupload\w*|\bwebhooks?\b|\bexfiltrat\w*|\bexternal\s+(?:transmission|send|request|call|server)/u,
  /\bsudo\b|\bchmod\b|\bchown\b|\bbypass\w*|\bescalat\w*|\bscheduler\b|\breviewer\w*|\bverification\s+(?:settings?|config\w*|polic\w*)|\bgit\s+push\b|\bforce[-\s]?push\b|\bdeploy\w*|\bharness\b/u,
];

/** Lines that could impersonate a protected prompt section, a role marker or the overlay header itself. */
const HEADING_LABEL = /^(?:#|```|~~~|===|---|\[?(?:system|assistant|developer|user)\]?\s*:|(?:작업|프로젝트\s*목표|승인\s*기준|완료\s*조건|제약|하지\s*않을\s*것|승인된\s*결정과\s*이유|사용자\s*자료|추가\s*실행\s*지침|task|goal|acceptance\s+criteria|constraints|non-?goals|decisions|instructions?)\s*[:：(])/u;
const ROLE_TAG = /<\/?\s*(?:system|assistant|user|developer|instructions?)\b/u;

function policyOverride(line: string): boolean {
  const text = line.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
  const head = text.replace(/^[\s\-*+>•·\d.)]*/u, '');
  return HEADING_LABEL.test(head) || HEADING_LABEL.test(text) || ROLE_TAG.test(text) || OVERRIDE_PATTERNS.some(pattern => pattern.test(text))
    || KO_PROTECTED.test(text.replace(/\s+/gu, '')); // "권 한" style spacing
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** AX06 refusal. Pure and deterministic: reasons are deduplicated and sorted by HARNESS_REASON_ORDER. */
export function classifyHarnessCandidate(candidate: unknown): HarnessClassification {
  const reasons = new Set<HarnessReason>();
  const c = (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) ? candidate : {}) as Record<string, unknown>;
  const evidence = c.evidence as Record<string, unknown> | null | undefined;
  if (!isStringArray(c.lines) || c.lines.length === 0 || (c.origin !== 'rule' && c.origin !== 'user')
    || (evidence !== null && (typeof evidence !== 'object' || evidence === undefined || !isStringArray(evidence.familyIds) || !isStringArray(evidence.caseIds) || typeof evidence.indexerVersion !== 'string' || !evidence.indexerVersion))
    || (c.origin === 'rule' && (!evidence || !(evidence.familyIds as string[]).length)))
    reasons.add('HARNESS_INVALID');
  const allowed = typeof c.class === 'string' && Object.hasOwn(HARNESS_ALLOWED, c.class) ? HARNESS_ALLOWED[c.class as HarnessClass] : [];
  if (!allowed.includes(c.target as HarnessTarget)) reasons.add('HARNESS_CLASS_PROTECTED');
  const lines = isStringArray(c.lines) ? c.lines : [];
  if (lines.length > HARNESS_MAX_LINES || lines.some(line => line.length > HARNESS_MAX_LINE_CHARS)) reasons.add('HARNESS_TOO_LARGE');
  if (lines.some(line => !line.trim() || line.trim() !== line)) reasons.add('HARNESS_INVALID');
  // Cap scanning work so an oversized payload cannot make the inspectors expensive or throw.
  // shortcut: each line is scanned alone (a joined scan over-blocked normal guidance), so intent split across bullets can pass; HE-4 evaluation and user approval remain the gate.
  for (const line of lines.slice(0, HARNESS_MAX_LINES + 1).map(line => line.slice(0, HARNESS_MAX_LINE_CHARS * 2))) {
    if (HARNESS_CONTROL_CHARS.test(line) || containsCredential(line) || outboundDenial(line) !== null) reasons.add('HARNESS_UNSAFE_TEXT');
    if (policyOverride(line)) reasons.add('HARNESS_POLICY_OVERRIDE');
  }
  return reasons.size ? {status: 'blocked', reasons: HARNESS_REASON_ORDER.filter(reason => reasons.has(reason))} : {status: 'eligible'};
}
