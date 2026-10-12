// Apple Search Ads attribution via AdServices: the SDK sends the AAAttribution token as attribute `$appleAdsToken`,
// we exchange it at https://api-adservices.apple.com/api/v1/ and store campaign / ad group / keyword ids on the customer.
import { db } from "./store";
import { APPLE_ADS_URL, parseAppleAds } from "./connectors";

/** Best-effort, never throws. Apple may answer 404 for a few seconds after token creation: retried a few times. */
export async function resolveAppleAds(projectId: string, appUserId: string, token: string): Promise<void> {
  if (!token || token.length < 20) return;
  const ref = db.doc(`projects/${projectId}/customers/${appUserId}`);
  try {
    if ((await ref.get()).get("appleAds")?.resolvedAt) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(APPLE_ADS_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: token, signal: AbortSignal.timeout(8000) });
      if (res.status === 404) { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (!res.ok) { console.warn("appleAds", projectId, res.status); return; }
      await ref.set({ appleAds: { ...parseAppleAds(await res.json()), resolvedAt: Date.now() } }, { merge: true });
      return;
    }
  } catch (e) { console.warn("appleAds failed", projectId, (e as Error).message); }
}
