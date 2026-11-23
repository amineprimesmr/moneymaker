// Écrans repris de l'app iPhone : Accueil, détail d'une carte, Ventes, fiche de vente, Client, Apps, Classement, Planète.
import { esc, ic, money, int, flag, dotsCanvas, dailySeries, halfOverHalf, deltaBadge, projectIcon, platformMark, storeBadges, logoFan, wideTile, sliderTrack, vline, neon, tileHead, hydrate, paintDots, eventBadge, tbadge, storeLabel, isRevenueEvent, isRefundEvent, productLabel, stars, skeleton, ago, glowChart } from "./kit.js";
import { mountGlobe, globeSpots } from "./globe.js";

let h; // { api, state, go, back, toast, openModal, newProjectDialog, assistantCard, countryName, alertRow, openProject }
export const initScreens = helpers => { h = helpers; };

// ── Store : même rôle que Store.swift (cache, périmètre multi-business, focus) ───────────
const store = { overview: null, today: null, feed: [], long: null, longAt: 0, at: 0, loading: null };
let cleanups = [];
let nav = 0;
export const leave = () => { nav++; cleanups.forEach(f => { try { f(); } catch {} }); cleanups = []; };
const load = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const save = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
const pref = key => { try { return localStorage.getItem(key); } catch { return null; } };
const curQ = () => pref("mmCurrency") ? `currency=${pref("mmCurrency")}` : "";
/** Devise d'affichage effective : celle choisie, sinon celle de la vue d'ensemble. Ventes et « Aujourd'hui » sont convertis dedans. */
const dispQ = () => curQ() || (store.overview?.currency ? `currency=${store.overview.currency}` : "");
const tz = () => pref("mmUTC") ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
const withQ = (path, q) => q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;

export const allProjects = () => [...(store.overview?.projects ?? [])].sort((a, b) => b.mrrMicros - a.mrrMicros);
function activeIds() {
  const all = allProjects().map(p => p.projectId), saved = load("mmActive");
  const kept = Array.isArray(saved) ? saved.filter(id => all.includes(id)) : [];
  return kept.length ? kept : all;
}
const selectedProjects = () => { const ids = activeIds(); return allProjects().filter(p => ids.includes(p.projectId)); };
const viewIds = () => { const f = h.state.focus; return f && activeIds().includes(f) ? [f] : activeIds(); };
const sum = (ps, f) => ps.reduce((s, p) => s + (f(p) ?? 0), 0);
// Type de business : "app" (téléchargements), "web" (SaaS : pas de téléchargement, seulement des clients payants), "hybrid" (app + paiements web).
const isApp = p => p.kind ? p.kind !== "web" : (p.stores ?? []).some(s => s === "app_store" || s === "play_store" || s === "google_play") || p.downloads != null;
const KIND_LABEL = { app: "App", web: "Web", hybrid: "App + Web" };
const appsOf = o => o.projects.filter(isApp);
function scopeOverview(o, ids = viewIds()) {
  if (!o) return null;
  const projects = o.projects.filter(p => ids.includes(p.projectId));
  const anyDl = projects.some(p => p.downloads != null);
  return {
    // revenueMicros = ventes brutes (jamais négatives) ; remboursements à part. Repli sur le net pour un serveur plus ancien.
    ...o, projects, mrrMicros: sum(projects, p => p.mrrMicros), revenueMicros: sum(projects, p => p.revenueMicros ?? p.netRevenueMicros), refundsMicros: sum(projects, p => p.refundsMicros ?? 0),
    activeSubscriptions: sum(projects, p => p.activeSubscriptions), activeTrials: sum(projects, p => p.activeTrials), newCustomers: sum(projects, p => p.newCustomers),
    payingCustomers: sum(projects, p => p.payingCustomers ?? p.activeSubscriptions), downloads: anyDl ? sum(projects, p => p.downloads) : null, hasTrials: projects.some(p => p.hasTrials),
    // Téléchargements en direct : installations vues par le SDK, en attendant les chiffres Apple (J+1 à J+2).
    downloadsLive: projects.some(p => p.downloadsSource === "live" || p.downloadsSource === "mixed"),
  };
}
const mergedByDay = o => { const acc = {}; for (const p of o.projects) for (const [k, v] of Object.entries(p.revenueByDay ?? {})) acc[k] = (acc[k] ?? 0) + v; return acc; };
// « Aujourd'hui » : ventes brutes (jamais négatives), les remboursements sont affichés à part.
// Solde net (ventes − remboursements) : négatif si les remboursements dépassent les ventes.
const gross = t => t ? (t.revenueMicros ?? 0) - (t.refundsMicros ?? 0) : 0;
const netOf = o => (o.revenueMicros ?? 0) - (o.refundsMicros ?? 0);
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

async function refresh() {
  store.loading ??= (async () => {
    // Le flux est demandé dans la devise d'affichage : chaque vente porte displayMicros, les totaux ne mélangent jamais € et $.
    const feed = q => h.api(withQ("/v1/feed?limit=120", q)).catch(() => ({ events: [] }));
    let o, f;
    if (curQ()) [o, f] = await Promise.all([h.api(withQ("/v1/overview?days=30", curQ())), feed(curQ())]);
    else { o = await h.api("/v1/overview?days=30"); f = await feed(`currency=${o.currency}`); }
    store.overview = o; store.feed = f.events ?? [];
    await refreshToday();
    store.at = Date.now();
    renderSide(); renderTopbar();
  })().finally(() => { store.loading = null; });
  return store.loading;
}
async function refreshToday() {
  const ids = viewIds(), scoped = ids.length !== (store.overview?.projects.length ?? 0);
  store.today = await h.api(withQ(`/v1/today?tz=${encodeURIComponent(tz())}${scoped ? `&projectIds=${ids.join(",")}` : ""}`, dispQ())).catch(() => null);
}
export const ensureStore = async (maxAge = 60000) => { if (!store.overview) await refresh(); else if (Date.now() - store.at > maxAge) refresh().then(() => h.onStoreChange?.()).catch(() => {}); };
export const invalidateStore = () => { store.at = 0; store.overview = null; store.long = null; };
async function loadLong() {
  if (store.long && Date.now() - store.longAt < 3e5) return store.long;
  store.long = await h.api(withQ("/v1/overview?days=365", curQ())); store.longAt = Date.now();
  return store.long;
}

// ── Coque : tab bar et menu latéral ─────────────────────────────────────────────────────
const TABS = [["home", "grid", "Accueil"], ["feed", "bolt", "Ventes"], ["apps", "star", "Apps"], ["board", "trophy", "Classement"]];
export const desktop = () => matchMedia("(min-width: 1024px)").matches;
const TAB_OF = { home: "home", metric: "home", planet: "home", project: "home", feed: "feed", tx: "feed", customer: "feed", apps: "apps", app: "apps", board: "board" };
export function renderTabbar() {
  const bar = document.getElementById("tabbar"), cur = TAB_OF[h.state.view] ?? "home";
  if (bar.children.length !== TABS.length) {
    bar.innerHTML = TABS.map(([k, i, t]) => `<button class="tab" data-tabbar="${k}" aria-label="${t}">${ic(i, 20)}<span class="t">${t}</span></button>`).join("");
    bar.querySelectorAll("[data-tabbar]").forEach(b => b.onclick = () => { h.state.search = ""; h.go({ view: b.dataset.tabbar, projectId: null }); });
  }
  bar.querySelectorAll("[data-tabbar]").forEach(b => { const on = b.dataset.tabbar === cur; b.classList.toggle("on", on); on ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"); });
  const sideCur = h.state.view === "project" ? null : TAB_OF[h.state.view];
  const nav = document.getElementById("sideNav");
  nav.innerHTML = TABS.map(([k, i, t]) => `<button class="${k === sideCur ? "on" : ""}" data-nav="${k}" ${k === sideCur ? 'aria-current="page"' : ""}>${ic(i, 18)}<span>${t}</span></button>`).join("");
  nav.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => h.go({ view: b.dataset.nav, projectId: null }));
  renderSide();
  renderTopbar();
}
export const closeMenu = () => document.getElementById("app").classList.remove("menu-open");
export const toggleMenu = force => { const a = document.getElementById("app"), on = a.classList.toggle("menu-open", force); if (on) { renderSide(); paintSideDots(); } };

function paintSideDots() {
  const side = document.getElementById("side");
  if (side.querySelector("canvas")) return;
  [["bottomLeading", .62, .55, 7, 420, "left:0;bottom:0;width:100%"], ["bottomTrailing", .5, .35, 13, 300, "left:0;bottom:0;width:100%"], ["topTrailing", .75, .5, 21, 380, "left:0;top:0;width:100%"], ["topLeading", .55, .35, 33, 260, "left:0;top:0;width:100%"]].forEach(([anchor, reach, max, seed, height, css]) => {
    const c = document.createElement("canvas");
    c.dataset.anchor = anchor; c.dataset.reach = reach; c.dataset.seed = seed; c.style.cssText = `${css};height:${height}px`;
    side.prepend(c);
    paintDots(c, { ink: "0,0,0", maxOpacity: max });
  });
}
const setupCache = {};
export function renderSide() {
  const nav = document.getElementById("projectNav"), list = allProjects();
  if (!nav) return;
  const fallback = h.state.projects.filter(p => !list.some(x => x.projectId === p.id)).map(p => ({ projectId: p.id, name: p.name, stores: [] }));
  const ids = activeIds();
  nav.innerHTML = [...list, ...fallback].map(p => {
    const on = ids.includes(p.projectId), s = setupCache[p.projectId];
    return `<div class="biz ${on ? "" : "off"} ${h.state.projectId === p.projectId ? "cur" : ""}" data-biz="${esc(p.projectId)}">
      <button class="bn" data-name="${esc(p.projectId)}" aria-pressed="${on}"><span class="bic">${projectIcon(p, 38)}${s != null ? `<i class="st" style="background:${s >= 1 ? "var(--accent)" : "var(--orange)"}"></i>` : ""}</span><span><bdi>${esc(p.name)}</bdi></span></button>
      <button class="bgo" data-open="${esc(p.projectId)}" aria-label="Ouvrir ${esc(p.name)}">${ic("right", 13)}</button>
      <button class="bck" data-toggle="${esc(p.projectId)}" aria-label="Sélectionner ${esc(p.name)}" style="color:${on ? "rgb(0,184,120)" : "rgba(0,0,0,.18)"}">${ic(on ? "checkf" : "ring", 22)}</button></div>`;
  }).join("");
  nav.querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => toggleBusiness(b.dataset.toggle));
  nav.querySelectorAll("[data-name]").forEach(b => b.onclick = () => desktop() ? h.openProject(b.dataset.name) : toggleBusiness(b.dataset.name));
  nav.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { closeMenu(); h.openProject(b.dataset.open); });
  for (const p of list) if (setupCache[p.projectId] == null) {
    setupCache[p.projectId] = -1;
    h.api(`/v1/projects/${p.projectId}/setup`).then(s => { setupCache[p.projectId] = s.progress; renderSide(); }).catch(() => {});
  }
}
function toggleBusiness(id) {
  const ids = activeIds();
  if (ids.includes(id)) {
    if (ids.length === 1) { const row = document.querySelector(`[data-biz="${CSS.escape(id)}"]`); row?.classList.remove("shake"); void row?.offsetWidth; row?.classList.add("shake"); return; }
    save("mmActive", ids.filter(x => x !== id));
    if (h.state.focus === id) h.state.focus = null;
  } else save("mmActive", [...ids, id]);
  renderSide();
  scopeChanged();
}
async function scopeChanged() {
  await refreshToday();
  h.onStoreChange?.();
}

function fanRow() {
  const sel = selectedProjects(), f = h.state.focus, p = sel.find(x => x.projectId === f);
  return logoFan(sel, f) + (p ? `<button class="focus-pill glass" data-goproject="${esc(p.projectId)}">${platformMark(p.stores, 26) || projectIcon(p, 26)}<span><bdi>${esc(p.name)}</bdi></span></button>` : "");
}
function bindFan(root, repaint) {
  root.querySelectorAll("[data-focus]").forEach(b => b.onclick = async () => {
    h.state.focus = h.state.focus === b.dataset.focus ? null : b.dataset.focus;
    repaint();
    await refreshToday();
    repaint();
  });
  root.querySelectorAll("[data-goproject]").forEach(b => b.onclick = () => h.openProject(b.dataset.goproject));
}

