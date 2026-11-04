// Mémoire courte pour les widgets iPhone. Un écran d'accueil peut en lancer des dizaines en
// quelques secondes et chaque aperçu lit des milliers de documents Firestore. Les widgets
// reprennent donc une réponse récente ; l'app calcule toujours et remplit cette mémoire.

export const WIDGET_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

const entries = new Map<string, { at: number; value: Promise<unknown> }>();

export const isWidget = (userAgent: unknown) => typeof userAgent === "string" && userAgent.startsWith("MoneyMakerWidgets/");

/** Appeler après le contrôle d'accès. `key` isole ce que l'appelant a le droit de voir (utilisateur ou business). */
export async function widgetCached<T>(userAgent: unknown, key: string, compute: () => Promise<T>, ttlMs = WIDGET_TTL_MS, now = Date.now()): Promise<T> {
  const hit = entries.get(key);
  if (isWidget(userAgent) && hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = compute();
  entries.delete(key);
  entries.set(key, { at: now, value });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  // Une erreur ne reste pas en mémoire : le prochain appel recalcule.
  value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
  return value;
}

export const clearWidgetCache = () => entries.clear();
