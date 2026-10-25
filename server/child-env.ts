// Preserve OS runtime and existing CLI authentication discovery, never the
// parent's credentials or arbitrary execution/configuration overrides.
const allowed = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR',
  'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'
]);

export function buildChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(source)) {
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (!allowed.has(key)) continue;
    const value = source[name];
    if (value === undefined) continue;
    if (Object.hasOwn(env, key) && env[key] !== value) throw new Error('CHILD_ENV_CONFLICT');
    env[key] = value;
  }
  return env;
}