// ── Accueil ─────────────────────────────────────────────────────────────────────────────
const METRICS = {
  today: { icon: "bolt", seed: 0, money: true, title: () => "Aujourd'hui", explain: "Ventes encaissées depuis minuit (hors achats de test), avant remboursements. Les remboursements du jour sont indiqués à part." },
  mrr: { icon: "cycle", seed: 1, money: true, title: () => "MRR", explain: "Revenu récurrent mensuel : ce que rapportent les abonnements actifs chaque mois." },
  revenue: { icon: "euro", seed: 2, money: true, title: o => `Revenu ${o.periodDays} j`, explain: "Ventes encaissées sur la période, tous canaux confondus, avant remboursements (indiqués à part)." },
  subscriptions: { icon: "people", seed: 3, title: () => "Abonnés actifs", explain: "Abonnements en cours et renouvelés, hors essais gratuits." },
  paying: { icon: "card", seed: 4, title: () => "Utilisateurs payants", explain: "Clients qui paient en ce moment : abonnés actifs et achats encore valables. Les nouveaux clients sont ceux qui ont payé pour la première fois sur la période." },
  trials: { icon: "hourglass", seed: 5, title: () => "Essais en cours", explain: "Essais gratuits en cours, qui deviendront des abonnements s'ils sont convertis." },
  downloads: { icon: "download", seed: 6, title: () => "Téléchargements", explain: "Premiers téléchargements sur la période. En direct : chaque première ouverture de l'app (SDK MoneyMaker) compte tout de suite, puis les chiffres officiels d'Apple remplacent ces jours-là dès qu'ils sont publiés (sous 48 h)." },
};
const payingOf = o => o.payingCustomers ?? o.activeSubscriptions;
function metricRatio(k, o) {
  const paying = Math.max(payingOf(o), 1);
  const r = k === "paying" ? o.activeSubscriptions / paying
    : k === "trials" ? (o.projects.map(p => p.trialConversionRate).filter(v => v != null).sort((a, b) => b - a)[0] ?? o.activeTrials / (o.activeTrials + paying))
    : k === "downloads" ? (o.downloads > 0 ? sum(appsOf(o), p => p.newPayingCustomers ?? 0) / o.downloads : 0) : k === "subscriptions" ? o.activeSubscriptions / paying : .5;
  return Math.min(Math.max(r, .04), 1);
}
function metricTotal(k, o, t) { return { today: gross(t), mrr: o.mrrMicros, revenue: netOf(o), subscriptions: o.activeSubscriptions, paying: payingOf(o), trials: o.activeTrials, downloads: o.downloads }[k]; }
/** Téléchargements inconnus (null) : « — », jamais 0. */
const fmtMetric = (k, v, cur, compact = false) => v == null ? "—" : METRICS[k].money ? money(v, cur, compact) : int(v);
const DL_PENDING = "Les téléchargements arrivent sous 48 h après la connexion App Store Connect.";
function homeTile(k, o, t, i) {
  const m = METRICS[k], cur = o.currency, title = m.title(o), byDay = mergedByDay(o), href = `metric/${k}`;
  const base = { icon: m.icon, title, seed: m.seed, href, i };
  switch (k) {
    case "today": return wideTile({ ...base, value: money(gross(t), t?.currency ?? cur), sub: "", chart: vline((t?.hourly ?? [0, 0]).map(v => v / 1e6), { money: true }) });
    case "mrr": { let run = 0; return wideTile({ ...base, anchor: "bottomTrailing", value: money(o.mrrMicros, cur, true), chart: vline(dailySeries(byDay, 30).map(d => (run += d.v)), { money: true }) }); }
    case "revenue": return wideTile({ ...base, value: money(netOf(o), cur, true), sub: "", chart: vline(dailySeries(byDay, 14).map(d => d.v), { money: true }) });
    case "paying": return wideTile({ ...base, value: int(payingOf(o)), chart: vline(dailySeries(byDay, 30).map(d => d.v)) });
    default: return wideTile({ ...base, value: fmtMetric(k, metricTotal(k, o, t), cur), chart: sliderTrack(metricRatio(k, o)) });
  }
}
function extraStats(o, t) {
  const cur = o.currency, paying = Math.max(payingOf(o), 1), out = [];
  if (!(o.hasTrials ?? o.activeTrials > 0)) out.push(["hourglass", "Essais en cours", int(o.activeTrials), metricRatio("trials", o), "metric/trials"]);
  out.push(["people", "Abonnés actifs", int(o.activeSubscriptions), metricRatio("subscriptions", o), "metric/subscriptions"]);
  out.push(["calendar", "ARR", money(o.mrrMicros * 12, cur), .5]);
  if (o.activeSubscriptions > 0) out.push(["person", "Revenu par abonné", money(o.mrrMicros / o.activeSubscriptions, cur), .5]);
  const churn = avg(o.projects.map(p => p.churnRate).filter(v => v != null));
  if (churn != null) out.push(["undodown", "Désabonnement", `${(churn * 100).toLocaleString(MM_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`, churn]);
  const conv = avg(o.projects.map(p => p.trialConversionRate).filter(v => v != null));
  if (conv != null) out.push(["seal", "Conversion des essais", `${Math.round(conv * 100)} %`, conv]);
  const issues = sum(o.projects, p => p.billingIssues);
  out.push(["warning", "Problèmes de paiement", int(issues), issues / paying]);
  if (t) {
    out.push(["refresh", "Renouvellements aujourd'hui", int(t.renewals), .5], ["hourglass", "Essais démarrés aujourd'hui", int(t.trials), .5], ["sparkles", "Nouveaux abonnés aujourd'hui", int(t.newSubscribers), .5]);
    if (t.refundsMicros > 0) out.push(["undo", "Remboursements aujourd'hui", money(t.refundsMicros, t.currency), t.refundsMicros / Math.max(t.revenueMicros, 1)]);
  }
  return out;
}
const pctText = v => v == null ? "—" : `${Math.round(v * 100)} %`;
function posthogStats(s) {
  const rate = (a, b) => { const x = s.funnel?.find(f => f.step === a)?.users, y = s.funnel?.find(f => f.step === b)?.users; return x > 0 && y != null ? y / x : null; };
  const mau = s.mau || 0, out = [["doc", "Conversion paywall", pctText(s.paywallConversion), s.paywallConversion ?? 0], ["download", "Installation → payant", pctText(s.installToPaid), s.installToPaid ?? 0]];
  const onb = rate("open", "onboarding");
  if (onb != null) out.push(["list", "Onboarding terminé", pctText(onb), onb]);
  const more = [];
  for (const [icon, title, a, b] of [["logout", "Onboarding → paywall", "onboarding", "paywall"], ["hourglass", "Paywall → essai", "paywall", "trial"], ["card", "Essai → achat", "trial", "purchase"]]) { const r = rate(a, b); if (r != null) more.push([icon, title, pctText(r), r]); }
  if (s.newUsers != null) more.push(["sparkles", `Nouveaux utilisateurs · ${s.days} j`, int(s.newUsers), mau ? s.newUsers / mau : 0]);
  more.push(["person", "Utilisateurs actifs · jour", int(s.dau), mau ? s.dau / mau : 0], ["people", "Utilisateurs actifs · semaine", int(s.wau), mau ? s.wau / mau : 0], ["people", "Utilisateurs actifs · mois", int(mau), 1]);
  for (const [t, v] of [["Rétention J1", s.retentionD1], ["Rétention J7", s.retentionD7], ["Rétention J30", s.retentionD30]]) if (v != null) more.push(["undo", t, pctText(v), v]);
  return { head: out, more };
}
const extraTile = ([icon, title, value, ratio, href], i, seed = 8) => wideTile({ icon, title, value, chart: sliderTrack(Math.min(Math.max(ratio, .04), 1)), seed: seed + i, href, i: 0 });

export async function renderHome(main) {
  if (!h.state.projects.length) return renderWelcome(main);
  if (desktop()) return renderDeskHome(main);
  main.innerHTML = `<div class="page wide">
    <div class="home-head"><button class="iconbtn" id="hMenu" aria-label="Menu">${ic("menu", 22)}</button><img src="/logo.png" alt="MoneyMaker"><button class="iconbtn" id="hGear" aria-label="Réglages">${ic("gear", 20)}</button></div>
    <div class="desk-top"><div class="page-title desk-only">Accueil</div><div class="fan-row" id="fanRow"></div></div>
    <div class="tiles" id="tiles">${store.overview ? "" : skeleton(5)}</div>
    <div class="tiles" id="phTiles"></div>
    <button class="more-btn glass" id="moreBtn"></button>
    <div class="tiles" id="extras"></div>
    <div class="globe-sec" id="globeSec"></div>
    <p class="updated" id="updated"></p>
    <div id="bizSec" style="display:flex;flex-direction:column;gap:10px"></div>
    <div id="assistantBanner" class="card" style="display:none"></div>
    <div id="alertsSec"></div>
  </div>`;
  document.getElementById("hMenu").onclick = () => toggleMenu();
  document.getElementById("hGear").onclick = () => h.go({ view: "settings", projectId: null });
  let globe = null, selected = null, first = true;
  const paint = () => {
    const o = scopeOverview(store.overview), t = store.today;
    if (!o || !document.getElementById("tiles")) return;
    const fr = document.getElementById("fanRow");
    fr.innerHTML = fanRow(); bindFan(fr, paint);
    const keys = ["today", "mrr", "revenue", "paying", ...(o.hasTrials ?? o.activeTrials > 0 ? ["trials"] : []), ...(o.downloads != null ? ["downloads"] : [])].filter(k => k !== "today" || t);
    const tiles = document.getElementById("tiles");
    tiles.dataset.n = keys.length;
    tiles.innerHTML = keys.map((k, i) => homeTile(k, o, t, first ? i : 0)).join("");
    if (!first) tiles.querySelectorAll(".anim-in").forEach(e => e.classList.remove("anim-in"));
    const showMore = h.state.showMore;
    const more = document.getElementById("moreBtn");
    more.innerHTML = `${showMore ? "Masquer les données" : "Afficher plus de données"} ${ic(showMore ? "up" : "down", 11)}`;
    more.onclick = () => { h.state.showMore = !h.state.showMore; paint(); };
    const ex = document.getElementById("extras");
    ex.innerHTML = showMore ? extraStats(o, t).map((s, i) => extraTile(s, i)).join("") + (posthogExtra ?? "") : "";
    ex.style.display = showMore ? "" : "none";
    const u = document.getElementById("updated"); if (u) u.textContent = `Mis à jour ${ago(store.at || o.generatedAt)}`;
    paintBiz(o); bindTiles(main); hydrate(main);
    paintGlobe(o);
    first = false;
  };
  let posthogExtra = "";
  const paintPosthog = async () => {
    const ids = viewIds(), box = document.getElementById("phTiles");
    posthogExtra = "";
    if (box) box.innerHTML = "";
    if (ids.length !== 1 || !box) return;
    const { summary } = await h.api(`/v1/projects/${ids[0]}/posthog/summary`).catch(() => ({ summary: null }));
    if (!summary || viewIds()[0] !== ids[0] || !document.getElementById("phTiles")) return;
    const { head, more } = posthogStats(summary);
    box.innerHTML = head.map((s, i) => extraTile(s, i, 20)).join("");
    posthogExtra = more.map((s, i) => extraTile(s, i, 30)).join("");
    hydrate(box);
    if (h.state.showMore) paint();
  };
  const paintBiz = o => {
    const box = document.getElementById("bizSec");
    if (o.projects.length < 2) return box.innerHTML = "";
    box.innerHTML = `<div class="mlabel" style="padding:6px 4px 0"><span>Par business</span><span>${o.projects.length}</span></div><div class="tiles" style="gap:10px">${bizRows("mrr", o)}</div>`;
    box.querySelectorAll("[data-goproject]").forEach(b => b.onclick = () => h.openProject(b.dataset.goproject));
  };
  const paintGlobe = o => {
    const sec = document.getElementById("globeSec");
    const spots = globeSpots(o.projects, store.feed), cur = o.currency;
    const total = Math.max(spots.reduce((s, x) => s + x.value, 0), .0001), ranked = spots.filter(s => s.value >= .01).sort((a, b) => b.value - a.value);
    if (!sec.firstChild) sec.innerHTML = `<div class="globe-box"><div id="homeGlobe" style="position:absolute;inset:0"></div><div id="globePop"></div></div><div class="gl-side"><div class="mlabel" style="padding:0 4px"><span>Classement</span></div><div id="gRank"></div></div>`;
    const pop = () => {
      const s = spots.find(x => x.cc === selected), box = document.getElementById("globePop");
      if (box) box.innerHTML = s ? `<div class="globe-pop glass"><span style="font-size:22px">${flag(s.cc)}</span><div><b>${esc(h.countryName(s.cc))}</b><i>${Math.round(s.value / total * 100)} % du revenu</i></div><span class="v">${money(s.value * 1e6, cur)}</span></div>` : "";
    };
    const list = document.getElementById("gRank");
    list.innerHTML = `<div class="card flush" style="margin-top:12px">${ranked.slice(0, 20).map(s => `<button class="cr ${selected === s.cc ? "on" : ""}" data-cc="${s.cc}"><span class="fl">${flag(s.cc)}</span><span class="bd"><span class="ln"><b>${esc(h.countryName(s.cc))}</b><span>${money(s.value * 1e6, cur, true)}</span></span><span class="br" style="width:${Math.max(1, s.value / ranked[0].value * 100)}%"></span></span></button>`).join("") || `<p class="muted" style="padding:18px;margin:0">Tes premières ventes apparaîtront ici, pays par pays.</p>`}</div>`;
    list.querySelectorAll("[data-cc]").forEach(b => b.onclick = () => { selected = b.dataset.cc; globe?.setHighlight(selected); globe?.focus(selected); list.querySelectorAll("[data-cc]").forEach(x => x.classList.toggle("on", x === b)); pop(); });
    if (globe) globe.setSpots(spots);
    pop();
  };
  try {
    await ensureStore();
  } catch (e) { main.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; return; }
  if (!document.getElementById("tiles")) return;
  paint();
  paintPosthog();
  const o0 = scopeOverview(store.overview);
  mountGlobe(document.getElementById("homeGlobe"), { spots: globeSpots(o0.projects, store.feed), onTap: cc => h.go({ view: "planet", planetCC: cc ?? selected ?? null, projectId: null }) }).then(g => { if (!document.getElementById("homeGlobe")) return g.destroy(); globe = g; cleanups.push(() => g.destroy()); });
  h.onStoreChange = () => { paint(); paintPosthog(); };
  cleanups.push(() => { h.onStoreChange = null; });
  const banner = document.getElementById("assistantBanner");
  banner.style.display = "";
  h.assistantCard(banner, { banner: true }).catch(() => banner.remove());
  h.api("/v1/alerts").then(({ alerts }) => {
    const box = document.getElementById("alertsSec");
    if (box && alerts.length) box.innerHTML = `<div class="mlabel" style="padding:6px 4px 10px"><span>Dernières alertes App Store</span><span>${Math.min(alerts.length, 15)}</span></div><div class="card"><table>${alerts.slice(0, 15).map(h.alertRow).join("")}</table></div>`;
  }).catch(() => {});
  const tick = setInterval(() => { if (!document.hidden) refresh().then(() => h.onStoreChange?.()).catch(() => {}); }, 60000);
  cleanups.push(() => clearInterval(tick));
}
function bindTiles(root) { root.querySelectorAll("[data-href]").forEach(b => b.onclick = () => { const [view, k] = b.dataset.href.split("/"); h.go({ view, metric: k, projectId: null }); }); }
function renderWelcome(main) {
  main.innerHTML = `<div class="page"><div class="home-head"><button class="iconbtn" id="hMenu" aria-label="Menu">${ic("menu", 22)}</button><img src="/logo.png" alt="MoneyMaker"><button class="iconbtn" id="hGear" aria-label="Réglages">${ic("gear", 20)}</button></div>
    <h1 class="page-title" style="margin:0">Bienvenue</h1><p class="note" style="padding:0">Crée ton premier business pour obtenir tes clés API.</p>
    <div class="card"><button class="primary wide" id="first">Créer un business</button></div><div id="assistantBanner" class="card"></div></div>`;
  document.getElementById("first").onclick = h.newProjectDialog;
  document.getElementById("hMenu").onclick = () => toggleMenu();
  document.getElementById("hGear").onclick = () => h.go({ view: "settings", projectId: null });
  h.assistantCard(document.getElementById("assistantBanner"), { banner: true }).catch(() => document.getElementById("assistantBanner")?.remove());
}

