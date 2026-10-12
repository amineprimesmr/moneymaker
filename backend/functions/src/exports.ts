// Scheduled data exports (RevenueCat "Scheduled Data Exports" parity): incremental CSV / JSONL files
// pushed daily or weekly to S3 (manual SigV4), Google Cloud Storage (REST + service-account JWT) or a webhook.
// Email is accepted in the config but skipped: MoneyMaker has no outgoing mail provider yet.
import { createHash, createHmac } from "crypto";
import { JWT } from "google-auth-library";
import { db, getCredentials, getProject } from "./store";

export const DATASETS = ["transactions", "events", "customers", "subscriptions"] as const;
export type Dataset = typeof DATASETS[number];
export interface ExportConfig {
  id: string; destination: "gcs" | "s3" | "email" | "webhook"; schedule: "daily" | "weekly"; datasets: Dataset[]; format: "csv" | "jsonl";
  s3?: { bucket: string; region: string; prefix?: string }; gcs?: { bucket: string; prefix?: string }; webhook?: { url: string }; email?: { to: string };
}
export interface ExportSecrets { s3?: { accessKeyId: string; secretAccessKey: string }; gcs?: { serviceAccount: { client_email: string; private_key: string } }; webhookSecret?: string }

const fail = (code: string): never => { throw new Error(code); };
const bucketRe = /^[a-z0-9][a-z0-9.\-_]{1,220}[a-z0-9]$/;
const prefix = (p: unknown) => (p ? String(p).replace(/^\/+/, "").replace(/[^\w.\-/]/g, "").slice(0, 200).replace(/([^/])$/, "$1/") : "");

/** Validates the export list stored in project.config.exports. Pure — unit-tested. */
export function sanitizeExports(input: unknown): ExportConfig[] {
  if (input === null) return [];
  if (!Array.isArray(input) || input.length > 10) fail("invalid_exports");
  return (input as any[]).map(x => {
    const id = String(x?.id ?? "").trim();
    if (!/^[\w-]{1,40}$/.test(id)) fail("invalid_export_id");
    const destination = ["gcs", "s3", "email", "webhook"].includes(x.destination) ? x.destination : fail("invalid_export_destination");
    const schedule = x.schedule === "weekly" ? "weekly" : "daily";
    const format = x.format === "jsonl" ? "jsonl" : "csv";
    const datasets = (Array.isArray(x.datasets) && x.datasets.length ? x.datasets : [...DATASETS]).filter((d: string) => (DATASETS as readonly string[]).includes(d));
    if (!datasets.length) fail("invalid_export_datasets");
    const out: ExportConfig = { id, destination, schedule, format, datasets };
    if (destination === "s3") {
      const bucket = String(x.s3?.bucket ?? ""), region = String(x.s3?.region ?? "");
      if (!bucketRe.test(bucket) || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) fail("invalid_export_s3");
      out.s3 = { bucket, region, prefix: prefix(x.s3.prefix) };
    } else if (destination === "gcs") {
      const bucket = String(x.gcs?.bucket ?? "");
      if (!bucketRe.test(bucket)) fail("invalid_export_gcs");
      out.gcs = { bucket, prefix: prefix(x.gcs.prefix) };
    } else if (destination === "webhook") {
      let u: URL | undefined; try { u = new URL(String(x.webhook?.url)); } catch { /* handled below */ }
      if (!u || u.protocol !== "https:") fail("invalid_export_webhook");
      out.webhook = { url: u!.toString() };
    } else {
      const to = String(x.email?.to ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) fail("invalid_export_email");
      out.email = { to };
    }
    return out;
  });
}

