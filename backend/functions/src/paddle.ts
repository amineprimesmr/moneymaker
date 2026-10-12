// Paddle Billing webhooks → MoneyMaker purchases (store "paddle").
import { HttpError } from "./engine";
import { db, getCredentials, lookupIndex, upsertPurchase, Project } from "./store";
import { verifyPaddleSignature, paddleSubscriptionPurchase, paddleTransactionPurchase, paddleAppUserId } from "./paddleCore";

export async function ingestPaddleWebhook(project: Project, rawBody: Buffer, signature: string | undefined) {
  const creds = await getCredentials(project.id) as any;
  const secret: string | undefined = creds.paddle?.webhookSecret;
  if (!secret) throw new HttpError(400, "paddle_webhook_secret_missing");
  if (!verifyPaddleSignature(rawBody, signature, secret)) throw new HttpError(400, "invalid_paddle_signature");
  const event = JSON.parse(rawBody.toString("utf8"));
  const seen = db.doc(`projects/${project.id}/paddleEvents/${String(event.event_id ?? "").replace(/\//g, "_") || "unknown"}`);
  if (event.event_id && (await seen.get()).exists) return { duplicate: true };
  const d = event.data ?? {};
  const sandbox = d.id && creds.paddle?.environment === "sandbox";
  let result: unknown = { ignored: event.event_type };
  switch (event.event_type) {
    case "subscription.created": case "subscription.updated": case "subscription.activated": case "subscription.canceled":
    case "subscription.past_due": case "subscription.paused": case "subscription.resumed": case "subscription.trialing": {
      const owner = paddleAppUserId(d.custom_data) ?? await lookupIndex(project.id, `paddle:${d.id}`, `paddle_ctm:${d.customer_id}`) ?? `$paddle:${d.customer_id}`;
      const p = paddleSubscriptionPurchase(d);
      p.isSandbox = Boolean(sandbox);
      result = await upsertPurchase(project, owner, p, [`paddle:${d.id}`, ...(d.customer_id ? [`paddle_ctm:${d.customer_id}`] : [])]);
      break;
    }
    case "transaction.completed": {
      if (d.subscription_id) { result = { handledBy: "subscription.*" }; break; } // renewals arrive via subscription.updated
      const owner = paddleAppUserId(d.custom_data) ?? await lookupIndex(project.id, `paddle_ctm:${d.customer_id}`) ?? `$paddle:${d.customer_id ?? d.id}`;
      const p = paddleTransactionPurchase(d);
      p.isSandbox = Boolean(sandbox);
      result = await upsertPurchase(project, owner, p, [`paddle:${d.id}`, ...(d.customer_id ? [`paddle_ctm:${d.customer_id}`] : [])]);
      break;
    }
  }
  if (event.event_id) await seen.set({ type: event.event_type, at: Date.now() });
  return result;
}