function bizCaption(k, p) {
  const d = bizDetail(k, p), kind = KIND_LABEL[p.kind];
  return kind ? (d ? `${kind} · ${d}` : kind) : d;
}
function bizDetail(k, p) {
  switch (k) {
    case "mrr": case "subscriptions": return `${int(p.activeSubscriptions)} abonnés · ${int(p.activeTrials)} essais`;
    case "revenue": return `MRR ${money(p.mrrMicros, p.currency, true)}`;
    case "paying": return `${int(p.newCustomers)} nouveaux · ${int(p.billingIssues)} problèmes de paiement`;
    case "trials": return p.trialConversionRate != null ? `Conversion ${Math.round(p.trialConversionRate * 100)} %` : "Pas encore de conversion";
    case "downloads": return p.downloads == null ? DL_PENDING : (p.downloadsSource === "live" || p.downloadsSource === "mixed") ? "En direct" : "Chiffres Apple";
    default: return "";
  }
}
function bizValue(k, p) { return k === "downloads" ? p.downloads : { revenue: p.revenueMicros ?? p.netRevenueMicros, mrr: p.mrrMicros, subscriptions: p.activeSubscriptions, paying: p.payingCustomers ?? p.activeSubscriptions, trials: p.activeTrials }[k] ?? 0; }
function bizRows(k, o) {
  // Téléchargements : seulement les apps (un SaaS web n'en a pas).
  const rows = o.projects.filter(p => k !== "downloads" || isApp(p)).map(p => [p, bizValue(k, p)]).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1)), top = Math.max(rows[0]?.[1] ?? 1, 1);
  return rows.map(([p, v]) => `<button class="tile" data-goproject="${esc(p.projectId)}"><div class="biz-tile">
    <div class="top"><span style="position:relative;flex:none">${projectIcon(p, 36)}<span style="position:absolute;right:-4px;bottom:-4px">${platformMark(p.stores, 16)}</span></span><div class="nm"><b><bdi>${esc(p.name)}</bdi></b><i>${esc(bizCaption(k, p))}</i></div><span class="val">${fmtMetric(k, v, p.currency)}</span><span style="color:var(--ink3)">${ic("right", 11)}</span></div>
    ${sliderTrack(Math.min(Math.max((v ?? 0) / top, .04), 1), true)}</div></button>`).join("");
}

// ── Détail d'une carte (HomeMetricDetail) ───────────────────────────────────────────────
const RANGES = [["Semaine", 7], ["Mois", 30], ["3 mois", 90], ["Année", 365]];
const shortDay = t => new Date(t).toLocaleDateString(MM_LOCALE, { day: "numeric", month: "short" });
const longDay = t => new Date(t).toLocaleDateString(MM_LOCALE, { weekday: "long", day: "numeric", month: "long" });
const isToday = t => new Date(t).toDateString() === new Date().toDateString();
export async function renderMetric(main) {
  const k = METRICS[h.state.metric] ? h.state.metric : "mrr", m = METRICS[k];
  main.innerHTML = `<div class="page"><div class="skeleton" style="height:44px;width:44px;border-radius:50%"></div>${skeleton(1, 320)}</div>`;
  const n = nav;
  await ensureStore();
  if (n !== nav) return;
  let range = h.state.metricRange ?? 30, selected = null;
  const paint = () => {
    const o = scopeOverview(store.overview), t = store.today, cur = o.currency;
    const ids = viewIds();
    const byDay = range > 30 && store.long ? mergedByDay({ projects: store.long.projects.filter(p => ids.includes(p.projectId)) }) : mergedByDay(o);
    // Téléchargements : vraie série par jour (downloadsByDay). Les autres cartes tracent les ventes du jour (montants).
    const dlByDay = () => { const acc = {}; for (const p of (range > 30 && store.long ? store.long.projects.filter(p => ids.includes(p.projectId)) : o.projects)) for (const [d, v] of Object.entries(p.downloadsByDay ?? {})) acc[d] = (acc[d] ?? 0) + v; return acc; };
    const daily = dailySeries(k === "downloads" ? dlByDay() : byDay, range), seriesMoney = k !== "downloads";
    let pts;
    if (k === "today") { const start = t?.dayStart ?? Date.now(), hr = t?.hourly ?? []; pts = hr.map((v, i) => ({ t: start + i * 36e5, v: v / 1e6 })); }
    else if (k === "mrr") { let run = 0; pts = daily.map(d => ({ t: d.t, v: (run += d.v), day: d.v })); }
    else pts = daily;
    const total = pts.reduce((s, p) => s + p.v, 0);
    const headline = () => k === "revenue" ? money(total * 1e6, cur) : fmtMetric(k, metricTotal(k, o, t), cur);
    const subtitle = () => {
      if (k === "today") return "Cumul depuis minuit";
      if (k === "downloads" && o.downloads == null) return DL_PENDING;
      if (k === "downloads" && o.downloadsLive) return `En direct · ${int(t?.installs ?? 0)} aujourd'hui`;
      if (k === "mrr") return `${int(o.activeSubscriptions)} abonnés actifs · ARR ${money(o.mrrMicros * 12, cur, true)}`;
      const label = RANGES.find(r => r[1] === range)[0].toLowerCase();
      if (["paying", "subscriptions", "trials"].includes(k)) return `Encaissé sur ${label} : ${money(total * 1e6, cur)}`;
      const d = halfOverHalf(pts.map(p => p.v));
      return d == null ? `Sur ${range} jours` : `${d >= 0 ? "+" : ""}${Math.round(d * 100)} % sur la seconde moitié · ${range} jours`;
    };
    const fanHtml = fanRow();
    main.querySelector(".page")?.remove();
    main.innerHTML = `<div class="page">
      <div class="dt-top"><button class="back glass" id="dtBack" aria-label="Retour">${ic("left", 19)}</button>${k === "today" ? "" : `<div class="range glass">${RANGES.map(([l, d]) => `<button class="${d === range ? "on" : ""}" data-range="${d}">${l}</button>`).join("")}</div>`}</div>
      <div class="dt-grid"><div class="dt-left"><div class="fan-row" id="dtFan">${fanHtml}</div>
      <div class="dt-hero"><canvas class="dots" data-anchor="topTrailing" data-seed="${m.seed}" data-reach=".9"></canvas>
        ${tileHead(m.icon, m.title(o))}<div class="v" id="dtV">${headline()}</div><div class="s" id="dtS">${subtitle()}</div>
        ${neon(pts.map(p => p.v), { money: seriesMoney })}
        <div class="axis"><span>${pts[0] ? (k === "today" ? new Date(pts[0].t).toLocaleTimeString(MM_LOCALE, { hour: "numeric" }) : shortDay(pts[0].t)) : ""}</span><span>${k === "today" ? "Maintenant" : "Aujourd'hui"}</span></div></div>
      ${k === "today" ? "" : `<div class="chips-days" id="dtDays">${pts.map((p, i) => `<button data-i="${i}"><em>${isToday(p.t) ? "Aujourd'hui" : shortDay(p.t)}</em><b>${seriesMoney ? money((k === "mrr" ? p.day : p.v) * 1e6, cur, true) : int(p.v)}</b></button>`).join("")}</div>`}
      </div><div class="dt-right"><div class="stats2">${detailStats(k, o, t, pts, range).map(([tt, v, i]) => `<div class="tile mini static"><div class="h">${ic(i, 11)}<span>${esc(tt)}</span></div><div class="val">${esc(v)}</div></div>`).join("")}</div>
      <p class="note">${esc(m.explain)}</p></div></div>
      ${o.projects.length && k !== "today" ? `<div class="mlabel" style="padding:6px 4px 0"><span>Par business</span><span>${o.projects.length}</span></div><div class="tiles">${bizRows(k, o)}</div>` : ""}
    </div>`;
    document.getElementById("dtBack").onclick = () => h.back();
    main.querySelectorAll("[data-range]").forEach(b => b.onclick = async () => { range = Number(b.dataset.range); h.state.metricRange = range; selected = null; if (range > 30) await loadLong().catch(() => {}); if (h.state.view === "metric") paint(); });
    main.querySelectorAll("[data-goproject]").forEach(b => b.onclick = () => h.openProject(b.dataset.goproject));
    bindFan(document.getElementById("dtFan"), paint);
    hydrate(main);
    const nv = main.querySelector(".neon"), vEl = document.getElementById("dtV"), sEl = document.getElementById("dtS");
    const select = i => {
      selected = i;
      const sel = nv.querySelector(".sel"), end = nv.querySelector(".endp"), np = nv._pts;
      if (i == null || !np) { if (sel) sel.style.display = "none"; if (end) end.style.display = ""; vEl.textContent = headline(); sEl.textContent = subtitle(); main.querySelectorAll("#dtDays .on").forEach(e => e.classList.remove("on")); return; }
      const [x, y] = np[i], p = pts[i];
      if (sel) { sel.style.display = ""; sel.querySelector("line").setAttribute("x1", x); sel.querySelector("line").setAttribute("x2", x); const c = sel.querySelector("circle"); c.setAttribute("cx", x); c.setAttribute("cy", y); }
      if (end) end.style.display = "none";
      const val = k === "mrr" ? p.day : p.v;
      // Cartes en nombre (abonnés, essais, payants) : le point choisi est l'encaissé du jour, affiché comme tel.
      vEl.textContent = seriesMoney ? money(val * 1e6, cur) : int(val);
      sEl.textContent = k === "today" ? new Date(p.t).toLocaleTimeString(MM_LOCALE, { hour: "numeric", minute: "2-digit" }) : m.money || !seriesMoney ? longDay(p.t) : `${longDay(p.t)} · encaissé`;
      main.querySelectorAll("#dtDays button").forEach(b => { const on = Number(b.dataset.i) === i; b.classList.toggle("on", on); if (on) b.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }); });
    };
    const fromEvent = e => { const r = nv.getBoundingClientRect(); return Math.max(0, Math.min(pts.length - 1, Math.round((e.clientX - r.left) / r.width * (pts.length - 1)))); };
    nv.addEventListener("pointermove", e => { if (pts.length > 1) select(fromEvent(e)); });
    nv.addEventListener("pointerdown", e => { if (pts.length > 1) select(fromEvent(e)); });
    nv.addEventListener("pointerleave", () => select(null));
    main.querySelectorAll("#dtDays button").forEach(b => b.onclick = () => { const i = Number(b.dataset.i); select(selected === i ? null : i); });
    const strip = document.getElementById("dtDays"); if (strip) strip.scrollLeft = strip.scrollWidth;
  };
  if (range > 30) await loadLong().catch(() => {});
  paint();
  loadLong().catch(() => {});
}
function detailStats(k, o, t, pts, range) {
  const cur = o.currency, s = pts.reduce((a, p) => a + p.v, 0), active = pts.filter(p => p.v > 0).length, best = Math.max(0, ...pts.map(p => p.v)), paying = payingOf(o);
  const since = Date.now() - range * 864e5, ids = viewIds(), inRange = store.feed.filter(e => e.at >= since && ids.includes(e.projectId));
  const count = (...types) => inRange.filter(e => types.includes(e.type)).length;
  const rates = o.projects.map(p => p.trialConversionRate).filter(v => v != null), churns = o.projects.map(p => p.churnRate).filter(v => v != null);
  const pct = v => `${Math.round(v * 100)} %`;
  switch (k) {
    case "today": return t ? [["Ventes", int(t.sales), "cart"], ["Renouvellements", int(t.renewals), "refresh"], ["Nouveaux abonnés", int(t.newSubscribers), "sparkles"], ["Essais démarrés", int(t.trials), "hourglass"], ["Remboursements", money(t.refundsMicros, t.currency), "undo"], ["Transactions", int(t.sales + t.renewals), "list"]] : [];
    case "mrr": case "subscriptions": { const out = [["Abonnés actifs", int(o.activeSubscriptions), "people"], ["ARR", money(o.mrrMicros * 12, cur, true), "calendar"], ["Revenu par abonné", money(o.mrrMicros / Math.max(o.renewingSubscriptions ?? o.activeSubscriptions, 1), cur), "person"], ["Essais en cours", int(o.activeTrials), "hourglass"], ["Renouvellements", int(count("RENEWAL")), "refresh"], ["Annulations", int(count("CANCELLATION")), "xcircle"]]; if (churns.length) out.push(["Désabonnement", pct(avg(churns)), "undodown"]); if (rates.length) out.push(["Conversion essais", pct(avg(rates)), "seal"]); return out; }
    case "revenue": return [["Total", money(s * 1e6, cur), "euro"], ["Moyenne / jour", money(s / Math.max(pts.length, 1) * 1e6, cur), "divide"], ["Meilleur jour", money(best * 1e6, cur), "trophy"], ["Jours avec vente", `${active}/${pts.length}`, "calendar"], ["Ventes", int(inRange.filter(isRevenueEvent).length), "cart"], ["Remboursements", int(inRange.filter(isRefundEvent).length), "undo"]];
    case "paying": return [["Utilisateurs payants", int(paying), "card"], ["Abonnés actifs", int(o.activeSubscriptions), "people"], ["Achats uniques", int(Math.max(paying - o.activeSubscriptions, 0)), "bag"], ["Nouveaux clients", int(o.newCustomers), "sparkles"], ["Problèmes de paiement", int(sum(o.projects, p => p.billingIssues)), "warning"], ["Revenu par client", money(s * 1e6 / Math.max(paying, 1), cur), "person"]];
    case "trials": { const out = [["Essais en cours", int(o.activeTrials), "hourglass"], ["Essais démarrés", int(count("TRIAL_STARTED")), "playc"], ["Essais convertis", int(count("TRIAL_CONVERTED")), "checkc"]]; if (rates.length) out.push(["Conversion", pct(avg(rates)), "seal"]); return out; }
    case "downloads": {
      // Uniquement les apps : un client Stripe d'un SaaS web n'a rien téléchargé.
      const d = o.downloads ?? 0, apps = appsOf(o), nc = sum(apps, p => p.newPayingCustomers ?? 0), rev = sum(apps, p => p.netRevenueMicros ?? 0);
      if (o.downloads == null) return [["Téléchargements", "—", "download"], ["Nouveaux payants", int(nc), "sparkles"]];
      return [["Téléchargements", int(d), "download"], ["Nouveaux payants", int(nc), "sparkles"], ["Téléchargement → payant", d > 0 ? pct(nc / d) : "—", "ext"], ["Revenu par téléchargement", d > 0 ? money(rev / d, cur) : "—", "euro"]];
    }
    default: return [];
  }
}