/** Validates export secrets (stored in private/credentials.exports, keyed by export id). `null` removes one. */
export function sanitizeExportSecrets(input: any, current: Record<string, ExportSecrets> = {}): Record<string, ExportSecrets> {
  if (typeof input !== "object" || !input) fail("invalid_export_secrets");
  const next = { ...current };
  for (const [id, v] of Object.entries<any>(input)) {
    if (!/^[\w-]{1,40}$/.test(id)) fail("invalid_export_id");
    if (v === null) { delete next[id]; continue; }
    const s: ExportSecrets = { ...(next[id] ?? {}) };
    if (v.s3) {
      if (!/^[A-Z0-9]{16,128}$/.test(String(v.s3.accessKeyId)) || String(v.s3.secretAccessKey ?? "").length < 20) fail("invalid_export_s3_keys");
      s.s3 = { accessKeyId: String(v.s3.accessKeyId), secretAccessKey: String(v.s3.secretAccessKey) };
    }
    if (v.gcs) {
      const sa = typeof v.gcs.serviceAccount === "string" ? (() => { try { return JSON.parse(v.gcs.serviceAccount); } catch { return null; } })() : v.gcs.serviceAccount;
      if (!sa?.client_email || !/BEGIN PRIVATE KEY/.test(String(sa?.private_key))) fail("invalid_export_service_account");
      s.gcs = { serviceAccount: { client_email: sa.client_email, private_key: sa.private_key } };
    }
    if (v.webhookSecret) { if (String(v.webhookSecret).length < 16) fail("invalid_export_webhook_secret"); s.webhookSecret = String(v.webhookSecret); }
    next[id] = s;
  }
  return JSON.parse(JSON.stringify(next));
}

// ───────────── Serialisation (pure) ─────────────

const flat = (r: Record<string, any>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v]));
export function toCsv(rows: Record<string, any>[]): string {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))].sort();
  const cell = (v: any) => { if (v === undefined || v === null) return ""; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map(r => { const f = flat(r); return cols.map(c => cell(f[c])).join(","); })].join("\n") + "\n";
}
export const toJsonl = (rows: Record<string, any>[]) => rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
export const serialize = (rows: Record<string, any>[], format: "csv" | "jsonl") => (format === "csv" ? toCsv(rows) : toJsonl(rows));
export function objectKey(cfg: ExportConfig, projectId: string, dataset: string, until: number) {
  const p = cfg.s3?.prefix ?? cfg.gcs?.prefix ?? "";
  return `${p}${projectId}/${dataset}/${new Date(until).toISOString().slice(0, 10)}.${cfg.format}`;
}
export const isDue = (cfg: ExportConfig, now: number) => cfg.schedule === "daily" || new Date(now).getUTCDay() === 1; // weekly: Mondays

// ───────────── AWS Signature V4 (pure) ─────────────

const sha256hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
/** SigV4 URI encoding: RFC 3986 unreserved set only (encodeURIComponent leaves !'()* alone). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Signed S3 PutObject request (virtual-hosted style). Pure — unit-tested. */
export function signS3Put(o: { bucket: string; region: string; key: string; body: string; contentType: string; accessKeyId: string; secretAccessKey: string; now: number }) {
  const host = `${o.bucket}.s3.${o.region}.amazonaws.com`;
  const path = "/" + o.key.split("/").map(rfc3986).join("/");
  const amzDate = new Date(o.now).toISOString().replace(/[:-]|\.\d{3}/g, ""), date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(o.body);
  const headers: Record<string, string> = { "content-type": o.contentType, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = ["PUT", path, "", ...signed.map(h => `${h}:${headers[h]}`), "", signed.join(";"), payloadHash].join("\n");
  const scope = `${date}/${o.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  const { host: _h, ...sendHeaders } = headers;
  return { url: `https://${host}${path}`, headers: { ...sendHeaders, Authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}` } };
}

// ───────────── Data + delivery ─────────────

async function collect(pid: string, dataset: Dataset, since: number, until: number): Promise<Record<string, any>[]> {
  const base = db.collection(`projects/${pid}/${dataset === "subscriptions" ? "customers" : dataset}`);
  if (dataset === "transactions" || dataset === "events") {
    const snap = await base.where("at", ">", since).where("at", "<=", until).orderBy("at").limit(50000).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data(), delivered: undefined, integrations: undefined, pushed: undefined, appsflyer: undefined, deliveryErrors: undefined }));
  }
  const customers = await base.where("updatedAt", ">", since).where("updatedAt", "<=", until).limit(20000).get();
  if (dataset === "customers") return customers.docs.map(d => ({ appUserId: d.id, ...d.data() }));
  const rows: Record<string, any>[] = [];
  for (const c of customers.docs) {
    const ps = await c.ref.collection("purchases").get();
    ps.docs.forEach(p => rows.push({ appUserId: c.id, ...p.data() }));
  }
  return rows;
}

