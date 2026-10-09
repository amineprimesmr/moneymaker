import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";
import { createHmac } from "crypto";
import { handle } from "./api";
import { db, getProject, getCredentials } from "./store";
import { snapshotProject } from "./metrics";
import { sendToAppsFlyer } from "./appsflyer";
import { toRevenueCatEvent } from "./rccompat";
import { computeEntitlements } from "./engine";
import { fanOut } from "./integrations";
import { pushEvent, pushRanking, sendDailySummaries } from "./push";
import { syncDownloads } from "./downloads";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";

import { importRevenueCat } from "./revenuecat";
import { FieldValue } from "firebase-admin/firestore";
import { scanRankings, scanRatings, scanReviews, countriesForRun, PRIORITY_COUNTRIES } from "./appstore";

setGlobalOptions({ region: "europe-west1", maxInstances: 20 });

export const api = onRequest({ timeoutSeconds: 60, memory: "512MiB", concurrency: 80, cors: false }, handle);

/** Delivers every lifecycle event to the project's own backends, signed with HMAC-SHA256. Retried by Eventarc on failure. */
export const deliverEvent = onDocumentCreated({ document: "projects/{pid}/events/{eid}", retry: true }, async event => {
  // Re-read: on retries the trigger payload is the creation snapshot, not the current delivery state.
  const data = event.data ? (await event.data.ref.get()).data() : undefined;
  if (!data || data.delivered) return;
  const createdAt = Number(data.at ?? Date.now());
  if (Date.now() - createdAt > 24 * 3600000) return; // stop retrying after a day
  const project = await getProject(event.params.pid);
  // iOS push first: it is what the founder feels instantly. Isolated so it never blocks webhooks.
  if (!data.pushed) {
    const push = await pushEvent(project, { id: event.params.eid, ...data }).catch(e => ({ error: (e as Error).message }));
    await event.data!.ref.update({ pushed: push });
  }
  const creds = await getCredentials(project.id);
  if (!data.appsflyer) {
    // Attribution is best-effort and isolated: an AppsFlyer outage must not block the customer's own webhooks.
    const status = await sendToAppsFlyer(project, creds, data).catch(e => `error: ${(e as Error).message}`);
    await event.data!.ref.update({ appsflyer: status });
  }
  if (!data.integrations) {
    const status = await fanOut(project, creds, { id: event.params.eid, ...data }, "event");
    await event.data!.ref.update({ integrations: status });
  }
  const hooks = project.config.webhooks.filter(h => !h.events?.length || h.events.includes(data.type));
  if (!hooks.length) { await event.data!.ref.update({ delivered: true }); return; }
  const { webhookSigningSecret } = creds;
  const body = JSON.stringify({ id: event.params.eid, projectId: project.id, ...data, delivered: undefined, appsflyer: undefined, integrations: undefined, pushed: undefined });
  const t = Math.floor(Date.now() / 1000);
  const auth = ((creds as any).webhookAuthorization ?? {}) as Record<string, string>;
  const entitlementIds = Object.entries(project.config.entitlements).filter(([, ids]) => ids.includes("*") || ids.includes(data.productId)).map(([id]) => id);
  const rcEvent = hooks.some(h => (h as any).format === "revenuecat") ? toRevenueCatEvent(data, event.params.eid, entitlementIds) : null;
  const failures: string[] = [];
  await Promise.all(hooks.map(async h => {
    try {
      const isRc = (h as any).format === "revenuecat";
      if (isRc && !rcEvent) return; // no RevenueCat equivalent (e.g. GRANT)
      const payload = isRc ? JSON.stringify({ api_version: "1.0", event: rcEvent }) : body;
      const res = await fetch(h.url, {
        method: "POST", body: payload, redirect: "error", signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json", "MoneyMaker-Signature": `t=${t},v1=${createHmac("sha256", webhookSigningSecret).update(`${t}.${payload}`).digest("hex")}`,
          "User-Agent": "MoneyMaker-Webhooks/1", ...(auth[h.id] ? { Authorization: auth[h.id] } : {}),
        },
      });
      if (!res.ok) failures.push(`${h.id}:${res.status}`);
    } catch (e) { failures.push(`${h.id}:${(e as Error).message}`); }
  }));
  await event.data!.ref.update({ delivered: failures.length === 0, deliveryErrors: failures, deliveryAttemptAt: Date.now() });
  if (failures.length) throw new Error(`Webhook delivery failed: ${failures.join(", ")}`);
});