// ── Ventes en direct (FeedScreen) ───────────────────────────────────────────────────────
const amountOf = e => (e.priceMicros ?? 0) > 0 || e.displayMicros ? money(e.displayMicros ?? e.priceMicros, e.displayCurrency ?? e.currency) : null;
/** Montant dans la devise d'affichage `cur`, ou null si la conversion manque (jamais d'addition de devises différentes). */
const inCur = (e, cur) => (e.displayCurrency ?? e.currency) === cur ? (e.displayMicros ?? e.priceMicros ?? 0) : null;
/** Couleur d'un montant : rouge pour un remboursement, gris pour un événement qui n'est pas une vente (annulation, demande de remboursement…). */
const amountColor = e => isRefundEvent(e) ? "var(--red)" : isRevenueEvent(e) ? "var(--ink)" : "var(--ink3)";
const projectOf = id => (store.overview?.projects ?? []).find(p => p.projectId === id);
const timeOf = e => { const recent = Date.now() - e.at < 2 * 864e5, d = new Date(e.at), hm = d.toLocaleTimeString(MM_LOCALE, { hour: "2-digit", minute: "2-digit", timeZone: tz() }); return recent ? hm : `${d.toLocaleDateString(MM_LOCALE, { day: "numeric", month: "short", timeZone: tz() })} ${hm}`; };
function feedRow(e) {
  const b = eventBadge(e), amt = amountOf(e), p = projectOf(e.projectId);
  return `<button class="fi" data-event="${esc(e.id)}"><span class="ic">${p ? projectIcon(p, 42) : projectIcon({ projectId: e.projectId, name: e.projectName }, 42)}${e.country ? `<span class="fl">${flag(e.country)}</span>` : ""}</span>
    <span class="tx"><b><bdi>${esc(productLabel(e) ?? e.projectName ?? e.type)}</bdi></b><i>${esc([timeOf(e), storeLabel(e.store)].filter(Boolean).join(" · "))}</i></span>
    <span class="am"><b style="color:${amt ? amountColor(e) : "var(--ink3)"}">${amt ?? (b.free ? "Gratuit" : "")}</b>${e.isSandbox ? tbadge({ label: "Test", color: "255,255,255", grey: true }) : ""}${tbadge(b)}</span></button>`;
}
const dayTitle = t => { const d = new Date(t), y = new Date(Date.now() - 864e5); return isToday(t) ? "Aujourd'hui" : d.toDateString() === y.toDateString() ? "Hier" : d.toLocaleDateString(MM_LOCALE, { weekday: "long", day: "numeric", month: "long" }).replace(/^./, c => c.toUpperCase()); };
function scopeLabel() { const ids = viewIds(), all = allProjects(); return ids.length === all.length ? "Tous les business" : ids.length === 1 ? projectOf(ids[0])?.name ?? "" : `${ids.length} business`; }
export async function renderFeed(main) {
  main.innerHTML = `<div class="page"><div><div class="page-title">Ventes en direct</div><div class="page-sub" id="feedScope"></div></div><div class="feed-grid"><div id="feedBody" style="display:flex;flex-direction:column;gap:10px;min-width:0">${skeleton(1, 420)}</div><aside class="feed-pane" id="feedPane"></aside></div></div>`;
  await ensureStore(0).catch(() => {});
  const cur = store.overview?.currency;
  let current = null;
  const openPane = async e => {
    current = e;
    document.querySelectorAll("#feedBody .fi.on").forEach(r => r.classList.remove("on"));
    document.querySelector(`#feedBody [data-event="${CSS.escape(e.id)}"]`)?.classList.add("on");
    const pane = document.getElementById("feedPane");
    if (load("mmOpenAs") === "customer" && e.appUserId) {
      const ref = { projectId: e.projectId, appUserId: e.appUserId };
      pane.innerHTML = `<div style="padding:16px;display:flex;flex-direction:column;gap:14px">${skeleton(3, 90)}</div>`;
      const html = await customerBody(ref).catch(err => `<div class="empty error">${esc(err.message)}</div>`);
      if (current !== e) return;
      pane.innerHTML = `<div style="padding:16px;display:flex;flex-direction:column;gap:14px">${html}</div>`;
      bindCustomer(pane, ref);
      return;
    }
    pane.innerHTML = `<div class="tx-glow"><span>${flag(e.country ?? "")}</span></div><div style="position:relative;padding:8px 16px 16px;display:flex;flex-direction:column;gap:14px">${txBody(e)}</div>`;
    bindTx(pane, e);
  };
  const paint = () => {
    const box = document.getElementById("feedBody");
    if (!box) return;
    document.getElementById("feedScope").textContent = scopeLabel();
    const ids = viewIds(), list = store.feed.filter(e => ids.includes(e.projectId));
    if (!list.length) { box.innerHTML = `<div class="card"><p class="muted" style="margin:0">Tes ventes apparaîtront ici en direct, dès la première.</p></div>`; return; }
    const groups = [];
    for (const e of list) { const key = new Date(e.at).toLocaleDateString(MM_LOCALE, { timeZone: tz() }); let g = groups.find(x => x.key === key); if (!g) groups.push(g = { key, at: e.at, items: [] }); g.items.push(e); }
    box.innerHTML = groups.map(g => {
      // Ventes brutes du jour (hors achats de test), converties dans la devise d'affichage ; remboursements à part.
      const live = g.items.filter(e => !e.isSandbox);
      const sales = live.filter(isRevenueEvent).reduce((s, e) => s + (inCur(e, cur) ?? 0), 0);
      const refunds = live.filter(isRefundEvent).reduce((s, e) => s + Math.abs(inCur(e, cur) ?? 0), 0);
      return `<div class="day-head"><span>${esc(dayTitle(g.at))}</span><b>${money(sales - refunds, cur)}</b></div><div class="card flush" style="overflow:hidden">${g.items.map(feedRow).join("")}</div>`;
    }).join("");
    box.querySelectorAll("[data-event]").forEach(b => b.onclick = () => {
      const e = store.feed.find(x => x.id === b.dataset.event);
      if (!e) return;
      if (desktop()) return openPane(e);
      if (load("mmOpenAs") === "customer" && e.appUserId) h.go({ view: "customer", customer: { projectId: e.projectId, appUserId: e.appUserId }, projectId: null });
      else h.go({ view: "tx", event: e, eventRef: { projectId: e.projectId, id: e.id }, projectId: null });
    });
  };
  const sync = () => { paint(); if (!desktop()) return; const ids = viewIds(), list = store.feed.filter(e => ids.includes(e.projectId)), keep = current && list.find(e => e.id === current.id); if (keep) openPane(keep); else if (list[0]) openPane(list[0]); else document.getElementById("feedPane").innerHTML = ""; };
  sync();
  h.onStoreChange = sync;
  cleanups.push(() => { h.onStoreChange = null; });
  const tick = setInterval(() => { if (!document.hidden) refresh().then(sync).catch(() => {}); }, 30000);
  cleanups.push(() => clearInterval(tick));
}

// ── Fiche d'une vente (TransactionDetailView) ───────────────────────────────────────────
const sec = rows => `<div class="tx-sec">${rows.join("")}</div>`;
const txRow = (i, k, v) => `<div class="tx-row"><span class="i">${ic(i, 18)}</span><span class="k">${esc(k)}</span><span class="val">${v}</span></div>`;
const txStack = (i, k, v, mono) => `<div class="tx-row stack"><span class="i">${ic(i, 18)}</span><div class="b"><div class="k">${esc(k)}</div><div class="k2" ${mono ? 'style="font-family:var(--mono)"' : ""}>${esc(v)}</div></div></div>`;
const masked = id => id.length > 10 ? `${id.slice(0, 4)}••••${id.slice(-4)}` : id;
export async function renderTx(main) {
  const n = nav;
  await ensureStore().catch(() => {});
  if (n !== nav) return;
  const ref = h.state.eventRef;
  const e = ref && h.state.event?.id !== ref.id ? store.feed.find(x => x.id === ref.id && x.projectId === ref.projectId) ?? (await h.api(withQ("/v1/feed?limit=300", dispQ())).catch(() => ({ events: [] }))).events.find(x => x.id === ref.id && x.projectId === ref.projectId) : h.state.event;
  if (!e) return h.go({ view: "feed" });
  h.state.event = e; h.state.eventRef = { projectId: e.projectId, id: e.id };
  main.innerHTML = `<div class="tx-glow"><span>${flag(e.country ?? "")}</span></div><div class="page tx-page" style="position:relative">
    <div class="dt-top"><button class="back glass" id="txBack" aria-label="Retour">${ic("left", 19)}</button></div>${txBody(e)}</div>`;
  document.getElementById("txBack").onclick = () => h.back();
  bindTx(main, e);
}
function txBody(e) {
  const p = projectOf(e.projectId), b = eventBadge(e), exp = e.expiresAt, m = e.periodMonths;
  return `<div class="tx-hero">${projectIcon(p ?? { projectId: e.projectId, name: e.projectName }, 110)}<span class="fl">${flag(e.country ?? "")}</span></div>
    ${sec([(productLabel(e) ?? "").length > 22 ? txStack("square", "Produit", productLabel(e)) : txRow("square", "Produit", esc(productLabel(e) ?? "—")), ...(e.productName && e.productId && e.productName !== e.productId ? [txStack("hash", "Identifiant produit", e.productId, true)] : []), txRow("dollar", "Revenu", esc(amountOf(e) ?? (b.free ? "Gratuit" : "—"))),
      ...(e.appUserId ? [`<div class="tx-row link" data-customer><span class="i">${ic("person", 18)}</span><div style="flex:1;min-width:0"><div class="k">Client</div><div class="k2" style="font-size:14px;color:var(--ink3);margin-top:3px">${esc(masked(e.appUserId))}</div></div><span style="color:var(--ink3)">${ic("right", 13)}</span></div>`] : [])])}
    ${sec([txRow("calendar", "Date", esc(new Date(e.at).toLocaleString(MM_LOCALE, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz() }))), txRow("globe", "Pays", e.country ? `${flag(e.country)} ${esc(h.countryName(e.country))}` : "Inconnu"), txRow("store", "Boutique", esc(storeLabel(e.store) ?? "—")), `<div class="tx-row"><span class="i">${ic("tag", 18)}</span><span class="k">Type</span><span class="val">${tbadge(b)}</span></div>`,
      ...(exp ? [txRow("clock", exp > Date.now() ? "Expire le" : "Expiré le", esc(new Date(exp).toLocaleDateString(MM_LOCALE, { day: "numeric", month: "short", year: "numeric" })))] : []),
      ...(m > 0 ? [txRow("renew", "Période", m < 1 ? "Semaine" : m === 1 ? "Mois" : m === 12 ? "Année" : `${Math.round(m)} mois`)] : []), ...(e.isSandbox ? [txRow("hammer", "Environnement", "Test (sandbox)")] : [])])}
    ${sec([txStack("hash", "Transaction", e.purchaseId ?? e.id, true), txRow("grid", "Projet", esc(e.projectName ?? p?.name ?? "—"))])}`;
}
function bindTx(root, e) {
  const c = root.querySelector("[data-customer]");
  if (c) c.onclick = () => h.go({ view: "customer", customer: { projectId: e.projectId, appUserId: e.appUserId }, projectId: null });
}

