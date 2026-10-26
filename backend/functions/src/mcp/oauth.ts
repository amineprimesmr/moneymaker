// Serveur d'autorisation OAuth 2.1 du connecteur MCP (DCR + PKCE, clients publics), calqué sur V2.
// Seuls des hachés SHA-256 des jetons sont stockés. Le consentement se fait sur /connect (dashboard).
import { getAuth } from "firebase-admin/auth";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../store";
import { HttpError } from "../engine";
import { ACCESS_PREFIX, ORIGIN, ORIGINS, SCOPES, Scope, hash, opaque, scopes, redirectAllowed, redirectMatches, clientName, loopback, pkce, safeID } from "./policy";

const ACCESS_TTL = 3600_000;
const GRANT_TTL = 90 * 86400_000;
const bucket = (name: string) => db.collection("mcpOAuth").doc(name).collection("entries");
const grantRef = (uid: string, id: string) => db.doc(`users/${uid}/mcpGrants/${id}`);
const expiry = (ms: number) => Timestamp.fromMillis(Date.now() + ms);
const fail = (code = "invalid_request", status = 400): never => { throw new HttpError(status, code); };
/** Les clients peuvent omettre l'indicateur de ressource RFC 8707 ; s'il est envoyé, il doit désigner ce serveur. */
const resourceOK = (value: unknown) => value === undefined || value === "" || ORIGINS.some(o => value === o || value === `${o}/mcp`);

