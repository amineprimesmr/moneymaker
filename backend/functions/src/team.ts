// Team: invitations, members, roles and the project audit log (Firestore side).
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import { db, Project } from "./store";
import { HttpError } from "./engine";
import { Role, INVITABLE_ROLES, roleOf, canManage, owners } from "./roles";

const DAY = 86400000;
const INVITE_TTL = 14 * DAY;
export const inviteLink = (base: string, token: string) => `${base}/?invite=${token}`;

/** Audit trail: one document per mutating action. Never store secret values, only field names. */
export async function audit(projectId: string, uid: string, action: string, details: Record<string, unknown> = {}) {
  await db.collection(`projects/${projectId}/audit`).add({ uid, action, at: Date.now(), details }).catch(e => console.error("audit", e));
}

export async function listAudit(projectId: string, limit = 100, before?: number) {
  let q = db.collection(`projects/${projectId}/audit`).orderBy("at", "desc").limit(Math.min(500, Math.max(1, limit)));
  if (before) q = q.startAfter(before);
  const snap = await q.get();
  const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
  const emails = await emailsFor([...new Set(rows.map(r => r.uid).filter((u: string) => u && !u.startsWith("key:")))]);
  return { entries: rows.map(r => ({ ...r, email: emails[r.uid] ?? null })) };
}

async function emailsFor(uids: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < uids.length; i += 100) {
    const res = await getAuth().getUsers(uids.slice(i, i + 100).map(uid => ({ uid }))).catch(() => ({ users: [] as any[] }));
    for (const u of res.users) out[u.uid] = u.email ?? null;
  }
  return out;
}

const rawProject = async (pid: string) => (await db.doc(`projects/${pid}`).get()).data() ?? {};

export async function listMembers(project: Project, base: string, withInviteLinks: boolean) {
  const data = await rawProject(project.id);
  const members: string[] = data.members ?? [];
  const emails = await emailsFor(members);
  const inv = await db.collection(`projects/${project.id}/invites`).where("status", "==", "pending").get();
  const now = Date.now();
  return {
    members: members.map(uid => ({ uid, email: emails[uid] ?? null, role: roleOf(data, uid), isCreator: data.ownerUid === uid })),
    invites: inv.docs.map(d => d.data()).filter(i => i.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt).map(i => ({
      id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, invitedBy: i.invitedBy,
      ...(withInviteLinks ? { link: inviteLink(base, i.token) } : {}),
    })),
  };
}

export async function createInvite(project: Project, uid: string, body: any, base: string) {
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_email");
  const role = String(body?.role ?? "developer") as Role;
  if (!INVITABLE_ROLES.includes(role)) throw new HttpError(400, "invalid_role", `Rôles : ${INVITABLE_ROLES.join(", ")}`);
  const token = `inv_${randomBytes(24).toString("base64url")}`;
  const ref = db.collection(`projects/${project.id}/invites`).doc();
  const now = Date.now();
  const invite = { id: ref.id, email, role, token, status: "pending", invitedBy: uid, createdAt: now, expiresAt: now + INVITE_TTL };
  await ref.set(invite);
  await db.doc(`inviteTokens/${token}`).set({ projectId: project.id, inviteId: ref.id, expiresAt: invite.expiresAt });
  return { id: ref.id, email, role, expiresAt: invite.expiresAt, link: inviteLink(base, token) };
}

export async function deleteInvite(project: Project, id: string) {
  const ref = db.doc(`projects/${project.id}/invites/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "invite_not_found");
  await db.doc(`inviteTokens/${snap.get("token")}`).delete().catch(() => null);
  await ref.update({ status: "revoked", revokedAt: Date.now() });
  return { ok: true, email: snap.get("email") as string };
}

/** Invite details before acceptance (project name, role) so the dashboard can confirm. */
export async function peekInvite(token: string) {
  const t = await db.doc(`inviteTokens/${token}`).get();
  if (!t.exists) throw new HttpError(404, "invite_not_found", "Invitation introuvable ou déjà utilisée");
  const inv = (await db.doc(`projects/${t.get("projectId")}/invites/${t.get("inviteId")}`).get()).data();
  const p = await rawProject(t.get("projectId"));
  if (!inv || inv.status !== "pending" || inv.expiresAt < Date.now()) throw new HttpError(410, "invite_expired", "Invitation expirée");
  return { projectId: t.get("projectId") as string, projectName: p.name as string, role: inv.role as Role, email: inv.email as string };
}

export async function acceptInvite(token: string, uid: string, callerEmail?: string) {
  if (!/^inv_[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(400, "invalid_invite_token");
  const info = await peekInvite(token);
  const email = (callerEmail ?? (await getAuth().getUser(uid).catch(() => null))?.email ?? "").toLowerCase();
  if (!email || email !== info.email) throw new HttpError(403, "invite_email_mismatch", `Cette invitation est destinée à ${info.email}`);
  const t = (await db.doc(`inviteTokens/${token}`).get()).data()!;
  const pref = db.doc(`projects/${info.projectId}`);
  await db.runTransaction(async tx => {
    const p = (await tx.get(pref)).data() ?? {};
    const already = (p.members ?? []).includes(uid);
    tx.update(pref, { members: FieldValue.arrayUnion(uid), ...(already ? {} : { [`roles.${uid}`]: info.role }) });
    tx.update(db.doc(`projects/${info.projectId}/invites/${t.inviteId}`), { status: "accepted", acceptedBy: uid, acceptedAt: Date.now() });
    tx.delete(db.doc(`inviteTokens/${token}`));
  });
  await audit(info.projectId, uid, "invite.accept", { email: info.email, role: info.role });
  return { ok: true, projectId: info.projectId, projectName: info.projectName, role: info.role };
}

export async function setMemberRole(project: Project, actor: Role, actorUid: string, target: string, role: string) {
  const data = await rawProject(project.id);
  const current = roleOf(data, target);
  if (!current) throw new HttpError(404, "member_not_found");
  if (!INVITABLE_ROLES.includes(role as Role)) throw new HttpError(400, "invalid_role", `Rôles : ${INVITABLE_ROLES.join(", ")}`);
  if (!canManage(actor, current, role as Role, target === actorUid)) throw new HttpError(403, "insufficient_role");
  if (current === "owner" && owners(data).length <= 1) throw new HttpError(409, "last_owner", "Le dernier propriétaire ne peut pas être rétrogradé");
  await db.doc(`projects/${project.id}`).update({ [`roles.${target}`]: role });
  return { uid: target, role, previous: current };
}

export async function removeMember(project: Project, actor: Role, actorUid: string, target: string) {
  const data = await rawProject(project.id);
  const current = roleOf(data, target);
  if (!current) throw new HttpError(404, "member_not_found");
  if (!canManage(actor, current, null, target === actorUid)) throw new HttpError(403, "insufficient_role");
  if (current === "owner" && owners(data).length <= 1) throw new HttpError(409, "last_owner", "Le dernier propriétaire ne peut pas quitter le projet");
  await db.doc(`projects/${project.id}`).update({ members: FieldValue.arrayRemove(target), [`roles.${target}`]: FieldValue.delete() });
  return { ok: true, uid: target, previous: current };
}
