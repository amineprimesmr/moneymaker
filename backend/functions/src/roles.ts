// Team roles: pure helpers (unit-tested). Members without an explicit role are owners (legacy projects).
export type Role = "owner" | "admin" | "developer" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "developer", "viewer"];
export const INVITABLE_ROLES: Role[] = ["admin", "developer", "viewer"];
const LEVEL: Record<Role, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

export const roleLevel = (r: Role) => LEVEL[r] ?? 0;
export const atLeast = (r: Role, needed: Role) => roleLevel(r) >= roleLevel(needed);

export function roleOf(project: { members?: string[]; roles?: Record<string, string> }, uid: string): Role | null {
  if (!(project.members ?? []).includes(uid)) return null;
  const r = project.roles?.[uid] as Role | undefined;
  return r && ROLES.includes(r) ? r : "owner";
}

/** Minimum role required for a request when the route does not ask for more: writes need developer. */
export const defaultRequired = (method: string): Role => (method === "GET" || method === "HEAD" ? "viewer" : "developer");

/** Can `actor` set `target`'s role to `next` (next = null means removal)? Owners are untouchable except by owners; nobody grants owner. */
export function canManage(actor: Role, target: Role, next: Role | null, self: boolean): boolean {
  if (self && next === null) return true; // leaving is always allowed (last-owner check done by caller)
  if (!atLeast(actor, "admin")) return false;
  if (next === "owner") return false;
  if (target === "owner" && actor !== "owner") return false;
  return true;
}

export function owners(project: { members?: string[]; roles?: Record<string, string> }) {
  return (project.members ?? []).filter(u => roleOf(project, u) === "owner");
}