export const authorizationMetadataFor = (o: string) => ({
  issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`,
  registration_endpoint: `${o}/oauth/register`, revocation_endpoint: `${o}/oauth/revoke`,
  scopes_supported: SCOPES, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
  service_documentation: `${o}/mcp-docs`,
});
export const resourceMetadataFor = (o: string) => ({
  resource: `${o}/mcp`, authorization_servers: [o], scopes_supported: SCOPES, bearer_methods_supported: ["header"],
  resource_name: "MoneyMaker", resource_documentation: `${o}/mcp-docs`,
});
export const authorizationMetadata = authorizationMetadataFor(ORIGIN);
export const resourceMetadata = resourceMetadataFor(ORIGIN);

export async function rateLimit(key: string, maximum: number) {
  const ref = bucket("limits").doc(hash(`${key}:${Math.floor(Date.now() / 60000)}`));
  await db.runTransaction(async tx => {
    const count = (await tx.get(ref)).data()?.count ?? 0;
    if (count >= maximum) fail("rate_limited", 429);
    tx.set(ref, { count: count + 1, expiresAt: expiry(120000) });
  });
}

/** Enregistrement dynamique (RFC 7591) : uniquement Claude, ChatGPT et les redirections locales. */
export async function register(body: any) {
  const redirects = body?.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 5 || !redirects.every(redirectAllowed) ||
      body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") fail("invalid_client_metadata");
  const host = new URL(redirects[0]).hostname;
  if (redirects.some((r: string) => new URL(r).hostname !== host && !(loopback(r) && loopback(redirects[0])))) fail("invalid_client_metadata");
  const clientID = opaque();
  const name = clientName(redirects[0], body.client_name);
  await bucket("clients").doc(clientID).set({ redirects, name, createdAt: Timestamp.now() });
  return { client_id: clientID, client_name: name, redirect_uris: redirects, token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
}

async function authorization(params: any) {
  if (!safeID(params.client_id)) fail("invalid_client");
  const client = (await bucket("clients").doc(params.client_id).get()).data();
  if (!client || !client.redirects.some((r: string) => redirectMatches(r, params.redirect_uri))) fail("invalid_redirect_uri");
  if (params.response_type !== "code" || params.code_challenge_method !== "S256" ||
      typeof params.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge) ||
      !resourceOK(params.resource) || params.state !== undefined && (typeof params.state !== "string" || params.state.length > 2048)) fail();
  let requested: Scope[];
  try { requested = params.scope === undefined || params.scope === "" ? [...SCOPES] : scopes(params.scope); } catch { return fail("invalid_scope"); }
  return { clientID: params.client_id as string, redirect: params.redirect_uri as string, challenge: params.code_challenge as string,
    state: (params.state ?? "") as string, scopes: requested, name: client!.name as string };
}

/** GET /oauth/authorize → page de consentement /connect?request=… (10 min). */
export async function beginAuthorization(params: any, origin = ORIGIN) {
  const request = await authorization(params);
  const id = opaque();
  await bucket("requests").doc(hash(id)).set({ ...request, expiresAt: expiry(600000) });
  return `${origin}/connect?request=${encodeURIComponent(id)}`;
}
async function requestData(id: unknown) {
  if (!safeID(id)) fail();
  const ref = bucket("requests").doc(hash(id as string));
  const data = (await ref.get()).data();
  if (!data || data.expiresAt.toMillis() <= Date.now() || data.used) fail("expired_request");
  return { ref, data: data! };
}
export async function previewRequest(id: unknown) {
  const { data } = await requestData(id);
  return { name: data.name, scopes: data.scopes, redirectHost: new URL(data.redirect).host, local: loopback(data.redirect) };
}

export async function firebaseUser(header?: string): Promise<string> {
  if (!header?.startsWith("Bearer ")) fail("unauthorized", 401);
  try { return (await getAuth().verifyIdToken(header!.slice(7), true)).uid; }
  catch { return fail("unauthorized", 401); }
}

/** POST /oauth/approve (session Firebase du dashboard) : émet le code et crée l'autorisation révocable. */
export async function approve(uid: string, body: any) {
  const { ref, data } = await requestData(body?.request);
  if (body.consent !== true || !Array.isArray(body.scopes) || !body.scopes.length ||
      body.scopes.some((s: unknown) => typeof s !== "string" || !data.scopes.includes(s))) fail("invalid_scope");
  const granted = [...new Set(body.scopes as string[])];
  const code = opaque(), grantID = opaque();
  await db.runTransaction(async tx => {
    const fresh = (await tx.get(ref)).data();
    if (!fresh || fresh.used || fresh.expiresAt.toMillis() <= Date.now()) fail("expired_request");
    tx.update(ref, { used: true });
    tx.set(bucket("codes").doc(hash(code)), { ...data, uid, grantID, scopes: granted, expiresAt: expiry(120000) });
    tx.set(grantRef(uid, grantID), { clientID: data.clientID, name: data.name, scopes: granted,
      createdAt: Timestamp.now(), expiresAt: expiry(GRANT_TTL), revoked: false });
  });
  const url = new URL(data.redirect); url.searchParams.set("code", code); if (data.state) url.searchParams.set("state", data.state);
  return { redirect: url.toString() };
}

/** POST /oauth/token : code + PKCE, ou refresh (rotation, usage unique). */
export async function exchange(body: any) {
  if (!safeID(body?.client_id)) fail("invalid_client", 401);
  if (!resourceOK(body.resource)) fail("invalid_target");
  const isRefresh = body.grant_type === "refresh_token";
  if (!isRefresh && body.grant_type !== "authorization_code") fail("unsupported_grant_type");
  const raw = isRefresh ? body.refresh_token : body.code;
  if (!safeID(raw)) fail("invalid_grant");
  const ref = bucket(isRefresh ? "refresh" : "codes").doc(hash(raw));
  const data = (await ref.get()).data();
  if (!data || data.clientID !== body.client_id || data.expiresAt.toMillis() <= Date.now()) fail("invalid_grant");
  if (!isRefresh && (body.redirect_uri !== data!.redirect || !pkce(body.code_verifier, data!.challenge))) fail("invalid_grant");
  const access = ACCESS_PREFIX + opaque(), refresh = opaque();
  await db.runTransaction(async tx => {
    const [fresh, grant] = await Promise.all([tx.get(ref), tx.get(grantRef(data!.uid, data!.grantID))]);
    if (!fresh.exists || fresh.data()!.used || fresh.data()!.expiresAt.toMillis() <= Date.now() ||
        !grant.exists || grant.data()!.revoked || grant.data()!.expiresAt.toMillis() <= Date.now()) fail("invalid_grant");
    const record = { uid: data!.uid, grantID: data!.grantID, clientID: data!.clientID, scopes: data!.scopes };
    tx.update(ref, { used: true });
    tx.set(bucket("access").doc(hash(access)), { ...record, expiresAt: expiry(ACCESS_TTL) });
    tx.set(bucket("refresh").doc(hash(refresh)), { ...record, expiresAt: grant.data()!.expiresAt });
    tx.update(grantRef(data!.uid, data!.grantID), { lastUsedAt: Timestamp.now() });
  });
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, scope: data!.scopes.join(" ") };
}

/** Résout un jeton d'accès mm_oat_… (appelé par authenticate() de l'API). */
export async function resolveAccessToken(raw: string): Promise<{ uid: string; scopes: string[]; grantID: string; name: string } | null> {
  if (!raw.startsWith(ACCESS_PREFIX) || !safeID(raw)) return null;
  const data = (await bucket("access").doc(hash(raw)).get()).data();
  if (!data || data.expiresAt.toMillis() <= Date.now()) return null;
  const grant = (await grantRef(data.uid, data.grantID).get()).data();
  if (!grant || grant.revoked || grant.expiresAt.toMillis() <= Date.now()) return null;
  return { uid: data.uid, scopes: data.scopes, grantID: data.grantID, name: grant.name };
}

export async function revokeToken(body: any) {
  const token = body?.token;
  if (typeof token !== "string" || !safeID(token) || !safeID(body.client_id)) return;
  for (const name of ["access", "refresh"]) {
    const data = (await bucket(name).doc(hash(token)).get()).data();
    if (data && data.clientID === body.client_id) await grantRef(data.uid, data.grantID).update({ revoked: true });
  }
}
export async function listGrants(uid: string) {
  const snap = await db.collection(`users/${uid}/mcpGrants`).orderBy("createdAt", "desc").limit(50).get();
  return snap.docs.map(d => ({ id: d.id, name: d.get("name"), scopes: d.get("scopes"), revoked: d.get("revoked"),
    createdAt: d.get("createdAt").toDate().toISOString(), expiresAt: d.get("expiresAt").toDate().toISOString(),
    lastUsedAt: d.get("lastUsedAt")?.toDate().toISOString() ?? null }));
}
export async function revokeGrant(uid: string, id: unknown) {
  if (!safeID(id)) fail();
  const ref = grantRef(uid, id as string);
  if ((await ref.get()).exists) await ref.update({ revoked: true });
}

/** Purge quotidienne des artefacts expirés (aucune donnée business dedans). */
export async function cleanupOAuth() {
  for (const kind of ["limits", "requests", "codes", "access", "refresh"]) {
    const query = bucket(kind).where("expiresAt", "<=", Timestamp.now());
    for (let page = 0; page < 100; page++) {
      const snap = await query.limit(400).get();
      if (snap.empty) break;
      const batch = db.batch(); snap.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
    }
  }
}
