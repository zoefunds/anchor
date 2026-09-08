// Phase 5 RBAC — the real scope vocabulary for API keys, derived from
// the routes that actually accept `Authorization: Bearer <key>` auth
// today (grep for `resolveOrgFromRequest` under src/app/api if this
// list ever needs re-deriving). Adding a route that takes API-key auth
// means adding/reusing a scope here and calling requireScope() in it —
// there is no wildcard escape hatch except the documented
// empty-scopes-means-full-access default for pre-existing keys.
export const API_SCOPES = [
  "cases:read",
  "cases:write",
  "evidence:write",
  "settlements:read",
  "settlements:write",
  "settlements:export",
  "analytics:read",
  "policies:read",
  "organizations:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isValidScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}
