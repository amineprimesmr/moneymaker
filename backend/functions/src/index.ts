import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";
import { createHmac } from "crypto";
import { handle } from "./api";
import { db, getProject, getCredentials } from "./store";
import { snapshotProject } from "./metrics";
import { sendToAppsFlyer } from "./appsflyer";

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
  const creds = await getCredentials(project.id);
  if (!data.appsflyer) {
    // Attribution is best-effort and isolated: an AppsFlyer outage must not block the customer's own webhooks.
    const status = await sendToAppsFlyer(project, creds, data).catch(e => `error: ${(e as Error).message}`);
    await event.data!.ref.update({ appsflyer: status });
  }
  const hooks = project.config.webhooks.filter(h => !h.events?.length || h.events.includes(data.type));
  if (!hooks.length) { await event.data!.ref.update({ delivered: true }); return; }
  const { webhookSigningSecret } = creds;
  const body = JSON.stringify({ id: event.params.eid, projectId: project.id, ...data, delivered: undefined, appsflyer: undefined });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", webhookSigningSecret).update(`${t}.${body}`).digest("hex");
  const failures: string[] = [];
  await Promise.all(hooks.map(async h => {
    try {
      const res = await fetch(h.url, {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", "MoneyMaker-Signature": `t=${t},v1=${signature}`, "User-Agent": "MoneyMaker-Webhooks/1" },
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