const PURCHASE_STATUS = { expired: "Expiré", grace: "Période de grâce", billing_retry: "Relance de paiement", paused: "En pause", refunded: "Remboursé", revoked: "Révoqué", cancelled: "Annulé", active: "Actif" };
// ── Historique d'un client (CustomerHistoryView) ────────────────────────────────────────
export async function renderCustomer(main) {
  const r = h.state.customer;
  if (!r) return h.go({ view: "feed" });
  main.innerHTML = `<div class="page"><div class="dt-top"><button class="back glass" id="cBack" aria-label="Retour">${ic("left", 19)}</button></div>${skeleton(3, 120)}</div>`;
  document.getElementById("cBack").onclick = () => h.back();
  const n = nav;
  await ensureStore().catch(() => {});
  const body = await customerBody(r);
  if (n !== nav) return;
  main.innerHTML = `<div class="page"><div class="dt-top"><button class="back glass" id="cBack" aria-label="Retour">${ic("left", 19)}</button></div><div class="cu-grid">${body}</div></div>`;
  document.getElementById("cBack").onclick = () => h.back();
  bindCustomer(main, r);
}
function bindCustomer(root, r) { root.querySelector("[data-admin]").onclick = () => { h.state.openCustomer = r.appUserId; h.go({ view: "project", projectId: r.projectId, tab: "customers" }); }; }
async function customerBody(r) {
  const c = await h.api(`/v1/projects/${r.projectId}/customers/${encodeURIComponent(r.appUserId)}`);
  // Champs réellement renvoyés par l'API (GET /v1/projects/:pid/customers/:id) : purchases[].purchasedAt / expiresAt / isTrial / isSandbox,
  // country, firstSeenAt, lastSeenAt, totalSpentMicros (dans la devise du business, achats de test exclus) et currency.
  const p = projectOf(r.projectId), events = [...(c.events ?? [])].sort((a, b) => b.at - a.at);
  const purchases = [...(c.purchases ?? [])].sort((a, b) => (b.purchasedAt ?? 0) - (a.purchasedAt ?? 0));
  const active = Object.values(c.entitlements ?? {}).some(e => e.active) || purchases.some(x => x.active ?? x.status === "active");
  const first = c.firstSeenAt ?? events.at(-1)?.at, last = c.lastSeenAt ?? events[0]?.at, country = c.country ?? events.find(x => x.country)?.country;
  const cur = c.currency ?? p?.sourceCurrency ?? p?.currency ?? "EUR";
  // Prix d'un achat : dernière vente enregistrée pour cet achat (l'achat lui-même ne porte pas de prix dans la réponse).
  const priceOf = x => events.find(e => e.purchaseId === x.id && isRevenueEvent(e)) ?? null;
  const cells = [["Dépensé", money(c.totalSpentMicros ?? 0, cur), "euro"], ["Achats", int(purchases.length), "bag"], ["Vu la première fois", first ? shortDay(first) : "—", "calendar"], ["Vu la dernière fois", last ? shortDay(last) : "—", "clock"]];
  const dotColor = t => ({ RENEWAL: "var(--accent)", INITIAL_PURCHASE: "var(--accent)", TRIAL_CONVERTED: "var(--accent)", NON_RENEWING_PURCHASE: "var(--accent)", UNCANCELLATION: "var(--accent)", BILLING_RECOVERED: "var(--accent)", REFUND_REVERSED: "var(--accent)", TRIAL_STARTED: "var(--blue)", PRODUCT_CHANGE: "var(--blue)", REFUND_DECLINED: "var(--blue)", CANCELLATION: "var(--orange)", BILLING_ISSUE: "var(--orange)", REFUND_REQUESTED: "var(--orange)", REFUND: "var(--red)", REVOKED: "var(--red)" }[t] ?? "var(--ink3)");
  return `<div class="cu-col"><div class="card"><div style="display:flex;align-items:center;gap:14px">${p ? projectIcon(p, 56) : ""}<div style="flex:1;min-width:0"><div style="font-size:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis">${country ? `${flag(country)} ` : ""}${esc(masked(r.appUserId))}</div><div class="page-sub"><bdi>${esc(p?.name ?? "")}</bdi></div></div>${tbadge(active ? { label: "Actif", color: "51,217,128" } : { label: "Inactif", color: "255,255,255", grey: true })}</div></div>
    <div class="grid2" style="grid-template-columns:1fr 1fr">${cells.map(([t, v, i]) => `<div style="background:rgba(255,255,255,.05);border-radius:16px;padding:14px"><div class="mini"  style="padding:0"><div class="h">${ic(i, 11)}<span>${esc(t)}</span></div><div class="val">${esc(v)}</div></div></div>`).join("")}</div>
    <div class="mlabel" style="padding:6px 4px 0"><span>Achats</span><span>${purchases.length}</span></div>
    <div class="card flush" style="overflow:hidden">${purchases.map(x => { const sale = priceOf(x); return `<div class="fi" style="cursor:default"><span class="tx"><b><bdi>${esc(productLabel(sale ?? x) ?? x.productId)}</bdi></b><i>${esc([storeLabel(x.store), x.purchasedAt ? shortDay(x.purchasedAt) : null, x.expiresAt ? `jusqu'au ${shortDay(x.expiresAt)}` : "à vie", x.isTrial ? "essai" : null].filter(Boolean).join(" · "))}</i></span><span class="am"><b>${sale ? esc(amountOf(sale) ?? "") : ""}</b>${x.isSandbox ? tbadge({ label: "Test", color: "255,255,255", grey: true }) : ""}${tbadge((x.active ?? x.status === "active") ? { label: "Actif", color: "51,217,128" } : { label: PURCHASE_STATUS[x.status] ?? String(x.status ?? "—"), color: "255,255,255", grey: true })}</span></div>`; }).join("") || `<p class="muted" style="padding:18px;margin:0">Aucun achat.</p>`}</div></div>
    <div class="cu-col"><div class="mlabel" style="padding:6px 4px 0"><span>Historique</span><span>${events.length}</span></div>
    <div class="card">${events.slice(0, 60).map((e, i, all) => `<div style="display:flex;gap:12px"><div style="display:flex;flex-direction:column;align-items:center;width:8px;flex:none"><i style="width:8px;height:8px;border-radius:50%;background:${dotColor(e.type)};box-shadow:0 0 8px ${dotColor(e.type)};margin-top:6px"></i>${i < all.length - 1 ? `<i style="flex:1;width:1px;background:var(--hair);margin-top:3px"></i>` : ""}</div><div style="flex:1;min-width:0;padding-bottom:14px;display:flex;justify-content:space-between;gap:10px"><div style="min-width:0"><div style="font-size:14px;font-weight:500">${esc(eventBadge(e).label)}</div><div class="page-sub" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(productLabel(e) ?? "")}${e.isSandbox ? " · test" : ""}</div></div><div class="page-sub" style="font-size:12px;white-space:nowrap">${esc(new Date(e.at).toLocaleString(MM_LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</div></div></div>`).join("") || `<p class="muted" style="margin:0">Rien pour l'instant.</p>`}</div>
    <button class="ghost small" data-admin type="button" style="align-self:center">Gérer les accès</button></div>`;
}

// ── Apps (AppsScreen) ───────────────────────────────────────────────────────────────────
const appLogo = (a, s) => a.icon ? `<img class="applogo" src="${esc(a.icon)}" alt="" style="width:${s}px;height:${s}px;border-radius:${s * .2237}px" onerror="this.removeAttribute('src')">` : `<span class="applogo" style="display:block;width:${s}px;height:${s}px;border-radius:${s * .2237}px"></span>`;
function appRow(a) {
  const n = a.ratingCount ?? 0;
  return `<button class="card app-row" data-app="${esc(a.appId)}">${appLogo(a, 52)}<span class="tx"><b><bdi>${esc(a.name)}</bdi></b>
    ${a.rating != null ? `<i>${stars(a.rating)}${a.rating.toLocaleString(MM_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} · ${int(n)}</i>` : `<i>Pas encore de notes</i>`}
    ${a.countriesRanked > 0 ? `<u>Classée dans ${a.countriesRanked} pays</u>` : ""}</span>
    ${a.bestRank ? `<span class="rank">#${a.bestRank}</span>` : ""}<span style="color:var(--ink3)">${ic("right", 12)}</span></button>`;
}
export async function renderApps(main) {
  main.innerHTML = `<div class="page"><div class="apps-head"><div class="page-title">Mes apps</div>
    <div class="search-row"><label class="search glass">${ic("search", 15)}<input id="appQ" placeholder="Chercher une app de l'App Store" autocomplete="off"><button class="plain hidden" id="appX" type="button" aria-label="Effacer">${ic("xc", 16)}</button></label><button class="plain hidden" id="appCancel" style="font-size:15px">Annuler</button></div></div>
    <div id="appsBody" class="apps-body">${skeleton(3, 88)}</div></div>`;
  await ensureStore().catch(() => {});
  const body = document.getElementById("appsBody"), q = document.getElementById("appQ");
  let own = [], results = [], recents = load("mmRecentApps") ?? [], timer;
  const remember = a => { recents = [a, ...recents.filter(x => x.appId !== a.appId)].slice(0, 8); save("mmRecentApps", recents); };
  const openApp = a => { h.go({ view: "app", appItem: a, projectId: null }); };
  const bindRows = list => body.querySelectorAll("[data-app]").forEach(b => b.onclick = () => { const a = list.find(x => x.appId === b.dataset.app); if (!a) return; if (results.includes(a)) remember(a); openApp(a); });
  const paintHome = () => {
    if (document.activeElement === q && !q.value.trim()) {
      const ownOnly = own, rec = recents;
      body.innerHTML = `${ownOnly.length ? `<div><div class="sec-title">Mes apps</div>${ownOnly.map(a => `<button class="compact" data-app="${esc(a.appId)}">${appLogo(a, 38)}<span><bdi>${esc(a.name)}</bdi></span></button>`).join("")}</div>` : ""}
        ${rec.length ? `<div style="margin-top:10px"><div style="display:flex;justify-content:space-between"><div class="sec-title">Recherches récentes</div><button class="plain" id="clrRec" style="font-size:13px;color:var(--ink3)">Effacer</button></div>${rec.map(a => `<button class="compact" data-app="${esc(a.appId)}">${appLogo(a, 38)}<span><bdi>${esc(a.name)}</bdi></span></button>`).join("")}</div>` : ""}`;
      bindRows([...ownOnly, ...rec]);
      body.querySelectorAll("[data-app]").forEach(b => b.onmousedown = e => e.preventDefault());
      const clr = document.getElementById("clrRec");
      if (clr) { clr.onmousedown = e => e.preventDefault(); clr.onclick = () => { recents = []; save("mmRecentApps", []); paintHome(); }; }
      return;
    }
    const untracked = (store.overview?.projects ?? []).filter(p => !own.some(a => a.projectId === p.projectId));
    body.innerHTML = own.map(appRow).join("") + untracked.map(p => `<div class="card app-row" style="cursor:default">${projectIcon(p, 52)}<span class="tx"><b><bdi>${esc(p.name)}</bdi></b><i>Aucune app App Store suivie</i></span><button class="small" data-track="${esc(p.projectId)}" style="flex:none">Ajouter</button></div>`).join("");
    bindRows(own);
    body.querySelectorAll("[data-track]").forEach(b => b.onclick = () => h.go({ view: "project", projectId: b.dataset.track, tab: "appstore" }));
  };
  const sync = () => { const s = document.activeElement === q || q.value.trim(); document.getElementById("appCancel").classList.toggle("hidden", !s); document.getElementById("appX").classList.toggle("hidden", !q.value); };
  q.onfocus = () => { sync(); if (!q.value.trim()) paintHome(); };
  q.onblur = () => setTimeout(() => { sync(); if (!q.value.trim() && document.getElementById("appsBody")) paintHome(); }, 80);
  q.oninput = () => {
    sync(); clearTimeout(timer);
    const term = q.value.trim();
    if (!term) { results = []; return paintHome(); }
    timer = setTimeout(async () => {
      if (!results.length) body.innerHTML = `<div class="skeleton" style="height:88px"></div>`;
      const r = await h.api(`/v1/appstore/search?term=${encodeURIComponent(term)}&country=${MM_LANG === "fr" ? "fr" : "us"}`).catch(() => ({ results: [] }));
      if (q.value.trim() !== term) return;
      results = (r.results ?? []).map(a => ({ ...a, appId: String(a.appId) }));
      body.innerHTML = results.map(appRow).join("") || `<div class="card"><p class="muted" style="margin:0">Aucune app trouvée.</p></div>`;
      bindRows(results);
    }, 350);
  };
  document.getElementById("appX").onclick = () => { q.value = ""; q.oninput(); q.focus(); };
  document.getElementById("appCancel").onclick = () => { q.value = ""; results = []; q.blur(); sync(); paintHome(); };
  const lists = await Promise.all((store.overview?.projects ?? []).map(p => h.api(`/v1/projects/${p.projectId}/appstore`).then(r => (r.apps ?? []).filter(a => a.own !== false).map(a => ({ ...a, appId: String(a.appId), projectId: p.projectId }))).catch(() => [])));
  if (!document.getElementById("appsBody")) return;
  own = lists.flat().sort((a, b) => (b.ratingCount ?? 0) - (a.ratingCount ?? 0));
  paintHome();
}

// ── Fiche d'une app (AppDetailView) ─────────────────────────────────────────────────────
export async function renderAppDetail(main) {
  const a = h.state.appItem;
  if (!a) return h.go({ view: "apps" });
  main.innerHTML = `<div class="page"><div class="app-hero"><div class="gv" id="appGlobe"></div></div><div class="dt-top" style="position:absolute;top:16px"><button class="back glass" id="aBack" aria-label="Retour">${ic("left", 19)}</button></div><div id="appBody" style="display:flex;flex-direction:column;gap:14px;position:relative">${skeleton(2, 120)}</div></div>`;
  const pg = main.querySelector(".page"); pg.style.position = "relative";
  document.getElementById("aBack").onclick = () => h.back();
  mountGlobe(document.getElementById("appGlobe"), { spots: [], interactive: false }).then(g => { if (!document.getElementById("appGlobe")) return g.destroy(); cleanups.push(() => g.destroy()); });
  let showAll = false, sheet = { ranks: [], ratings: [], reviews: [] };
  const paint = () => {
    const body = document.getElementById("appBody");
    if (!body) return;
    const best = {};
    for (const r of sheet.ranks) if (r.bestRank != null && (!best[r.cc] || r.bestRank < best[r.cc].bestRank)) best[r.cc] = r;
    const countries = Object.values(best).sort((x, y) => x.bestRank - y.bestRank);
    const firsts = sheet.ranks.map(r => r.firstRankedAt).filter(Boolean), tracked = Math.max(1, Math.floor((Date.now() - (firsts.length ? Math.min(...firsts) : Date.now())) / 864e5));
    const live = {}; for (const r of sheet.ranks) if (r.rank != null) live[r.cc] = Math.min(live[r.cc] ?? 999, r.rank);
    const score = Math.min(100, Object.values(live).reduce((s, v) => s + (201 - Math.min(v, 200)) / 100, 0));
    const days = {}; for (const r of sheet.ranks) for (const x of r.history ?? []) if (x.r != null) { const k = new Date(x.t).toDateString(); (days[k] ??= { t: x.t, set: new Set() }).set.add(r.cc); }
    const timeline = Object.values(days).sort((x, y) => x.t - y.t);
    const shown = showAll ? countries : countries.slice(0, 8);
    body.innerHTML = `<div class="storeline"><span></span><a href="https://apps.apple.com/app/id${esc(a.appId)}" target="_blank" rel="noopener">Ouvrir dans l'App Store ${ic("ext", 12)}</a></div>
      <div class="ad-grid"><div class="ad-l"><div class="card app-row" style="cursor:default;order:1">${appLogo(a, 58)}<span class="tx"><b><bdi>${esc(a.name)}</bdi></b>${a.developer ? `<i style="font-size:13px"><bdi>${esc(a.developer)}</bdi></i>` : ""}</span><span class="hline"></span><span class="count-bubble"><b>${countries.length}</b>Pays</span></div>
      ${timeline.length > 1 ? `<div class="card" style="border-radius:22px;order:3"><div style="font-size:15px;font-weight:500;margin-bottom:12px">Pays classés par jour</div>${glowChart(timeline.map(d => ({ label: shortDay(d.t), v: d.set.size, text: `${d.set.size} pays` })), { height: 130 })}</div>` : ""}
            ${countries.length ? `<div class="card" style="border-radius:22px;order:4"><div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:15px;font-weight:500">Score</span><span style="font-size:22px;font-weight:500;font-variant-numeric:tabular-nums">${score.toLocaleString(MM_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span></div><div style="display:flex;gap:3px;margin:12px 0">${Array.from({ length: 20 }, (_, i) => `<i style="flex:1;height:18px;border-radius:3px;background:${i * 5 < score ? "var(--accent)" : "rgba(255,255,255,.1)"}"></i>`).join("")}</div><div class="page-sub" style="font-size:12px">${score < 20 ? "Présence émergente" : score < 60 ? "Présence solide" : "Présence mondiale"}</div></div>` : ""}
      <div class="card" style="border-radius:22px;order:5">${a.rating != null ? `<div style="display:flex;align-items:center;gap:14px"><span style="font-size:40px;font-weight:500;font-variant-numeric:tabular-nums">${a.rating.toLocaleString(MM_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span><div>${stars(a.rating)}<div class="page-sub" style="font-size:12px;margin-top:4px">Basé sur ${int(a.ratingCount)} notes</div></div></div>` : `<div style="font-size:15px;font-weight:500">Pas encore de notes</div>`}
        <div style="height:1px;background:var(--hair);margin:14px 0"></div><button class="plain" id="revBtn" style="display:flex;align-items:center;gap:8px;width:100%;font-size:14px;font-weight:500">${ic("chat", 15)}<span style="flex:1">Avis écrits</span><span class="page-sub" style="margin:0">${sheet.reviews.length}</span><span style="color:var(--ink3)">${ic("right", 12)}</span></button></div>
</div><div class="ad-r"><div class="card" style="border-radius:22px;order:2"><div style="font-size:11px;font-weight:500;letter-spacing:1px;color:var(--ink3);margin-bottom:12px">HISTORIQUE ET MEILLEURES POSITIONS</div>
        <div style="font-size:20px;font-weight:500">${countries.length ? `Sur les ${tracked} derniers jours, classée dans ${countries.length} pays.` : "Pas encore classée dans un top."}</div>
        <div style="margin-top:6px">${shown.map(r => `<div class="rank-row"><span class="fl">${flag(r.cc)}</span><div class="nm"><b style="font-size:14px">${esc(h.countryName(r.cc))}</b>${r.bestAt ? `<i>${esc(shortDay(r.bestAt))}</i>` : ""}</div>${r.rank != null && r.rank !== r.bestRank ? `<span class="page-sub" style="font-size:11px;margin:0">Actuel ${r.rank}</span>` : ""}${r.prevRank != null && r.rank != null && r.prevRank !== r.rank ? `<span style="color:${r.rank < r.prevRank ? "var(--accent)" : "var(--ink3)"};${r.rank < r.prevRank ? "" : "transform:scaleY(-1)"}">${ic("up", 10)}</span>` : ""}<b style="min-width:36px;text-align:center;padding:6px;background:rgba(255,255,255,.1);border-radius:9px;font-size:14px;font-weight:500;font-variant-numeric:tabular-nums">${r.bestRank}</b></div>`).join("")}</div>
        ${countries.length > 8 ? `<button class="plain" id="allC" style="display:flex;justify-content:space-between;width:100%;font-size:14px;font-weight:500;margin-top:10px"><span>${showAll ? "Réduire" : `Voir les ${countries.length} pays`}</span>${ic(showAll ? "up" : "down", 12)}</button>` : ""}</div>
      ${sheet.ratings.length ? `<div class="mlabel" style="padding:6px 4px 0;order:6"><span>Notes par pays</span><span>${sheet.ratings.length}</span></div><div class="card flush" style="overflow:hidden;order:7">${sheet.ratings.slice(0, 15).map(r => `<div class="cr" style="cursor:default"><span class="fl">${flag(r.cc)}</span><span style="flex:1;font-size:14px;font-weight:500">${esc(h.countryName(r.cc))}</span>${stars(r.average)}<span style="font-size:14px;font-weight:500;font-variant-numeric:tabular-nums">${r.average.toLocaleString(MM_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span><span class="page-sub" style="font-size:12px;margin:0;min-width:34px;text-align:right">${int(r.count)}</span></div>`).join("")}</div>` : ""}
      </div></div>
      ${a.rankedAt ? `<p class="updated" style="font-size:12px">Mis à jour le ${esc(new Date(a.rankedAt).toLocaleString(MM_LOCALE, { dateStyle: "medium", timeStyle: "short" }))}</p>` : ""}`;
    const all = document.getElementById("allC"); if (all) all.onclick = () => { showAll = !showAll; paint(); };
    document.getElementById("revBtn").onclick = () => { h.state.reviewsFor = { app: a, reviews: sheet.reviews }; reviewsDialog(a, sheet.reviews); };
    hydrate(body);
  };
  paint();
  sheet = await h.api(`/v1/appstore/${a.appId}/sheet`).catch(() => sheet);
  sheet.ratings = [...(sheet.ratings ?? [])].sort((x, y) => (y.count ?? 0) - (x.count ?? 0));
  paint();
}
function reviewsDialog(a, reviews) {
  let filter = null;
  const paint = () => {
    const shown = filter ? reviews.filter(r => r.rating === filter) : reviews;
    h.openModal(`<div style="font-size:28px;font-weight:700;letter-spacing:-.6px">Avis écrits</div><div class="page-sub" style="margin-bottom:12px"><bdi>${esc(a.name)}</bdi></div>
      <div class="chips" style="margin:0 0 12px;padding:0"><button type="button" class="${filter == null ? "on" : ""}" data-star="">Tous</button>${[5, 4, 3, 2, 1].map(s => `<button type="button" class="${filter === s ? "on" : ""}" data-star="${s}">${s} ★</button>`).join("")}</div>
      <div class="stack">${shown.map(r => `<div class="card" style="border-radius:22px;animation:none"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px">${stars(r.rating)}<span class="page-sub" style="font-size:12px;margin:0">${r.country ? flag(r.country) : ""} ${esc(r.at ? shortDay(r.at) : "")}</span></div><div style="font-weight:500;margin-top:8px"><bdi>${esc(r.title ?? "")}</bdi></div><p class="muted" style="margin:4px 0 0;font-size:14px">${esc(r.content ?? "")}</p></div>`).join("") || `<p class="muted">Aucun avis.</p>`}</div>
      <div class="row" style="margin-top:14px"><button>Fermer</button></div>`);
    document.querySelectorAll("[data-star]").forEach(b => b.onclick = e => { e.preventDefault(); filter = b.dataset.star ? Number(b.dataset.star) : null; paint(); });
  };
  paint();
}

// ── Classement (Leaderboard.swift) ──────────────────────────────────────────────────────
const tone = v => `rgb(${Math.round(v * .965 * 255)},${Math.round(v * .985 * 255)},${Math.round(Math.min(v * 1.09, 1) * 255)})`;
const GOLD = "#EDCF85";
function spotlight() {
  const ray = (w, a, o) => `<i style="left:50%;right:auto;width:${w}px;margin-left:${-w / 2}px;height:90%;transform-origin:50% 0;transform:rotate(${a}deg);filter:blur(5px);background:linear-gradient(180deg,${GOLD}38,transparent);opacity:${o}"></i>`;
  return `<div class="spot" aria-hidden="true">
    <i style="clip-path:polygon(45% 0,55% 0,96% 100%,4% 100%);filter:blur(26px);background:linear-gradient(180deg,${GOLD}4d,${GOLD}29 45%,${GOLD}12 85%,transparent)"></i>
    <i style="clip-path:polygon(48% 0,52% 0,72% 100%,28% 100%);filter:blur(14px);background:linear-gradient(180deg,rgba(255,255,255,.16),${GOLD}24 50%,transparent)"></i>
    ${ray(7, -11, 1)}${ray(4, -4, 1)}${ray(5, 5, 1)}${ray(8, 12, 1)}
    <i style="top:290px;bottom:auto;left:33%;right:33%;height:26px;border-radius:50%;background:${GOLD}8c;filter:blur(20px)"></i></div>`;
}
function icon3D(e, size, tilt) {
  const depth = Math.max(2, size * .075), r = size * .2237;
  return `<div style="position:relative;width:${size}px;height:${size + depth}px;perspective:400px"><div style="position:relative;width:100%;height:100%;transform:rotateY(${tilt}deg);transform-style:preserve-3d">
    <div style="position:absolute;left:0;top:${depth + size * .14}px;transform:scale(.86);filter:blur(${size * .2}px);opacity:.6">${projectIcon(e, size)}</div>
    <div style="position:absolute;left:10%;width:80%;top:${size + depth - size * .05}px;height:${size * .16}px;border-radius:50%;background:rgba(0,0,0,.55);filter:blur(${size * .06}px)"></div>
    <div style="position:absolute;left:0;top:${depth}px;filter:brightness(.55)">${projectIcon(e, size)}</div>
    <div style="position:absolute;left:0;top:0">${projectIcon(e, size)}<div style="position:absolute;inset:0;border-radius:${r}px;background:linear-gradient(180deg,rgba(255,255,255,.32),rgba(255,255,255,.08) 42%,transparent 50%);mix-blend-mode:plus-lighter;pointer-events:none"></div></div></div></div>`;
}
function lbValue(e, sort) { const hidden = sort === "revenue" ? e.revenueRange : e.mrrRange, v = sort === "revenue" ? e.revenue30dMicros : e.mrrMicros; return { text: v != null ? money(v, "EUR", true) : hidden ?? "—", unit: v != null && sort !== "revenue" ? "/mois" : "" }; }
function block(rank, front, depth, slant, side) {
  const clip = side === "left" ? `polygon(${slant}px 0,100% 0,100% 100%,0 100%)` : side === "right" ? `polygon(0 0,calc(100% - ${slant}px) 0,100% 100%,0 100%)` : `polygon(${slant}px 0,calc(100% - ${slant}px) 0,100% 100%,0 100%)`;
  const y = front * ({ mid: .30, left: .42, right: .46 }[side]) - 29;
  return `<div class="block"><div style="height:${depth}px;clip-path:${clip};background:linear-gradient(180deg,${tone(.52)},${tone(.68)})"></div>
    <div class="front" style="height:${front}px"><i style="background:linear-gradient(180deg,${tone(.435)} 0,${tone(.30)} 14%,${tone(.175)} 42%,${tone(.10)} 74%,${tone(.062)} 100%)"></i><i style="bottom:auto;height:1px;background:rgba(255,255,255,.22)"></i><i style="background:radial-gradient(60% 40% at 50% 0,rgba(255,255,255,.1),transparent)"></i><span class="digit" style="top:${y}px">${rank}</span></div></div>`;
}
const srcIcon = s => `<span class="src">${ic(s === "stripe" ? "card" : s === "googleplay" ? "play" : "apple", 9)}</span>`;
export async function renderBoard(main) {
  main.innerHTML = `<div class="lb"><div class="page"><div class="lb-grid"><div class="lb-left">${spotlight()}<div class="page-title" style="font-size:30px;position:relative">Classement</div><div class="sort glass" id="lbSort"></div><div id="lbPodium" style="position:relative"><div class="skeleton" style="height:450px"></div></div></div><div class="lb-right" id="lbBody"></div></div></div></div>`;
  let sort = h.state.lbSort ?? "mrr";
  await ensureStore().catch(() => {});
  const mine = new Set(h.state.projects.map(p => p.id));
  const paint = async () => {
    const box = document.getElementById("lbSort");
    if (!box) return;
    box.innerHTML = [["mrr", "MRR"], ["revenue", "Revenus"]].map(([k, l]) => `<button class="${sort === k ? "on" : ""}" data-sort="${k}">${l}</button>`).join("");
    box.querySelectorAll("[data-sort]").forEach(b => b.onclick = () => { sort = h.state.lbSort = b.dataset.sort; paint(); });
    const r = await h.api(`/v1/leaderboard?sort=${sort}&limit=200`);
    const body = document.getElementById("lbBody");
    if (!body) return;
    const es = r.entries ?? [], top = es.slice(0, 3), rest = es.slice(3);
    const col = (e, rank, cfg) => e ? `<div class="pcol ${cfg.side === "mid" ? "mid" : "side"}" style="animation-delay:${cfg.delay}s">
      ${rank === 1 ? `<div class="trophy">🏆</div>` : ""}<div class="p-ic">${icon3D(e, cfg.size, cfg.tilt)}${mine.has(e.projectId) ? `<span class="p-toi">Toi</span>` : ""}</div>
      <div class="p-name"><bdi>${esc(e.name)}</bdi></div><div class="p-val">${esc(lbValue(e, sort).text)}</div>${block(rank, cfg.front, cfg.depth, cfg.slant, cfg.side)}</div>` : `<div class="pcol ${cfg.side === "mid" ? "mid" : "side"}"></div>`;
    const firstMine = rest.find(e => mine.has(e.projectId))?.projectId;
    const row = e => { const v = lbValue(e, sort), my = mine.has(e.projectId), g = e.growth30d; return `<${e.website ? `a href="${esc(e.website)}" target="_blank" rel="noopener"` : "div"} class="lb-row ${my ? "mine" : ""} ${e.projectId === firstMine ? "lb-pinned" : ""}"><span class="rk">${e.rank}${g ? `<i style="color:${g > 0 ? "var(--accent)" : "var(--red)"}">${g > 0 ? "▲" : "▼"}</i>` : ""}</span>${projectIcon(e, 38)}<span class="tx"><b><bdi>${esc(e.name)}</bdi></b><span>${(e.sources ?? []).map(srcIcon).join("")}${e.tagline ? `<em style="font-style:normal;overflow:hidden;text-overflow:ellipsis"><bdi>${esc(e.tagline)}</bdi></em>` : ""}</span></span><span class="value">${esc(v.text)}<i>${v.unit}</i></span></${e.website ? "a" : "div"}>`; };
    const myBiz = (store.overview?.projects ?? []);
    const listed = es.filter(e => mine.has(e.projectId));
    document.getElementById("lbPodium").innerHTML = `<div class="podium">${col(top[1], 2, { size: 62, front: 142, depth: 26, slant: 22, tilt: 14, delay: .10, side: "left" })}${col(top[0], 1, { size: 80, front: 200, depth: 20, slant: 11, tilt: 0, delay: .22, side: "mid" })}${col(top[2], 3, { size: 62, front: 108, depth: 30, slant: 22, tilt: -14, delay: .02, side: "right" })}</div>`;
    body.innerHTML = `<div class="lb-rows">${rest.map(row).join("")}</div>
      <button class="lb-join" id="lbJoin"><span style="display:flex">${myBiz.slice(0, 3).map((p, i) => `<span style="margin-left:${i ? -14 : 0}px;position:relative;z-index:${3 - i}">${projectIcon(p, 40)}</span>`).join("")}</span><b>${listed.length ? "Mes business au classement" : "Inscrire mon business"}</b><span style="color:var(--ink3)">${ic("right", 13)}</span></button>
      <p class="lb-foot">${int(r.total)} business · mis à jour ${esc(new Date(r.updatedAt).toLocaleTimeString(MM_LOCALE, { hour: "2-digit", minute: "2-digit" }))}</p>`;
    document.getElementById("lbJoin").onclick = () => joinDialog(paint);
  };
  await paint().catch(e => { const b = document.getElementById("lbBody"); if (b) b.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; });
}
async function joinDialog(after) {
  const list = store.overview?.projects ?? [];
  const states = await Promise.all(list.map(p => h.api(`/v1/projects/${p.projectId}/public`).catch(() => ({ listed: false }))));
  const paint = () => {
    h.openModal(`<div style="font-size:24px;font-weight:700;letter-spacing:-.5px">Mes business au classement</div><p class="muted" style="margin:8px 0 14px;font-size:14px">Les chiffres viennent directement de tes stores et sont vérifiés. Tu peux masquer les montants exacts.</p>
      <div class="stack">${list.map((p, i) => `<div class="card flush" style="animation:none;padding:12px 14px;border-radius:20px"><div style="display:flex;align-items:center;gap:12px">${projectIcon(p, 38)}<b style="flex:1;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><bdi>${esc(p.name)}</bdi></b><button type="button" class="small ${states[i].listed ? "" : "primary"}" data-join="${i}" style="flex:none">${states[i].listed ? "Retirer" : "Inscrire"}</button></div>
        ${states[i].listed ? `<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--ink2)"><input type="checkbox" data-hide="${i}" ${states[i].hideAmounts ? "checked" : ""}> Afficher une fourchette au lieu du montant</label>` : ""}</div>`).join("")}</div>
      <div class="row" style="margin-top:14px"><button>Fermer</button></div>`);
    document.querySelectorAll("[data-join]").forEach(b => b.onclick = async () => { const i = Number(b.dataset.join); b.disabled = true; states[i] = await h.api(`/v1/projects/${list[i].projectId}/public`, { method: "PUT", body: { ...states[i], listed: !states[i].listed } }).catch(e => { h.toast(e.message); return states[i]; }); paint(); after(); });
    document.querySelectorAll("[data-hide]").forEach(c => c.onchange = async () => { const i = Number(c.dataset.hide); states[i] = await h.api(`/v1/projects/${list[i].projectId}/public`, { method: "PUT", body: { ...states[i], hideAmounts: c.checked } }).catch(e => { h.toast(e.message); return states[i]; }); after(); });
  };
  paint();
}

// ── Planète (GlobeExplorer) ─────────────────────────────────────────────────────────────
function starField(cv) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const c = cv.getContext("2d"); c.scale(dpr, dpr);
  for (let i = 0; i < 170; i++) { const x = (i * 7919 % 1000) / 1000 * r.width, y = (i * 104729 % 1000) / 1000 * r.height, s = .4 + (i * 31 % 10) / 14; c.fillStyle = `rgba(255,255,255,${.12 + (i * 13 % 10) / 22})`; c.beginPath(); c.arc(x, y, s, 0, 6.2832); c.fill(); }
}
export async function renderPlanet(main) {
  main.innerHTML = `<div class="planet"><canvas class="stars-bg" id="pStars" style="width:100%;height:100%"></canvas><div class="gl" id="pGlobe"></div>
    <div class="planet-top"><div class="planet-bar"><button class="back glass" id="pBack" aria-label="Retour">${ic("left", 19)}</button><div class="ttl">Planète</div><span class="page-sub" id="pCount" style="min-width:44px;text-align:right;margin:0"></span></div><div class="pchips" id="pChips"></div></div>
    <div class="zoomer glass" id="pZoom"><button id="zIn" aria-label="Zoomer">${ic("plus", 18)}</button><button id="zOut" aria-label="Dézoomer">${ic("minus", 18)}</button><button id="zLoc" aria-label="Recentrer">${ic("locate", 19)}</button></div><div id="pCard"></div></div>`;
  document.getElementById("pBack").onclick = () => h.back();
  starField(document.getElementById("pStars"));
  await ensureStore().catch(() => {});
  const o = scopeOverview(store.overview);
  if (!o) return;
  const spots = globeSpots(o.projects, store.feed), cur = o.currency, total = Math.max(spots.reduce((s, x) => s + x.value, 0), .0001), ranked = spots.filter(s => s.value >= .01).sort((a, b) => b.value - a.value);
  document.getElementById("pCount").textContent = `${ranked.length} pays`;
  let selected = h.state.planetCC ?? null, g;
  const paint = () => {
    const chips = document.getElementById("pChips");
    if (!chips) return;
    chips.innerHTML = ranked.map((s, i) => `<button class="glass ${selected === s.cc ? "on" : ""}" data-cc="${s.cc}"><i>${i + 1}</i>${flag(s.cc)}<span class="nm">${esc(h.countryName(s.cc))}</span> ${money(s.value * 1e6, cur, true)}</button>`).join("");
    chips.querySelectorAll("[data-cc]").forEach(b => b.onclick = () => select(b.dataset.cc));
    const s = spots.find(x => x.cc === selected), card = document.getElementById("pCard");
    card.innerHTML = s ? `<div class="planet-card glass"><span class="fl">${flag(s.cc)}</span><div><b>${esc(h.countryName(s.cc))}</b><i>${Math.round(s.value / total * 100)} % du revenu</i></div><span class="v">${money(s.value * 1e6, cur)}</span><button class="plain" id="pClose" aria-label="Fermer" style="color:var(--ink3)">${ic("xc", 20)}</button></div>` : "";
    const close = document.getElementById("pClose"); if (close) close.onclick = () => select(null);
    document.getElementById("pZoom").style.display = s ? "none" : "";
  };
  const select = cc => { selected = cc; g?.setHighlight(cc); if (cc) g?.focus(cc); paint(); };
  paint();
  g = await mountGlobe(document.getElementById("pGlobe"), { spots, wheelZoom: true, onTap: cc => select(cc), initial: desktop() ? { scale: .8, tScale: .8 } : { scale: .92, tScale: .92 } });
  if (!document.getElementById("pGlobe")) return g.destroy();
  cleanups.push(() => g.destroy());
  document.getElementById("zIn").onclick = () => g.zoomBy(1.35);
  document.getElementById("zOut").onclick = () => g.zoomBy(1 / 1.35);
  document.getElementById("zLoc").onclick = () => { g.reset(); select(null); };
  if (selected) select(selected);
}

// ── Ordinateur : barre du haut (pas de menu latéral) et Vue d'ensemble façon tableau de bord ──
document.addEventListener("click", e => { const m = document.getElementById("tbMenu"); if (m && !m.hidden && !e.target.closest(".tb-biz")) { m.hidden = true; document.getElementById("tbPick")?.setAttribute("aria-expanded", "false"); } });
addEventListener("keydown", e => { if (e.key === "Escape") { const m = document.getElementById("tbMenu"); if (m) m.hidden = true; } });
const DESK_NAV = [["home", "Vue d'ensemble"], ["feed", "Ventes"], ["apps", "Apps"], ["board", "Classement"]];
export function renderTopbar() {
  const bar = document.getElementById("topbar");
  if (!bar) return;
  const cur = h.state.view === "project" ? null : TAB_OF[h.state.view] ?? (h.state.view === "settings" ? null : "home");
  const list = allProjects().length ? allProjects() : h.state.projects.map(p => ({ projectId: p.id, name: p.name }));
  const curP = h.state.view === "project" ? list.find(p => p.projectId === h.state.projectId) : null;
  bar.innerHTML = `<button class="tb-logo" data-tb="home" aria-label="Vue d'ensemble"><img src="/logo.png" alt="MoneyMaker"></button>
    <div class="tb-biz"><button class="tb-pick" id="tbPick" aria-haspopup="menu" aria-expanded="false">${curP ? projectIcon(curP, 20) : ""}<span><bdi>${esc(curP?.name ?? "Tous les business")}</bdi></span>${ic("down", 11)}</button>
      <div class="tb-menu" id="tbMenu" role="menu" hidden>
        <button role="menuitem" data-tb="home"><span class="tb-all">${ic("grid", 14)}</span><span>Tous les business</span></button>
        ${list.map(p => `<button role="menuitem" data-open="${esc(p.projectId)}">${projectIcon(p, 22)}<span><bdi>${esc(p.name)}</bdi></span></button>`).join("")}
        <div class="tb-sep"></div>
        <button role="menuitem" id="tbNew"><span class="tb-all">${ic("plus", 14)}</span><span>Nouveau business</span></button>
      </div></div>
    <nav class="tb-nav" aria-label="Navigation">${DESK_NAV.map(([k, t]) => `<button data-tb="${k}" class="${k === cur ? "on" : ""}" ${k === cur ? 'aria-current="page"' : ""}>${t}</button>`).join("")}</nav>
    <div class="tb-right">
      <a class="tb-icon" href="https://apps.apple.com/app/id6821596839" target="_blank" rel="noopener" title="App iPhone" aria-label="App iPhone">${ic("phone", 17)}</a>
      <button class="tb-icon ${h.state.view === "settings" ? "on" : ""}" data-tb="settings" title="Réglages" aria-label="Réglages">${ic("gearf", 17)}</button>
    </div>`;
  const menu = bar.querySelector("#tbMenu"), pick = bar.querySelector("#tbPick");
  const close = () => { menu.hidden = true; pick.setAttribute("aria-expanded", "false"); };
  pick.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; pick.setAttribute("aria-expanded", String(!menu.hidden)); };
  bar.querySelectorAll("[data-tb]").forEach(b => b.onclick = () => { close(); h.state.focus = null; h.go({ view: b.dataset.tb, projectId: null }); });
  bar.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { close(); h.openProject(b.dataset.open); });
  bar.querySelector("#tbNew").onclick = () => { close(); h.newProjectDialog(); };
}

/** Carte de métrique ordinateur : la tuile de l'app iPhone (surface, grille de points, courbe vline), en grand. */
function deskCard({ title, icon, value, sub, chart, href, seed, anchor = "topTrailing" }, i) {
  const tag = href ? "button" : "div";
  return `<${tag} class="tile anim-in dk-tile ${href ? "" : "static"}" ${href ? `data-href="${href}"` : ""} style="--i:${i}">${dotsCanvas(anchor, seed)}
    <div class="dk-in">${tileHead(icon, title)}<div class="dk-v">${esc(value)}</div><div class="dk-s">${esc(sub)}</div><div class="dk-chart">${chart}</div></div></${tag}>`;
}
function deskCards(o, t) {
  const cur = o.currency, byDay = mergedByDay(o), days = o.periodDays ?? 30;
  // Nouveaux clients par jour : seulement les business affichés, hors achats de test.
  const ids = o.projects.map(p => p.projectId), newByDay = {};
  for (const e of store.feed) if (ids.includes(e.projectId) && !e.isSandbox && (e.type === "INITIAL_PURCHASE" || e.type === "NON_RENEWING_PURCHASE")) { const k = new Date(e.at).toISOString().slice(0, 10); newByDay[k] = (newByDay[k] ?? 0) + 1e6; }
  let run = 0;
  const cards = [
    { title: "Aujourd'hui", icon: "bolt", value: money(gross(t), t?.currency ?? cur), sub: "Depuis minuit", chart: vline((t?.hourly ?? [0, 0]).map(v => v / 1e6), { money: true }), href: "metric/today", seed: 0 },
    { title: "MRR", icon: "cycle", value: money(o.mrrMicros, cur), sub: "Revenu récurrent mensuel", chart: vline(dailySeries(byDay, 30).map(d => (run += d.v)), { money: true }), href: "metric/mrr", seed: 1, anchor: "bottomTrailing" },
    { title: `Revenu ${days} j`, icon: "euro", value: money(netOf(o), cur), sub: `${days} derniers jours`, chart: vline(dailySeries(byDay, days).map(d => d.v), { money: true }), href: "metric/revenue", seed: 2 },
    { title: "Abonnés actifs", icon: "people", value: int(o.activeSubscriptions), sub: "En ce moment", chart: sliderTrack(metricRatio("subscriptions", o)), href: "metric/subscriptions", seed: 3 },
    { title: "Nouveaux clients", icon: "sparkles", value: int(o.newCustomers), sub: `${days} derniers jours`, chart: vline(dailySeries(newByDay, days).map(d => d.v)), seed: 4, anchor: "bottomLeading" },
    (o.hasTrials ?? o.activeTrials > 0)
      ? { title: "Essais en cours", icon: "hourglass", value: int(o.activeTrials), sub: "En ce moment", chart: sliderTrack(metricRatio("trials", o)), href: "metric/trials", seed: 5 }
      : o.downloads != null
        ? { title: "Téléchargements", icon: "download", value: int(o.downloads), sub: o.downloadsLive ? `En direct · ${int(t?.installs ?? 0)} aujourd'hui` : `${days} derniers jours`, chart: sliderTrack(metricRatio("downloads", o)), href: "metric/downloads", seed: 6 }
        : { title: "Utilisateurs payants", icon: "card", value: int(payingOf(o)), sub: "En ce moment", chart: vline(dailySeries(byDay, 30).map(d => d.v)), href: "metric/paying", seed: 5 },
  ];
  return cards.map(deskCard).join("");
}
function deskTable(events) {
  const rows = events.slice(0, 10).map(e => {
    const b = eventBadge(e), amt = amountOf(e), p = projectOf(e.projectId) ?? { projectId: e.projectId, name: e.projectName };
    const who = e.appUserId ? masked(String(e.appUserId)) : "—";
    return `<tr data-event="${esc(e.id)}"><td><span class="dk-who">${e.country ? `<span>${flag(e.country)}</span>` : ""}<bdi>${esc(who)}</bdi></span></td>
      <td><span class="dk-proj">${projectIcon(p, 22)}<bdi>${esc(p.name ?? "")}</bdi></span></td>
      <td>${esc(storeLabel(e.store) ?? "—")}</td><td class="dk-prod"><bdi>${esc(productLabel(e) ?? "—")}</bdi></td>
      <td>${esc(timeOf(e))}</td><td class="num" style="color:${amt ? amountColor(e) : "inherit"}">${amt ?? "—"}</td><td>${tbadge(b)}</td></tr>`;
  }).join("");
  return rows ? `<div class="dk-tablewrap"><table class="dk-table"><thead><tr><th>Client</th><th>Business</th><th>Store</th><th>Produit</th><th>Date</th><th class="num">Montant</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="dk-empty">Tes premières ventes apparaîtront ici dès qu'un store est connecté.</div>`;
}
async function renderDeskHome(main) {
  main.innerHTML = `<div class="dk"><div class="dk-head"><h1>Vue d'ensemble</h1><div class="dk-actions"><span class="dk-upd" id="dkUpd"></span><button class="dk-btn glass" id="dkAll">Toutes les ventes ${ic("right", 11)}</button></div></div>
    <div class="dk-chips" id="dkChips"></div>
    <div class="dk-grid" id="dkGrid">${skeleton(6, 210)}</div>
    <div class="dk-h2"><h2>Transactions récentes</h2><button class="dk-link" id="dkAll2">Tout voir ${ic("right", 11)}</button></div><div id="dkTx"></div>
    <div class="dk-h2"><h2>Revenus par pays</h2><button class="dk-link" id="dkPlanet">Explorer ${ic("right", 11)}</button></div>
    <div class="globe-sec" id="dkGlobe"><div class="globe-box"><div id="dkGlobeView" style="position:absolute;inset:0"></div></div><div class="gl-side"><div id="gRank"></div></div></div></div>`;
  document.getElementById("dkPlanet").onclick = () => h.go({ view: "planet", projectId: null });
  document.getElementById("dkAll").onclick = document.getElementById("dkAll2").onclick = () => h.go({ view: "feed", projectId: null });
  const paint = () => {
    const grid = document.getElementById("dkGrid");
    if (!grid || !store.overview) return;
    const sel = selectedProjects(), f = h.state.focus, o = scopeOverview(store.overview), ids = viewIds();
    const chips = document.getElementById("dkChips");
    chips.innerHTML = sel.length > 1 ? `<button class="glass ${f ? "" : "on"}" data-focus=""><span class="dk-stack">${sel.slice(0, 3).map(p => projectIcon(p, 22)).join("")}</span><span>Tous les business</span></button>${sel.map(p => `<button class="glass ${f === p.projectId ? "on" : ""}" data-focus="${esc(p.projectId)}">${projectIcon(p, 22)}<bdi>${esc(p.name)}</bdi></button>`).join("")}` : "";
    chips.querySelectorAll("[data-focus]").forEach(b => b.onclick = () => { h.state.focus = b.dataset.focus || null; paint(); scopeChanged(); });
    const firstPaint = !grid.querySelector(".dk-tile");
    grid.innerHTML = deskCards(o, store.today);
    if (!firstPaint) grid.querySelectorAll(".anim-in").forEach(e => e.classList.remove("anim-in"));
    hydrate(grid);
    grid.querySelectorAll("[data-href]").forEach(b => b.onclick = () => { const [view, k] = b.dataset.href.split("/"); h.go({ view, metric: k, projectId: null }); });
    const tx = document.getElementById("dkTx");
    const events = store.feed.filter(e => ids.includes(e.projectId) && e.type !== "TEST");
    tx.innerHTML = deskTable(events);
    hydrate(tx);
    tx.querySelectorAll("[data-event]").forEach(r => r.onclick = () => {
      const e = store.feed.find(x => x.id === r.dataset.event); if (!e) return;
      if (load("mmOpenAs") === "customer" && e.appUserId) h.go({ view: "customer", customer: { projectId: e.projectId, appUserId: e.appUserId }, projectId: null });
      else h.go({ view: "tx", event: e, eventRef: { projectId: e.projectId, id: e.id }, projectId: null });
    });
    const u = document.getElementById("dkUpd"); if (u) u.textContent = `Mis à jour ${ago(store.at || o.generatedAt)}`;
    const spots = globeSpots(o.projects, store.feed), cur = o.currency, ranked = spots.filter(x => x.value >= .01).sort((a, b) => b.value - a.value);
    globe?.setSpots(spots);
    const list = document.getElementById("gRank");
    list.innerHTML = `<div class="card flush">${ranked.slice(0, 20).map(x => `<button class="cr" data-cc="${x.cc}"><span class="fl">${flag(x.cc)}</span><span class="bd"><span class="ln"><b>${esc(h.countryName(x.cc))}</b><span>${money(x.value * 1e6, cur, true)}</span></span><span class="br" style="width:${Math.max(1, x.value / ranked[0].value * 100)}%"></span></span></button>`).join("") || `<p class="muted" style="padding:18px;margin:0">Tes premières ventes apparaîtront ici, pays par pays.</p>`}</div>`;
    list.querySelectorAll("[data-cc]").forEach(b => b.onclick = () => { globe?.setHighlight(b.dataset.cc); globe?.focus(b.dataset.cc); list.querySelectorAll("[data-cc]").forEach(x => x.classList.toggle("on", x === b)); });
  };
  let globe = null;
  try { await ensureStore(); } catch (e) { main.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; return; }
  paint();
  renderTopbar();
  const o0 = scopeOverview(store.overview);
  mountGlobe(document.getElementById("dkGlobeView"), { spots: globeSpots(o0.projects, store.feed), onTap: cc => h.go({ view: "planet", planetCC: cc ?? null, projectId: null }) })
    .then(g => { if (!document.getElementById("dkGlobeView")) return g.destroy(); globe = g; cleanups.push(() => g.destroy()); }).catch(() => {});
  h.onStoreChange = paint;
  cleanups.push(() => { h.onStoreChange = null; });
  const tick = setInterval(() => { if (!document.hidden) refresh().then(() => h.onStoreChange?.()).catch(() => {}); }, 60000);
  cleanups.push(() => clearInterval(tick));
}
