# Native extension inventory implementation plan

> Execute with the existing subagent workflow: root owns shared types, Controller/HTTP and integration; independent agents own the bounded collector and UI. Follow the user's existing autonomy and whole-platform requirements.

**Goal:** Replace the Extensions placeholder with an explicit, read-only Codex inventory using installed official App Server schemas, without installing or activating extensions.

**Architecture:** Reuse the existing ready, MCP-isolated native session. GET returns only an in-memory cache; explicit POST collects thread-scoped MCP status and Skills/Hooks metadata. A server-owned workspace and thread scope, bounded projection and generation checks prevent arbitrary paths, policy changes and stale-session results. No new dependencies or filesystem scanner.

**Spec:** PRD FR-10, TECH-DESIGN section 10, BACKLOG S3-04, the goal's H requirements and CAPABILITY-REGISTRY.md. Installed `.local/capability-schema/v2/SkillsList*`, `HooksList*`, `ListMcpServerStatus*` are the implementation contract; schema existence is not live-runtime validation.

## Constraints and design decisions

- Keep native hooks/plugins/multi_agent/goals/dependency installation disabled. No config-write, plugin/catalog, OAuth, resource/tool, shell or model-turn calls. Never use threadless MCP discovery.
- Inventory receives no browser-controlled path/thread/provider. Reject a stale selected workspace. Do not read global configuration files or credential files directly.
- Project-specific profile preview/backup/restore is the next independent slice; this inventory has no installation or activation authority. CLI-reported enabled/trust does not mean Orbit approval.
- Discard command, env, description, prompt, matcher, sourcePath, dependency contents and raw error fields. Only bounded labels, opaque IDs, enum/boolean metadata reach browser/cache. No raw native payload in SQLite/events.
- Skills have no version in the installed schema: show unknown. Plugins and Claude inventories remain not connected. Listing failure is unknown, never an empty successful installation list.
- Read APIs can inspect native local metadata. Their live behavior and external side effects under disabled features remain unverified until a separate real smoke; fake contracts do not prove them.

## Work units

- [x] Root defines `shared/extensions.ts` and collector interfaces. Write Controller/HTTP regression tests for inert GET, explicit CSRF POST, exact workspace, busy state, closure/switch/restart, bounded caching and no turn/config mutations. Observe RED.
- [x] Independent collector in `server/extensions.ts` validates the known thread MCP isolation first, then calls Skills/Hooks list with the exact server cwd. Test malformed/oversized/foreign/duplicate metadata, forbidden-field non-access, sensitive labels, unsupported methods and honest partial status. Observe RED then GREEN.
- [x] Root connects the collector and ephemeral cache to Controller/HTTP with the existing session lifecycle. A failed MCP isolation check closes the session; ordinary unavailable list methods keep the corresponding section unknown. Cache resets on disconnect/restart and cannot cross session generations. Test no model or write RPC.
- [x] Independent `web/extensions.tsx` renders the four inventory sections, current scope, source/time, unknown version and configured-vs-effective state. Initial render/GET never POSTs. Explicit refresh rejects stale responses, duplicate clicks and foreign project scope. Keep Capability Registry alongside it.
- [ ] Run focused tests and independent review, then full tests/type/build and Windows browser checks. Add fixture-only known metadata in the existing explicitly granted fake-RPC workspace; verify explicit collection, refresh caching, restart unknown/no auto collection, raw fields absent and prior features preserved.

Mac follow-up: focused39/39, full479pass/1Windows-only skip/type/build0 and independent review completed. The busy-unlock defect was reproduced and fixed. Chrome CUA verified the two dedicated scenarios with2JPEGs and clean teardown. The automated harness now has37steps/45expectedPNGs; its full run and Windows revalidation remain pending. See ORBIT-MASTER-RESULTS for scope and evidence.

## Review focus

1. A MCP entry is unknown, active, has tools or pagination: never display verified disabled or continue using that session.
2. A previous connection replies after close/reconnect: discard the response and preserve the new connection's pending state.
3. Native metadata contains secrets, commands or paths in unexpected fields: no field spreading/stringifying raw data and no raw errors in logs/UI.
4. A list method fails or returns too many/invalid entries: unknown/partial with a fixed issue, never assert no extensions are installed.
5. A browser chooses a different planning project: do not show or refresh the other selected native workspace's inventory.

Whole Orbit remains incomplete after this slice. Profile management and verified extension installation/activation require separate implementation and acceptance gates.