async function deliver(cfg: ExportConfig, secrets: ExportSecrets | undefined, fallbackSecret: string, pid: string, dataset: string, body: string, since: number, until: number) {
  const contentType = cfg.format === "csv" ? "text/csv" : "application/x-ndjson";
  const key = objectKey(cfg, pid, dataset, until);
  if (cfg.destination === "email") return "skipped_no_mail_provider";
  if (cfg.destination === "s3") {
    if (!secrets?.s3) return "missing_s3_credentials";
    const r = signS3Put({ bucket: cfg.s3!.bucket, region: cfg.s3!.region, key, body, contentType, ...secrets.s3, now: Date.now() });
    const res = await fetch(r.url, { method: "PUT", headers: r.headers, body, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`s3 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return `s3://${cfg.s3!.bucket}/${key}`;
  }
  if (cfg.destination === "gcs") {
    if (!secrets?.gcs) return "missing_gcs_credentials";
    const sa = secrets.gcs.serviceAccount;
    const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/devstorage.read_write"] });
    await client.request({
      url: `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(cfg.gcs!.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`,
      method: "POST", headers: { "Content-Type": contentType }, data: body, timeout: 60000,
    });
    return `gs://${cfg.gcs!.bucket}/${key}`;
  }
  const payload = JSON.stringify({ projectId: pid, exportId: cfg.id, dataset, format: cfg.format, since, until, filename: key.split("/").slice(-3).join("/"), content: body });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secrets?.webhookSecret ?? fallbackSecret).update(`${t}.${payload}`).digest("hex");
  const res = await fetch(cfg.webhook!.url, { method: "POST", redirect: "error", body: payload, signal: AbortSignal.timeout(60000),
    headers: { "Content-Type": "application/json", "MoneyMaker-Signature": `t=${t},v1=${sig}`, "User-Agent": "MoneyMaker-Exports/1" } });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
  return "sent";
}

/** Runs every due export of one project, incrementally since its last successful run. Never throws. */
export async function runProjectExports(pid: string, now = Date.now(), force = false) {
  const project = await getProject(pid);
  const list = ((project.config as any).exports ?? []) as ExportConfig[];
  if (!list.length) return {};
  const creds = (await getCredentials(pid)) as any;
  const stateRef = db.doc(`projects/${pid}/private/exportState`);
  const state = ((await stateRef.get()).data() ?? {}) as Record<string, { lastRunAt: number; status?: unknown }>;
  const results: Record<string, unknown> = {};
  for (const cfg of list) {
    if (!force && !isDue(cfg, now)) continue;
    const since = state[cfg.id]?.lastRunAt ?? now - (cfg.schedule === "weekly" ? 7 : 1) * 86400000;
    const status: Record<string, string> = {};
    let ok = true;
    for (const ds of cfg.datasets) {
      try {
        const rows = await collect(pid, ds, since, now);
        status[ds] = `${rows.length} rows → ${await deliver(cfg, creds.exports?.[cfg.id], creds.webhookSigningSecret, pid, ds, serialize(rows, cfg.format), since, now)}`;
      } catch (e) { ok = false; status[ds] = `error: ${(e as Error).message}`; console.warn("export failed", pid, cfg.id, ds, (e as Error).message); }
    }
    state[cfg.id] = { lastRunAt: ok ? now : since, status: { at: now, ...status } };
    results[cfg.id] = status;
  }
  await stateRef.set(state);
  return results;
}
