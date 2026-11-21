// Avis envoyés depuis l'app (menu → « Ton avis »). Gardés dans appFeedback/{id} et poussés en
// notification sur les iPhone de l'équipe (system/billing.testers), pour lire chaque idée tout de suite.

import { HttpError } from "./engine";
import { db } from "./store";
import { teamUids } from "./billing";

const KINDS = ["idea", "bug", "other"] as const;
type Kind = typeof KINDS[number];
const LABEL: Record<Kind, string> = { idea: "💡 Idée", bug: "🐞 Bug", other: "💬 Avis" };

export function sanitizeFeedback(body: any): { kind: Kind; message: string; appVersion: string | null; device: string | null; lang: string | null } {
  const message = String(body?.message ?? "").trim().slice(0, 4000);
  if (message.length < 2) throw new HttpError(400, "message_required", "Écris quelques mots.");
  const kind = (KINDS as readonly string[]).includes(body?.kind) ? body.kind as Kind : "other";
  const short = (v: unknown, n: number) => typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
  return { kind, message, appVersion: short(body?.appVersion, 40), device: short(body?.device, 60), lang: short(body?.lang, 10) };
}

export async function submitFeedback(uid: string, email: string | undefined, body: any) {
  const entry = sanitizeFeedback(body);
  // Garde-fou : 20 avis par heure et par compte.
  const now = Date.now();
  const userRef = db.doc(`users/${uid}`);
  const w = (await userRef.get()).get("feedbackWindow") as { start: number; count: number } | undefined;
  const window = w && now - w.start < 3_600_000 ? { start: w.start, count: w.count + 1 } : { start: now, count: 1 };
  if (window.count > 20) throw new HttpError(429, "too_many", "Merci ! Réessaie un peu plus tard.");
  await userRef.set({ feedbackWindow: window }, { merge: true });
  const ref = db.collection("appFeedback").doc();
  await ref.set({ ...entry, uid, email: email ?? null, at: now });
  await notifyTeam(entry.kind, entry.message, uid).catch(() => undefined);
  return { ok: true, id: ref.id };
}

async function notifyTeam(kind: Kind, message: string, from: string) {
  const { apnsSend, apnsConfigured } = await import("./push");
  if (!(await apnsConfigured())) return;
  const uids = (await teamUids()).filter(u => u !== from);
  for (const uid of uids) {
    const devices = (await db.collection(`users/${uid}/devices`).get()).docs.map(d => d.data()).filter(d => d.apnsToken);
    for (const d of devices) {
      await apnsSend(d.env, d.apnsToken, "alert", {
        aps: { alert: { title: `${LABEL[kind]} sur MoneyMaker`, body: message.slice(0, 220) }, sound: "default", "thread-id": "feedback" },
      }).catch(() => undefined);
    }
  }
}