export const dailySnapshot = onSchedule({ schedule: "5 0 * * *", timeZone: "UTC" }, async () => {
  const projects = await db.collection("projects").select().get();
  for (const doc of projects.docs) {
    try { await snapshotProject(await getProject(doc.id)); } catch (e) { console.error("snapshot", doc.id, e); }
  }
});

/** Ranking alerts → Slack/Discord + the project's own webhooks (type RANKING_*). */
export const deliverAlert = onDocumentCreated({ document: "projects/{pid}/alerts/{aid}", retry: false }, async event => {
  const data = event.data?.data();
  if (!data || data.delivered) return;
  const project = await getProject(event.params.pid);
  await pushRanking(project, data).catch(e => console.error("push ranking", e));
  const creds = await getCredentials(project.id);
  const integrations = await fanOut(project, creds, data, "alert");
  const body = JSON.stringify({ id: event.params.aid, projectId: project.id, ...data, type: `RANKING_${data.type}`, delivered: undefined });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", creds.webhookSigningSecret).update(`${t}.${body}`).digest("hex");
  await Promise.all(project.config.webhooks.filter(h => !h.events?.length || h.events.includes(`RANKING_${data.type}`)).map(h =>
    fetch(h.url, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", "MoneyMaker-Signature": `t=${t},v1=${signature}` } }).catch(() => null)));
  await event.data!.ref.update({ delivered: true, integrations });
});

/** 21:00 local recap — runs hourly, each device fires in its own timezone. */
export const dailySummaryPush = onSchedule({ schedule: "0 * * * *", timeZone: "UTC" }, async () => {
  console.log("daily summaries", await sendDailySummaries());
});

/** Apple publishes yesterday's Sales report around 08:00 PT; fill the gaps every morning. */
export const downloadsSync = onSchedule({ schedule: "30 17 * * *", timeZone: "UTC", timeoutSeconds: 540 }, async () => {
  const projects = await db.collection("projects").where("config.apple.vendorNumber", "!=", null).select().get();
  for (const d of projects.docs) {
    try { console.log("downloads", d.id, await syncDownloads(await getProject(d.id))); } catch (e) { console.error("downloads", d.id, e); }
  }
});

/** First import (30 days) as soon as a vendor number is saved. */
export const downloadsBackfill = onDocumentUpdated({ document: "projects/{pid}", timeoutSeconds: 540 }, async event => {
  const before = event.data?.before.get("config.apple.vendorNumber"), after = event.data?.after.get("config.apple.vendorNumber");
  if (!after || before === after) return;
  console.log("downloads backfill", event.params.pid, await syncDownloads(await getProject(event.params.pid), 30));
});

const heavy = { timeoutSeconds: 540, memory: "1GiB" as const };

export const rankingsScan = onSchedule({ schedule: "every 60 minutes", ...heavy }, async () => {
  const run = Math.floor(Date.now() / 3600000);
  console.log("rankings", await scanRankings(undefined, countriesForRun(run)));
});

export const ratingsAndReviewsScan = onSchedule({ schedule: "every 6 hours", ...heavy }, async () => {
  const apps = (await db.collection("apps").get()).docs.filter(d => (d.get("trackers") ?? []).length);
  for (const a of apps) {
    try { await scanRatings(a.id); await scanReviews(a.id); } catch (e) { console.error("ratings/reviews", a.id, e); }
  }
});

/** On-demand scan right after an app is tracked or a refresh is requested. */
export const scanOnRequest = onDocumentCreated({ document: "scanRequests/{rid}", ...heavy }, async event => {
  const appIds: string[] = event.data?.get("appIds") ?? [];
  if (!appIds.length) return;
  // Fast first look on the biggest markets; the hourly rotation fills in every other storefront.
  const rankings = await scanRankings(appIds, PRIORITY_COUNTRIES);
  for (const id of appIds) { await scanRatings(id).catch(() => null); await scanReviews(id).catch(() => null); }
  await event.data!.ref.update({ doneAt: Date.now(), rankings });
});

export const runImportJob = onDocumentCreated({ document: "importJobs/{jid}", timeoutSeconds: 540, memory: "512MiB" }, async event => {
  const job = event.data?.data();
  if (!job || job.status !== "queued") return;
  const ref = event.data!.ref;
  await ref.update({ status: "running", startedAt: Date.now() });
  try {
    const result = await importRevenueCat(await getProject(job.projectId), job);
    await ref.update({ status: "done", result, doneAt: Date.now(), secretKey: FieldValue.delete(), appUserIds: FieldValue.delete() });
  } catch (e) {
    await ref.update({ status: "failed", error: (e as Error).message, doneAt: Date.now(), secretKey: FieldValue.delete() });
  }
});
