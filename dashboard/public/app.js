import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
const config = await fetch("/__/firebase/init.json").then(r => r.json()).catch(() => ({ apiKey: "demo", projectId: "demo-moneymaker", authDomain: "localhost" }));
const auth = getAuth(initializeApp(config));
if (local) connectAuthEmulator(auth, "http://127.0.0.1:9199", { disableWarnings: true });

const state = { projects: [], view: "overview", projectId: null, tab: "metrics", days: 30 };

// ── API ─────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(path, {
    ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || res.statusText);
  return json;
}

const money = (micros, cur = "EUR") => new Intl.NumberFormat("fr-FR", { style: "currency", currency: cur, maximumFractionDigits: Math.abs(micros) >= 1e10 ? 0 : 2 }).format((micros ?? 0) / 1e6);
const pct = v => v == null ? "—" : `${(v * 100).toFixed(1)} %`;
const date = t => t ? new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2600); }
async function copy(text) { await navigator.clipboard.writeText(text); toast("Copié"); }
window.mmCopy = copy;
const copyRow = (value, secret = false) =>
  `<div class="copy"><code>${esc(secret ? value.slice(0, 12) + "•••••••" : value)}</code><button type="button" class="small" onclick='mmCopy(${esc(JSON.stringify(value))})'>Copier</button></div>`;

// ── Auth ────────────────────────────────────────────────────────────────
$("#google").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => $("#loginError").textContent = e.message);
$("#emailForm").onsubmit = e => { e.preventDefault(); signInWithEmailAndPassword(auth, $("#email").value, $("#password").value).catch(err => $("#loginError").textContent = err.message); };
$("#signup").onclick = () => createUserWithEmailAndPassword(auth, $("#email").value, $("#password").value).catch(e => $("#loginError").textContent = e.message);
$("#logout").onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  $("#login").classList.toggle("hidden", Boolean(user));
  $("#app").classList.toggle("hidden", !user);
  if (user) { await loadProjects(); route(); }
});

async function loadProjects() {
  state.projects = (await api("/v1/projects")).projects;
  $("#projectNav").innerHTML = state.projects.map(p => `<button class="nav" data-project="${esc(p.id)}">${esc(p.name)}</button>`).join("");
  document.querySelectorAll("[data-project]").forEach(b => b.onclick = () => go({ view: "project", projectId: b.dataset.project, tab: "metrics" }));
}
document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => go({ view: b.dataset.view, projectId: null }));
$("#newProject").onclick = newProjectDialog;

function go(patch) { Object.assign(state, patch); history.replaceState(null, "", state.projectId ? `#${state.projectId}/${state.tab}` : `#${state.view}`); route(); }
function route() {
  if (!state.projectId && location.hash.includes("/")) { const [pid, tab] = location.hash.slice(1).split("/"); if (state.projects.some(p => p.id === pid)) Object.assign(state, { view: "project", projectId: pid, tab }); }
  document.querySelectorAll(".nav").forEach(b => b.classList.toggle("active", b.dataset.view === state.view && !state.projectId || b.dataset.project === state.projectId));
  const main = $("#main");
  main.innerHTML = `<div class="empty">Chargement…</div>`;
  const render = state.view === "project" ? renderProject : state.view === "account" ? renderAccount : renderOverview;
  render(main).catch(e => main.innerHTML = `<div class="empty error">${esc(e.message)}</div>`);
}

// ── Charts (dependency-free SVG) ────────────────────────────────────────
function lineChart(points, cur, color = "var(--accent)") {
  if (points.length < 2) return `<div class="empty">Pas encore assez d'historique — le graphique se remplit chaque jour.</div>`;
  const W = 600, H = 200, P = 6, max = Math.max(1, ...points.map(p => p.v)), min = Math.min(0, ...points.map(p => p.v));
  const x = i => P + (i / (points.length - 1)) * (W - 2 * P), y = v => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="graphique">
    <path d="${d}L${x(points.length - 1)},${H}L${x(0)},${H}Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="6" fill="transparent"><title>${esc(p.label)} · ${esc(money(p.v, cur))}</title></circle>`).join("")}</svg>`;
}
function barChart(byDay, days, cur) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const k = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); out.push({ label: k, v: byDay[k] ?? 0 }); }
  const W = 600, H = 200, max = Math.max(1, ...out.map(p => p.v)), bw = W / out.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="revenus par jour">${out.map((p, i) => {
    const h = Math.max(p.v > 0 ? 2 : 0, (Math.max(0, p.v) / max) * (H - 4));
    return `<rect x="${i * bw + 1}" y="${H - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="var(--accent2)"><title>${p.label} · ${esc(money(p.v, cur))}</title></rect>`;
  }).join("")}</svg>`;
}

const kpi = (label, value, sub = "", hero = false) => `<div class="kpi ${hero ? "hero" : ""}"><h3>${esc(label)}</h3><div class="v">${value}</div><div class="s">${sub}</div></div>`;
const daysPicker = () => `<div class="row seg">${[7, 30, 90, 365].map(d => `<button class="small ${state.days === d ? "primary" : ""}" data-days="${d}">${d} j</button>`).join("")}</div>`;
function bindDays() { document.querySelectorAll("[data-days]").forEach(b => b.onclick = () => { state.days = Number(b.dataset.days); route(); }); }

// ── Overview (all businesses) ───────────────────────────────────────────
async function renderOverview(main) {
  if (!state.projects.length) {
    main.innerHTML = `<div class="head"><div><h1>Bienvenue 👋</h1><p class="muted">Crée ton premier business pour obtenir tes clés API.</p></div></div>
      <div class="card empty"><button class="primary" id="first">Créer un business</button></div>`;
    $("#first").onclick = newProjectDialog; return;
  }
  const o = await api(`/v1/overview?days=${state.days}`);
  const c = o.currency;
  main.innerHTML = `<div class="head"><div><h1>Vue globale</h1><p class="muted">${state.projects.length} business · mis à jour ${date(o.generatedAt)}</p></div>${daysPicker()}</div>
  <div class="kpis">${kpi("MRR total", money(o.mrrMicros, c), `ARR ${money(o.mrrMicros * 12, c)}`, true)}${kpi(`Revenu ${state.days} j`, money(o.revenueMicros, c), "net des remboursements")}
  ${kpi("Abonnés actifs", o.activeSubscriptions)}${kpi("Essais en cours", o.activeTrials)}${kpi(`Nouveaux clients ${state.days} j`, o.newCustomers)}</div>
  <div class="card"><table><thead><tr><th>Business</th><th>MRR</th><th>Revenu ${state.days} j</th><th>Abonnés</th><th>Essais</th><th>Conversion essai</th><th>Churn</th></tr></thead><tbody>
  ${o.projects.map(p => `<tr class="click" data-open="${esc(p.projectId)}"><td><b>${esc(p.name)}</b></td><td>${money(p.mrrMicros, p.currency)}</td><td>${money(p.netRevenueMicros, p.currency)}</td><td>${p.activeSubscriptions}</td><td>${p.activeTrials}</td><td>${pct(p.trialConversionRate)}</td><td>${pct(p.churnRate)}</td></tr>`).join("")}
  </tbody></table></div>
  <div class="card" style="margin-top:12px"><h2>Dernières alertes App Store</h2><div id="ovAlerts" class="muted">Chargement…</div></div>`;
  api("/v1/alerts").then(({ alerts }) => { $("#ovAlerts").outerHTML = alerts.length ? `<table>${alerts.slice(0, 15).map(alertRow).join("")}</table>` : `<p class="muted">Aucune alerte — ajoute tes apps dans l'onglet App Store d'un business.</p>`; }).catch(() => null);
  bindDays();
  document.querySelectorAll("[data-open]").forEach(r => r.onclick = () => go({ view: "project", projectId: r.dataset.open, tab: "metrics" }));
}

// ── Project ─────────────────────────────────────────────────────────────
const TABS = { metrics: "Métriques", map: "Carte", cohorts: "Cohortes", appstore: "App Store", reviews: "Avis", alerts: "Alertes", customers: "Clients", events: "Événements", products: "Produits & accès", connect: "Connexions", settings: "Réglages" };
async function renderProject(main) {
  const p = state.projects.find(x => x.id === state.projectId);
  if (!TABS[state.tab]) state.tab = "metrics";
  main.innerHTML = `<div class="head"><div><h1>${esc(p?.name)}</h1><p class="muted mono">${esc(state.projectId)}</p></div>${["metrics", "map"].includes(state.tab) ? daysPicker() : ""}</div>
    <div class="tabs">${Object.entries(TABS).map(([k, v]) => `<button class="small ${state.tab === k ? "active" : ""}" data-tab="${k}">${v}</button>`).join("")}</div><div id="tab"></div>`;
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => go({ tab: b.dataset.tab }));
  bindDays();
  await ({ metrics: tabMetrics, map: tabMap, cohorts: tabCohorts, appstore: tabAppStore, reviews: tabReviews, alerts: tabAlerts, customers: tabCustomers, events: tabEvents, products: tabProducts, connect: tabConnect, settings: tabSettings }[state.tab] ?? tabMetrics)($("#tab"));
}

const delta = (cur, prev, fmt = v => v) => {
  if (prev == null || !isFinite(prev) || prev === 0) return "";
  const d = (cur - prev) / Math.abs(prev);
  return ` <span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(0)} %</span>`;
};
const COUNTRIES = await fetch("/countries.json").then(r => r.json()).catch(() => ({}));
const countryName = cc => COUNTRIES[cc]?.name ?? (cc === "??" ? "Inconnu" : cc);
const flag = cc => cc && cc.length === 2 && cc !== "??" ? String.fromCodePoint(...[...cc].map(c => 0x1f1a5 + c.charCodeAt(0))) : "🌐";
const topRows = (obj, fmt, n = 8) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `<tr><td>${flag(k)} ${esc(countryName(k))}</td><td style="text-align:right">${fmt(v)}</td></tr>`).join("") || `<tr><td class="muted">—</td></tr>`;
const exportBtns = () => `<div class="row seg">${["customers", "transactions", "events"].map(k => `<button class="small" data-export="${k}">⬇︎ ${k}.csv</button>`).join("")}</div>`;
function bindExports() {
  document.querySelectorAll("[data-export]").forEach(b => b.onclick = async () => {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(`/v1/projects/${state.projectId}/export/${b.dataset.export}`, { headers: { Authorization: `Bearer ${token}` } });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement("a"), { href: url, download: `${b.dataset.export}.csv` }).click();
    URL.revokeObjectURL(url);
  });
}

async function tabMetrics(el) {
  const m = await api(`/v1/projects/${state.projectId}/metrics?days=${state.days}`);
  const c = m.currency, pv = m.previous ?? {};
  const mrrHistory = m.history.map(h => ({ label: h.date, v: h.mrrMicros }));
  const subsHistory = m.history.map(h => ({ label: h.date, v: (h.activeSubscriptions ?? 0) * 1e6 }));
  const mv = m.mrrMovement ?? { newMicros: 0, churnedMicros: 0, netMicros: 0 };
  const trials = Object.entries(m.trialsByProduct ?? {});
  el.innerHTML = `<div class="kpis">${kpi("MRR", money(m.mrrMicros, c), `ARR ${money(m.arrMicros, c)}`, true)}
    ${kpi(`Revenu ${state.days} j`, money(m.netRevenueMicros, c) + delta(m.netRevenueMicros, pv.netRevenueMicros), m.refundsMicros ? `remboursé ${money(m.refundsMicros, c)} (${pct(m.refundRate)})` : "aucun remboursement")}
    ${kpi("Abonnés actifs", m.activeSubscriptions, `${m.willNotRenew} ne renouvelleront pas`)}
    ${kpi("Essais", m.activeTrials, `conversion ${pct(m.trialConversionRate)}`)}
    ${kpi("Nouveaux abonnés", m.newSubscriptions + delta(m.newSubscriptions, pv.newSubscriptions), `${m.trialsStarted} essais démarrés`)}
    ${kpi("Nouveaux clients", m.newCustomers + delta(m.newCustomers, pv.newCustomers), `${m.totalCustomers} au total`)}
    ${kpi("Churn mensuel", pct(m.monthlyChurnRate), `${m.eventCounts.EXPIRATION ?? 0} expirations sur ${state.days} j`)}
    ${kpi("LTV estimée", m.ltvMicros == null ? "—" : money(m.ltvMicros, c), "revenu moyen ÷ churn")}
    ${kpi("ARPPU", money(m.arppuMicros, c), `${m.payingCustomers} payeurs sur ${state.days} j`)}
    ${kpi("ARPU", money(m.arpuMicros, c), "revenu ÷ tous les clients")}
    ${kpi("Problèmes de paiement", m.billingIssues, "en grâce / retry")}
    ${kpi("Mouvement MRR", (mv.netMicros >= 0 ? "+" : "") + money(mv.netMicros, c), `+${money(mv.newMicros, c)} · −${money(mv.churnedMicros, c)}`)}</div>
    <div class="grid2"><div class="card"><h3>MRR</h3>${lineChart(mrrHistory, c)}</div><div class="card"><h3>Revenu par jour</h3>${barChart(m.revenueByDay, Math.min(state.days, 90), c)}</div></div>
    <div class="grid2" style="margin-top:12px">
      <div class="card"><h3>Abonnés actifs</h3>${lineChart(subsHistory, c, "var(--accent2)").replace(/<title>[^<]*<\/title>/g, "")}</div>
      <div class="card"><h3>Nouveau vs renouvellements</h3><table>
        <tr><td>Nouveaux achats</td><td style="text-align:right">${money(m.newRevenueMicros, c)}</td></tr>
        <tr><td>Renouvellements</td><td style="text-align:right">${money(m.renewalRevenueMicros, c)}</td></tr>
        <tr><td>Remboursements</td><td style="text-align:right">−${money(m.refundsMicros, c)}</td></tr>
        <tr><td><b>Net</b></td><td style="text-align:right"><b>${money(m.netRevenueMicros, c)}</b></td></tr></table></div></div>
    <div class="grid2" style="margin-top:12px">
      <div class="card"><h3>Revenu par pays</h3><table>${topRows(m.revenueByCountry ?? {}, v => money(v, c))}</table><p><a href="#" id="toMap">Voir la carte →</a></p></div>
      <div class="card"><h3>Revenu par store</h3><table>${Object.entries(m.revenueByStore ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right">${money(v, c)}</td><td class="muted" style="text-align:right">${m.byStore[k]?.active ?? 0} actifs</td></tr>`).join("") || `<tr><td class="muted">—</td></tr>`}</table></div></div>
    <div class="grid2" style="margin-top:12px">
      <div class="card"><h3>Par produit</h3><table>${[...new Set([...Object.keys(m.byProduct), ...Object.keys(m.revenueByProduct ?? {})])].map(k => `<tr><td class="mono">${esc(k)}</td><td>${m.byProduct[k]?.active ?? 0} actifs</td><td style="text-align:right">MRR ${money(m.byProduct[k]?.mrrMicros ?? 0, c)}</td><td style="text-align:right">${money(m.revenueByProduct?.[k] ?? 0, c)}</td></tr>`).join("") || `<tr><td class="muted">—</td></tr>`}</table></div>
      <div class="card"><h3>Conversion des essais par produit</h3><table>${trials.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${v.started} essais</td><td>${v.converted} convertis</td><td style="text-align:right">${pct(v.started ? v.converted / v.started : null)}</td></tr>`).join("") || `<tr><td class="muted">Aucun essai sur la période</td></tr>`}</table></div></div>
    <div class="row" style="margin-top:14px;justify-content:space-between"><span class="muted">Données brutes</span>${exportBtns()}</div>`;
  $("#toMap").onclick = e => { e.preventDefault(); go({ tab: "map" }); };
  bindExports();
}

// ── World map (d3 + world-atlas, loaded on demand) ─────────────────────
let geo;
async function worldMap(container, values, { color = "#00d084", fmt = v => v, onClick } = {}) {
  geo ??= await Promise.all([
    import("https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm"), import("https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm"),
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json").then(r => r.json()),
  ]);
  const [d3, topojson, world] = geo;
  const byNumeric = Object.fromEntries(Object.entries(COUNTRIES).map(([cc, c]) => [String(Number(c.n)), cc]));
  const features = topojson.feature(world, world.objects.countries).features.filter(f => f.id !== "010");
  const W = 960, H = 470;
  const projection = d3.geoNaturalEarth1().fitSize([W, H], { type: "FeatureCollection", features });
  const path = d3.geoPath(projection);
  const max = Math.max(1, ...Object.values(values));
  const scale = v => v > 0 ? 0.18 + 0.82 * Math.sqrt(v / max) : 0;
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="map" role="img" aria-label="carte du monde">${features.map(f => {
    const cc = byNumeric[String(Number(f.id))], v = values[cc] ?? 0;
    return `<path d="${path(f)}" data-cc="${cc ?? ""}" fill="${v ? color : "var(--panel2)"}" fill-opacity="${v ? scale(v).toFixed(2) : 1}" stroke="var(--bg)" stroke-width=".5"><title>${esc(countryName(cc ?? "??"))}${v ? " · " + esc(fmt(v)) : ""}</title></path>`;
  }).join("")}</svg>`;
  if (onClick) container.querySelectorAll("path[data-cc]").forEach(p => p.onclick = () => p.dataset.cc && onClick(p.dataset.cc));
}

async function tabMap(el) {
  const m = await api(`/v1/projects/${state.projectId}/metrics?days=${state.days}`);
  const c = m.currency;
  const modes = { revenue: ["Revenu", m.revenueByCountry ?? {}, v => money(v, c)], subscribers: ["Abonnés actifs", m.activeByCountry ?? {}, v => `${v} abonnés`] };
  state.mapMode ??= "revenue";
  const [label, values, fmt] = modes[state.mapMode];
  const known = Object.entries(values).filter(([k]) => k !== "??");
  el.innerHTML = `<div class="row section" style="justify-content:space-between"><div class="row seg">${Object.entries(modes).map(([k, v]) => `<button class="small ${state.mapMode === k ? "primary" : ""}" data-mode="${k}">${v[0]}</button>`).join("")}</div>
    <span class="muted">${known.length} pays · ${label.toLowerCase()} sur ${state.days} j</span></div>
    <div class="card"><div id="map" class="mapwrap"><div class="empty">Chargement de la carte…</div></div></div>
    <div class="grid2" style="margin-top:12px"><div class="card"><h3>Classement des pays</h3><table>${topRows(values, fmt, 15)}</table></div>
    <div class="card"><h3>À savoir</h3><p class="muted">Le pays vient du storefront App Store, de la région Google Play ou de l'adresse de facturation Stripe. Les ventes antérieures à cette fonctionnalité apparaissent en « Inconnu ».</p></div></div>`;
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { state.mapMode = b.dataset.mode; tabMap(el); });
  await worldMap($("#map"), Object.fromEntries(known), { fmt });
}

async function tabCohorts(el) {
  const { cohorts, currency } = await api(`/v1/projects/${state.projectId}/cohorts?months=12`);
  if (!cohorts.length) { el.innerHTML = `<div class="card empty">Les cohortes apparaissent dès les premiers paiements.</div>`; return; }
  const cols = cohorts[0].retention.length;
  const cell = v => `<td style="text-align:center;background:rgba(0,208,132,${(v * 0.85).toFixed(2)});color:${v > .45 ? "#001a10" : "inherit"}">${Math.round(v * 100)}%</td>`;
  el.innerHTML = `<div class="card section"><h2>Rétention des payeurs</h2><p class="muted">Part des clients d'une cohorte (mois du 1er paiement) qui paient encore N mois plus tard.</p>
    <div style="overflow-x:auto"><table><thead><tr><th>Cohorte</th><th>Clients</th>${Array.from({ length: cols }, (_, i) => `<th style="text-align:center">M${i}</th>`).join("")}</tr></thead>
    <tbody>${cohorts.map(r => `<tr><td>${r.month}</td><td>${r.size}</td>${r.retention.map((v, i) => i <= monthsSince(r.month) ? cell(v) : "<td></td>").join("")}</tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h2>Revenu cumulé par client</h2><p class="muted">LTV réelle observée par cohorte.</p><div style="overflow-x:auto"><table><thead><tr><th>Cohorte</th>${Array.from({ length: cols }, (_, i) => `<th style="text-align:right">M${i}</th>`).join("")}</tr></thead>
    <tbody>${cohorts.map(r => `<tr><td>${r.month}</td>${r.cumulativeRevenuePerUserMicros.map((v, i) => `<td style="text-align:right">${i <= monthsSince(r.month) ? money(v, currency) : ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
}
const monthsSince = m => { const [y, mo] = m.split("-").map(Number); const n = new Date(); return (n.getUTCFullYear() - y) * 12 + n.getUTCMonth() + 1 - mo; };

// ── App Store intelligence ────────────────────────────────────────────
const CHART = { free: "Gratuites", paid: "Payantes", grossing: "Revenus" };
async function tabAppStore(el) {
  const { apps } = await api(`/v1/projects/${state.projectId}/appstore`);
  el.innerHTML = `<div class="row section"><input id="q" placeholder="Ajouter une app : nom ou identifiant App Store (la tienne ou un concurrent)…"><button class="primary" style="flex:0" id="search">Chercher</button>
    ${apps.length ? `<button style="flex:0;white-space:nowrap" id="refresh">↻ Scanner</button>` : ""}</div><div id="results"></div>
    ${apps.length ? apps.map(a => `<div class="card section">
      <div class="row" style="align-items:center;gap:14px"><img src="${esc(a.icon ?? "")}" alt="" class="appicon"><div style="flex:1"><h2 style="margin:0">${esc(a.name ?? a.appId)} ${a.own === false ? '<span class="pill">concurrent</span>' : ""}</h2>
        <p class="muted" style="margin:2px 0">${esc(a.developer ?? "")} · ${esc(a.genreName ?? "")} · ${a.rating ? "★ " + a.rating.toFixed(2) + " (" + (a.ratingCount ?? 0).toLocaleString("fr-FR") + " notes)" : "pas encore de notes"}</p></div>
        <div style="text-align:right;flex:0;white-space:nowrap"><div class="v" style="font-size:24px;font-weight:750">${a.countriesRanked ?? 0}</div><div class="muted small">pays classés</div></div>
        <div style="text-align:right;flex:0;white-space:nowrap"><div class="v" style="font-size:24px;font-weight:750">${a.bestRank ? "#" + a.bestRank : "—"}</div><div class="muted small">meilleur rang</div></div></div>
      <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:6px">${(a.topRankings ?? []).map(r => `<span class="pill ok">${flag(r.cc)} #${r.rank} ${CHART[r.chart]}${r.scope === "genre" ? " · catégorie" : ""}${r.prevRank && r.prevRank !== r.rank ? (r.prevRank > r.rank ? " ▲" + (r.prevRank - r.rank) : " ▼" + (r.rank - r.prevRank)) : ""}</span>`).join("") || '<span class="muted">Pas encore classée — le scan tourne toutes les heures (25 grands marchés) et couvre les 177 pays en 6 h.</span>'}</div>
      <div class="row" style="margin-top:12px;gap:6px"><button class="small" data-ranks="${esc(a.appId)}">Tous les classements & carte</button><button class="small" data-reviews="${esc(a.appId)}">Avis</button><button class="small danger" data-untrack="${esc(a.appId)}">Ne plus suivre</button></div>
      <div id="ranks-${esc(a.appId)}"></div></div>`).join("") : `<div class="card empty">Ajoute ton app (et tes concurrents) pour suivre leurs classements dans 177 pays, recevoir des alertes et partager tes victoires.</div>`}`;
  const save = async list => { await api(`/v1/projects/${state.projectId}/appstore`, { method: "PUT", body: { apps: list } }); toast("Enregistré — premier scan en cours (≈1 min)"); setTimeout(() => tabAppStore(el), 1500); };
  const tracked = apps.map(a => ({ appId: a.appId, own: a.own !== false }));
  $("#search").onclick = async () => {
    const term = $("#q").value.trim(); if (!term) return;
    const results = /^\d{6,}$/.test(term) ? [{ appId: term, name: `App ${term}` }] : (await api(`/v1/appstore/search?term=${encodeURIComponent(term)}&country=fr`)).results;
    $("#results").innerHTML = `<div class="card section"><table>${results.map(r => `<tr><td style="width:44px">${r.icon ? `<img src="${esc(r.icon)}" class="appicon sm" alt="">` : ""}</td><td><b>${esc(r.name)}</b><div class="muted">${esc(r.developer ?? "")} · ${esc(r.genreName ?? "")}</div></td>
      <td style="text-align:right;white-space:nowrap"><button class="small primary" data-add="${esc(r.appId)}" data-own="1">C'est mon app</button> <button class="small" data-add="${esc(r.appId)}" data-own="0">Concurrent</button></td></tr>`).join("") || `<tr><td class="muted">Aucun résultat</td></tr>`}</table></div>`;
    document.querySelectorAll("[data-add]").forEach(b => b.onclick = () => save([...tracked.filter(t => t.appId !== b.dataset.add), { appId: b.dataset.add, own: b.dataset.own === "1" }]));
  };
  $("#q").onkeydown = e => { if (e.key === "Enter") $("#search").click(); };
  if ($("#refresh")) $("#refresh").onclick = async () => { await api(`/v1/projects/${state.projectId}/appstore/refresh`, { method: "POST" }); toast("Scan lancé"); };
  document.querySelectorAll("[data-untrack]").forEach(b => b.onclick = () => confirm("Arrêter de suivre cette app ?") && save(tracked.filter(t => t.appId !== b.dataset.untrack)));
  document.querySelectorAll("[data-reviews]").forEach(b => b.onclick = () => { state.reviewApp = b.dataset.reviews; go({ tab: "reviews" }); });
  document.querySelectorAll("[data-ranks]").forEach(b => b.onclick = () => showRanks(apps.find(a => a.appId === b.dataset.ranks), $(`#ranks-${b.dataset.ranks}`)));
}

function sparkline(history) {
  const pts = (history ?? []).filter(h => h.r != null);
  if (pts.length < 2) return "";
  const W = 90, H = 24, t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1, max = Math.max(...pts.map(p => p.r)), min = Math.min(...pts.map(p => p.r));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${((p.t - t0) / (t1 - t0 || 1) * W).toFixed(1)},${(((p.r - min) / (max - min || 1)) * (H - 4) + 2).toFixed(1)}`).join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>`;
}

async function showRanks(app, box) {
  const { ranks } = await api(`/v1/projects/${state.projectId}/appstore/${app.appId}/ranks`);
  state.rankChart ??= "free"; state.rankScope ??= "all";
  const rows = ranks.filter(r => r.chart === state.rankChart && r.scope === state.rankScope && r.rank != null).sort((a, b) => a.rank - b.rank);
  const best = {};
  for (const r of ranks) if (r.rank != null && r.chart === state.rankChart && r.scope === state.rankScope) best[r.cc] = 101 - r.rank;
  box.innerHTML = `<div class="row" style="margin:14px 0 8px;gap:6px;flex-wrap:wrap">${Object.entries(CHART).map(([k, v]) => `<button class="small ${state.rankChart === k ? "primary" : ""}" data-chart="${k}">${v}</button>`).join("")}
      <span style="width:12px"></span>${[["all", "Toutes les apps"], ["genre", esc(app.genreName ?? "Catégorie")]].map(([k, v]) => `<button class="small ${state.rankScope === k ? "primary" : ""}" data-scope="${k}">${v}</button>`).join("")}</div>
    <div class="mapwrap" id="rmap-${app.appId}"></div>
    <table><thead><tr><th>Pays</th><th>Rang</th><th>Évolution</th><th>Meilleur</th><th>Tendance</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td>${flag(r.cc)} ${esc(countryName(r.cc))}</td><td><b>#${r.rank}</b></td>
      <td>${r.prevRank == null ? '<span class="pill ok">nouveau</span>' : r.prevRank > r.rank ? `<span class="up">▲ ${r.prevRank - r.rank}</span>` : r.prevRank < r.rank ? `<span class="down">▼ ${r.rank - r.prevRank}</span>` : "="}</td>
      <td>#${r.bestRank ?? r.rank}</td><td>${sparkline(r.history)}</td><td><button class="small" data-share="${esc(r.cc)}|${r.rank}">Partager</button></td></tr>`).join("") || `<tr><td class="muted" colspan="6">Pas classée dans ce classement pour l'instant.</td></tr>`}</tbody></table>`;
  box.querySelectorAll("[data-chart]").forEach(b => b.onclick = () => { state.rankChart = b.dataset.chart; showRanks(app, box); });
  box.querySelectorAll("[data-scope]").forEach(b => b.onclick = () => { state.rankScope = b.dataset.scope; showRanks(app, box); });
  box.querySelectorAll("[data-share]").forEach(b => b.onclick = () => { const [cc, rank] = b.dataset.share.split("|"); shareCard(app, { cc, rank: Number(rank), chart: state.rankChart, scope: state.rankScope }); });
  await worldMap($(`#rmap-${app.appId}`), best, { fmt: v => `#${101 - v}`, color: "#0093e7" });
}

/** Achievement card (1080×1350 PNG) — Toplify-style social proof. */
async function shareCard(app, r) {
  const cv = Object.assign(document.createElement("canvas"), { width: 1080, height: 1350 });
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 1080, 1350); grad.addColorStop(0, "#04150f"); grad.addColorStop(1, "#07090b");
  g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
  try {
    const img = new Image(); img.crossOrigin = "anonymous"; img.src = app.icon;
    await img.decode();
    g.save(); g.beginPath(); g.roundRect(390, 170, 300, 300, 66); g.clip(); g.drawImage(img, 390, 170, 300, 300); g.restore();
  } catch { /* icon without CORS: card still works */ }
  g.textAlign = "center"; g.fillStyle = "#eef3f1";
  g.font = "700 64px -apple-system, Inter, system-ui"; g.fillText(app.name ?? "", 540, 580);
  g.font = "900 300px -apple-system, Inter, system-ui"; g.fillStyle = "#00d084"; g.fillText(`#${r.rank}`, 540, 900);
  g.fillStyle = "#eef3f1"; g.font = "600 58px -apple-system, Inter, system-ui";
  g.fillText(`${flag(r.cc)} ${countryName(r.cc)}`, 540, 1010);
  g.fillStyle = "#8a9a95"; g.font = "500 44px -apple-system, Inter, system-ui";
  g.fillText(`App Store · ${CHART[r.chart]}${r.scope === "genre" ? " · " + (app.genreName ?? "") : ""}`, 540, 1085);
  g.font = "500 34px -apple-system, Inter, system-ui"; g.fillText(new Date().toLocaleDateString("fr-FR", { dateStyle: "long" }), 540, 1260);
  const url = cv.toDataURL("image/png");
  openModal(`<h2>Carte à partager</h2><img src="${url}" alt="" style="width:100%;border-radius:12px"><div class="row" style="margin-top:12px"><a class="btnlink primary" download="${esc(app.name ?? "app")}-${r.cc}-${r.rank}.png" href="${url}">Télécharger le PNG</a><button>Fermer</button></div>`);
}

async function tabReviews(el) {
  const { apps } = await api(`/v1/projects/${state.projectId}/appstore`);
  if (!apps.length) { el.innerHTML = `<div class="card empty">Ajoute une app dans l'onglet App Store pour suivre ses avis dans tous les pays.</div>`; return; }
  state.reviewApp = apps.some(a => a.appId === state.reviewApp) ? state.reviewApp : apps[0].appId;
  const qs = new URLSearchParams({ limit: "100", ...(state.reviewCountry ? { country: state.reviewCountry } : {}), ...(state.reviewRating ? { rating: state.reviewRating } : {}) });
  const [{ reviews }, { ratings }] = await Promise.all([
    api(`/v1/projects/${state.projectId}/appstore/${state.reviewApp}/reviews?${qs}`),
    api(`/v1/projects/${state.projectId}/appstore/${state.reviewApp}/ratings`),
  ]);
  const app = apps.find(a => a.appId === state.reviewApp);
  const dist = [5, 4, 3, 2, 1].map(n => [n, reviews.filter(r => r.rating === n).length]);
  el.innerHTML = `<div class="row section"><select id="rApp">${apps.map(a => `<option value="${esc(a.appId)}" ${a.appId === state.reviewApp ? "selected" : ""}>${esc(a.name ?? a.appId)}</option>`).join("")}</select>
    <select id="rCountry"><option value="">Tous les pays</option>${ratings.map(r => `<option value="${r.cc}" ${state.reviewCountry === r.cc ? "selected" : ""}>${flag(r.cc)} ${esc(countryName(r.cc))} (${r.count})</option>`).join("")}</select>
    <select id="rRating"><option value="">Toutes les notes</option>${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${String(state.reviewRating) === String(n) ? "selected" : ""}>${"★".repeat(n)}</option>`).join("")}</select></div>
    <div class="grid2 section"><div class="card"><h3>Notes par pays</h3><table>${ratings.slice(0, 12).map(r => `<tr><td>${flag(r.cc)} ${esc(countryName(r.cc))}</td><td>★ ${r.average?.toFixed(2) ?? "—"}</td><td style="text-align:right">${r.count.toLocaleString("fr-FR")}</td></tr>`).join("") || `<tr><td class="muted">Pas encore de notes</td></tr>`}</table></div>
    <div class="card"><h3>Répartition (avis affichés)</h3>${dist.map(([n, c]) => `<div class="row" style="gap:8px;margin:4px 0"><span style="flex:0;width:60px">${"★".repeat(n)}</span><div style="flex:1;height:8px;background:var(--panel2);border-radius:4px"><div style="height:8px;border-radius:4px;background:var(--accent);width:${reviews.length ? (c / reviews.length * 100).toFixed(0) : 0}%"></div></div><span style="flex:0;width:32px;text-align:right">${c}</span></div>`).join("")}</div></div>
    ${reviews.map(r => `<div class="card section review" data-id="${esc(r.id)}"><div class="row" style="justify-content:space-between"><b>${"★".repeat(r.rating)}<span class="muted">${"★".repeat(5 - r.rating)}</span> ${esc(r.title)}</b><span class="muted" style="flex:0;white-space:nowrap">${flag(r.country)} ${date(r.at)} · v${esc(r.version)}</span></div>
      <p class="rtext">${esc(r.content)}</p><div class="row" style="gap:6px;justify-content:space-between"><span class="muted">— ${esc(r.author)}</span><span class="row" style="flex:0;gap:6px"><button class="small" data-tr="${esc(r.id)}">Traduire</button><button class="small" data-sr="${esc(r.id)}">Partager</button></span></div></div>`).join("") || `<div class="card empty">Aucun avis récupéré pour ce filtre (scan toutes les 6 h).</div>`}`;
  $("#rApp").onchange = e => { state.reviewApp = e.target.value; state.reviewCountry = ""; tabReviews(el); };
  $("#rCountry").onchange = e => { state.reviewCountry = e.target.value; tabReviews(el); };
  $("#rRating").onchange = e => { state.reviewRating = e.target.value; tabReviews(el); };
  el.querySelectorAll("[data-tr]").forEach(b => b.onclick = async () => {
    const t = await api(`/v1/projects/${state.projectId}/appstore/${state.reviewApp}/reviews/${b.dataset.tr}/translate`, { method: "POST", body: { target: "fr" } });
    const card = b.closest(".review"); card.querySelector("b").lastChild.textContent = " " + t.title; card.querySelector(".rtext").textContent = t.content; b.disabled = true; b.textContent = `Traduit (${t.from ?? "?"} → fr)`;
  });
  el.querySelectorAll("[data-sr]").forEach(b => b.onclick = () => reviewCard(app, reviews.find(r => r.id === b.dataset.sr), b.closest(".review")));
}

async function reviewCard(app, r, node) {
  const cv = Object.assign(document.createElement("canvas"), { width: 1080, height: 1080 }), g = cv.getContext("2d");
  g.fillStyle = "#07090b"; g.fillRect(0, 0, 1080, 1080);
  g.fillStyle = "#ffb020"; g.font = "700 70px -apple-system, system-ui"; g.textAlign = "center"; g.fillText("★".repeat(r.rating), 540, 200);
  const title = node.querySelector("b").lastChild.textContent.trim(), body = node.querySelector(".rtext").textContent;
  g.fillStyle = "#eef3f1"; g.font = "700 54px -apple-system, system-ui"; g.fillText(`“${title}”`.slice(0, 40), 540, 320);
  g.font = "400 40px -apple-system, system-ui"; g.fillStyle = "#c9d4d0";
  const words = body.split(/\s+/); let line = "", y = 420;
  for (const w of words) { if (g.measureText(line + w).width > 900) { g.fillText(line, 540, y); line = ""; y += 56; if (y > 840) { line = "…"; break; } } line += w + " "; }
  g.fillText(line, 540, y);
  g.fillStyle = "#8a9a95"; g.font = "500 36px -apple-system, system-ui"; g.fillText(`${r.author} · ${flag(r.country)} · ${app.name ?? ""}`, 540, 980);
  const url = cv.toDataURL("image/png");
  openModal(`<h2>Avis à partager</h2><img src="${url}" alt="" style="width:100%;border-radius:12px"><div class="row" style="margin-top:12px"><a class="btnlink primary" download="avis-${esc(r.id)}.png" href="${url}">Télécharger le PNG</a><button>Fermer</button></div>`);
}

const ALERT = { NEW_COUNTRY: "🌍 Nouveau pays", TOP_100: "📈 Retour dans le top 100", TOP_10: "🏆 Top 10", TOP_1: "🥇 Numéro 1", JUMP: "🚀 Forte hausse", DROP: "📉 Forte baisse", LEFT_CHART: "Sortie du classement" };
const alertRow = a => `<tr><td>${ALERT[a.type] ?? esc(a.type)}</td><td>${a.appIcon ? `<img src="${esc(a.appIcon)}" class="appicon xs" alt=""> ` : ""}${esc(a.appName ?? a.appId)}${a.own === false ? ' <span class="pill">concurrent</span>' : ""}${a.projectName ? ` <span class="muted">· ${esc(a.projectName)}</span>` : ""}</td>
  <td>${flag(a.cc)} ${esc(countryName(a.cc))}</td><td>${CHART[a.chart] ?? ""}${a.scope === "genre" ? " · catégorie" : ""}</td><td><b>${a.rank ? "#" + a.rank : "—"}</b>${a.prevRank ? ` <span class="muted">(avant #${a.prevRank})</span>` : ""}</td><td>${date(a.at)}</td></tr>`;
async function tabAlerts(el) {
  const { alerts } = await api(`/v1/projects/${state.projectId}/alerts?limit=200`);
  el.innerHTML = `<div class="card">${alerts.length ? `<table><thead><tr><th>Alerte</th><th>App</th><th>Pays</th><th>Classement</th><th>Rang</th><th>Date</th></tr></thead><tbody>${alerts.map(alertRow).join("")}</tbody></table>`
    : `<div class="empty">Aucune alerte pour l'instant. Tu seras prévenu ici (et sur Slack/Discord/webhooks si connectés) quand une app entre dans un nouveau pays, le top 10, le top 1 ou bouge fortement.</div>`}</div>`;
}

// ── Connections & integrations ─────────────────────────────────────────
async function tabConnect(el) {
  const p = await api(`/v1/projects/${state.projectId}`);
  const ok = b => b ? `<span class="pill ok">connecté</span>` : `<span class="pill warn">à connecter</span>`;
  const integ = p.credentials.integrations ?? [];
  const agentPrompt = `Intègre MoneyMaker (abonnements) dans cette app en suivant ${location.origin}/llms.txt.
Projet: ${p.id}
Base URL: ${location.origin}/v1
Clé publique SDK: <colle ta clé mm_pub_ ici>
Accès à vérifier: ${Object.keys(p.config.entitlements)[0] ?? "premium"}
Remplace toute logique RevenueCat/StoreKit existante, appelle MoneyMaker.configure au lancement, logIn avec l'id utilisateur, purchase() depuis le paywall, et verrouille les écrans premium avec isEntitled.`;
  el.innerHTML = `<div class="card section"><h2>⚡ Brancher le SDK : demande à ton agent</h2><p class="muted">Colle ce prompt dans Claude Code / Cursor / Codex à la racine de ton app.</p><pre>${esc(agentPrompt)}</pre>
    <div class="row" style="margin-top:10px"><button class="primary" style="flex:0" onclick='mmCopy(${esc(JSON.stringify(agentPrompt))})'>Copier le prompt</button><a href="/docs" style="flex:0;white-space:nowrap">Documentation →</a></div></div>
  <div class="grid2">
    <div class="card"><h2>Stripe ${ok(p.credentials.stripeKey && p.credentials.stripeWebhook)}</h2><p class="muted">Colle une clé secrète (ou restreinte avec accès webhooks, abonnements, factures, clients, Checkout). MoneyMaker crée le webhook tout seul et importe tes abonnements + 12 mois de factures.</p>
      <div class="row"><input id="stripeKey" placeholder="sk_live_… ou rk_live_…" autocomplete="off"><button class="primary" style="flex:0;white-space:nowrap" id="cStripe">Connecter</button></div><div id="stripeOut"></div></div>
    <div class="card"><h2>App Store Connect ${ok(p.credentials.appStoreConnect)}</h2><p class="muted">Clé API App Store Connect (Utilisateurs et accès → Intégrations → API, rôle App Manager). MoneyMaker lit l'app, importe les produits, active le suivi des classements et règle l'URL des notifications serveur si elle est vide.</p>
      <div class="row"><input id="ascIss" placeholder="Issuer ID"><input id="ascKid" placeholder="Key ID"><input id="ascApp" placeholder="Apple ID de l'app" value="${esc(p.config.apple?.appAppleId ?? "")}"></div>
      <textarea id="ascKey" style="min-height:70px;margin-top:8px" placeholder="-----BEGIN PRIVATE KEY----- (fichier .p8)"></textarea>
      <label class="row" style="gap:8px;margin:8px 0"><input type="checkbox" id="ascForce" style="width:auto;flex:0"> Remplacer l'URL de notifications existante</label>
      <button class="primary" id="cAsc">Connecter</button><div id="ascOut"></div>
      <p class="muted" style="margin-top:10px">URL des notifications serveur V2 :</p>${copyRow(p.endpoints.appleNotifications)}</div>
    <div class="card"><h2>Google Play ${ok(p.credentials.google)}</h2><p class="muted">Compte de service avec accès « Finances » dans Play Console. MoneyMaker vérifie l'accès et importe les abonnements.</p>
      <input id="gPkg" placeholder="com.example.app" value="${esc(p.config.google?.packageName ?? "")}"><textarea id="gSa2" style="min-height:70px;margin-top:8px" placeholder='{"type":"service_account",…}'></textarea>
      <button class="primary" id="cGoogle" style="margin-top:8px">Connecter</button><div id="gOut"></div>
      <p class="muted" style="margin-top:10px">Notifications en temps réel : crée un abonnement Pub/Sub <b>push</b> vers :</p>${copyRow(p.endpoints.googleRtdn, true)}</div>
    <div class="card"><h2>Tes backends ${ok(p.config.webhooks.length)}</h2><p class="muted">Webhooks signés <code>MoneyMaker-Signature</code> pour chaque événement d'abonnement et chaque alerte de classement (<code>RANKING_*</code>). URLs dans Réglages. Secret de signature :</p>${copyRow(p.webhookSigningSecret, true)}</div>
  </div>
  <div class="card" style="margin-top:12px"><h2>Intégrations</h2><p class="muted">Les événements d'abonnement partent vers ces outils, et les alertes de classement vers Slack et Discord. Laisse un champ vide pour ne rien changer, ou tape <code>-</code> pour déconnecter.</p>
    <div class="grid2">
      ${[["slackWebhookUrl", "Slack — Incoming Webhook URL", "https://hooks.slack.com/services/…"], ["discordWebhookUrl", "Discord — Webhook URL", "https://discord.com/api/webhooks/…"],
         ["mixpanelToken", "Mixpanel — Project token", "token"], ["amplitudeApiKey", "Amplitude — API key", "api key"], ["segmentWriteKey", "Segment — Write key", "write key"], ["posthogKey", "PostHog — Project API key (EU par défaut)", "phc_…"]]
        .map(([k, label, ph]) => `<div class="field"><label>${label} ${integ.includes(k === "posthogKey" ? "posthog" : k) ? '<span class="pill ok">actif</span>' : ""}</label><input data-integ="${k}" placeholder="${ph}" autocomplete="off"></div>`).join("")}
      <div class="field"><label>AppsFlyer — App ID iOS / Android ${p.credentials.appsflyer ? '<span class="pill ok">actif</span>' : ""}</label><div class="row"><input id="afApp" placeholder="id123456789" value="${esc(p.config.integrations?.appsflyer?.appId ?? "")}"><input id="afAndroid" placeholder="com.example.app" value="${esc(p.config.integrations?.appsflyer?.androidAppId ?? "")}"></div></div>
      <div class="field"><label>AppsFlyer — Dev key</label><input id="afKey" placeholder="dev key" autocomplete="off"></div>
    </div><button class="primary" id="saveInteg">Enregistrer les intégrations</button></div>`;
  const out = (id, html) => $(id).innerHTML = `<div class="notice">${html}</div>`;
  const busy = async (btn, fn) => { btn.disabled = true; const t = btn.textContent; btn.textContent = "…"; try { await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = t; } };
  $("#cStripe").onclick = e => busy(e.target, async () => {
    const r = await api(`/v1/projects/${state.projectId}/connect/stripe`, { method: "POST", body: { secretKey: $("#stripeKey").value.trim() } });
    $("#stripeKey").value = ""; out("#stripeOut", `✅ ${esc(r.account)} (${r.livemode ? "live" : "test"}) · webhook créé · ${r.importedSubscriptions} abonnements et ${r.importedInvoices} factures importés`);
  });
  $("#cAsc").onclick = e => busy(e.target, async () => {
    const r = await api(`/v1/projects/${state.projectId}/connect/appstore`, { method: "POST", body: { issuerId: $("#ascIss").value.trim(), keyId: $("#ascKid").value.trim(), privateKey: $("#ascKey").value.trim(), appAppleId: $("#ascApp").value.trim(), setNotificationUrl: $("#ascForce").checked ? true : undefined } });
    $("#ascKey").value = ""; out("#ascOut", `✅ ${esc(r.app.name)} (${esc(r.app.bundleId)}) · ${r.importedProducts.length} produits importés · ${r.notificationsConfigured ? "notifications serveur réglées sur MoneyMaker" : `notifications laissées sur ${esc(r.previousNotificationUrls.production ?? "—")} (coche « Remplacer » pour basculer)`} · suivi des classements activé`);
  });
  $("#cGoogle").onclick = e => busy(e.target, async () => {
    const r = await api(`/v1/projects/${state.projectId}/connect/google`, { method: "POST", body: { packageName: $("#gPkg").value.trim(), serviceAccount: $("#gSa2").value.trim() } });
    $("#gSa2").value = ""; out("#gOut", `✅ ${esc(r.packageName)} · ${r.importedProducts.length} abonnements importés · compte ${esc(r.serviceAccount)}`);
  });
  $("#saveInteg").onclick = e => busy(e.target, async () => {
    const integrations = {};
    el.querySelectorAll("[data-integ]").forEach(i => {
      const v = i.value.trim(); if (!v) return;
      const val = v === "-" ? null : v;
      if (i.dataset.integ === "posthogKey") integrations.posthog = val ? { apiKey: val } : null; else integrations[i.dataset.integ] = val;
    });
    const body = {};
    if (Object.keys(integrations).length) body.integrations = integrations;
    if ($("#afKey").value.trim()) body.appsflyer = { devKey: $("#afKey").value.trim() };
    if (Object.keys(body).length) await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body });
    if ($("#afApp").value.trim() || $("#afAndroid").value.trim()) await api(`/v1/projects/${state.projectId}`, { method: "PATCH", body: { config: { integrations: { appsflyer: { appId: $("#afApp").value.trim(), androidAppId: $("#afAndroid").value.trim() || undefined } } } } });
    toast("Intégrations enregistrées"); tabConnect(el);
  });
}

const statusPill = s => `<span class="pill ${["active"].includes(s) ? "ok" : ["grace", "billing_retry", "paused"].includes(s) ? "warn" : "bad"}">${esc(s)}</span>`;
async function tabCustomers(el) {
  el.innerHTML = `<div class="row section"><input id="cid" placeholder="Rechercher un appUserId exact…"><button class="primary" style="flex:0" id="find">Ouvrir</button>
    <label class="row" style="flex:0;white-space:nowrap"><input type="checkbox" id="paying" style="width:auto"> payants</label></div><div id="list" class="card"></div>`;
  $("#find").onclick = () => $("#cid").value.trim() && customerDialog($("#cid").value.trim());
  const load = async () => {
    const { customers } = await api(`/v1/projects/${state.projectId}/customers?limit=100${$("#paying").checked ? "&paying=true" : ""}`);
    $("#list").innerHTML = customers.length ? `<table><thead><tr><th>Client</th><th>Accès</th><th>Payant</th><th>Dépensé</th><th>Vu</th></tr></thead><tbody>${customers.map(c =>
      `<tr class="click" data-c="${esc(c.id)}"><td class="mono">${esc(c.id)}</td><td>${(c.activeEntitlements ?? []).map(e => `<span class="pill ok">${esc(e)}</span>`).join(" ") || "—"}</td><td>${c.isPaying ? "✓" : ""}</td><td>${c.totalSpentMicros ? money(c.totalSpentMicros) : "—"}</td><td>${date(c.lastSeenAt)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">Aucun client pour l'instant. Ils apparaissent dès que le SDK est branché.</div>`;
    document.querySelectorAll("[data-c]").forEach(r => r.onclick = () => customerDialog(r.dataset.c));
  };
  $("#paying").onchange = load; await load();
}

async function customerDialog(id) {
  const c = await api(`/v1/projects/${state.projectId}/customers/${encodeURIComponent(id)}`);
  const p = state.projects.find(x => x.id === state.projectId);
  const ents = Object.keys(p.config?.entitlements ?? {});
  openModal(`<h2 class="mono">${esc(id)}</h2>
    <h3>Accès</h3><p>${Object.values(c.entitlements).map(e => `<span class="pill ${e.active ? "ok" : "bad"}">${esc(e.id)} ${e.active ? "actif" : "inactif"}</span> <span class="muted">jusqu'au ${e.expiresAt ? date(e.expiresAt) : "à vie"}</span>`).join("<br>") || "Aucun"}</p>
    <h3>Achats</h3><table>${c.purchases.map(x => `<tr><td>${esc(x.store)}</td><td class="mono">${esc(x.productId)}</td><td>${statusPill(x.status)}${x.isSandbox ? ' <span class="pill">sandbox</span>' : ""}</td><td>${x.expiresAt ? date(x.expiresAt) : "à vie"}</td></tr>`).join("") || `<tr><td class="muted">Aucun</td></tr>`}</table>
    <h3 style="margin-top:14px">Historique</h3><table>${c.events.slice(0, 30).map(e => `<tr><td>${esc(e.type)}</td><td class="mono">${esc(e.productId)}</td><td>${date(e.at)}</td></tr>`).join("") || `<tr><td class="muted">—</td></tr>`}</table>
    ${ents.length ? `<h3 style="margin-top:14px">Offrir un accès</h3><div class="row"><select id="gEnt">${ents.map(e => `<option>${esc(e)}</option>`).join("")}</select><input id="gDays" type="number" placeholder="jours (vide = à vie, 0 = retirer)"><button type="button" class="primary" id="grant">Appliquer</button></div>` : ""}
    <div class="row" style="margin-top:16px"><button>Fermer</button></div>`);
  if (ents.length) $("#grant").onclick = async () => {
    const d = $("#gDays").value;
    await api(`/v1/projects/${state.projectId}/customers/${encodeURIComponent(id)}/grant`, { method: "POST", body: { entitlement: $("#gEnt").value, ...(d !== "" ? { days: Number(d) } : {}) } });
    toast("Accès mis à jour"); customerDialog(id);
  };
}

async function tabEvents(el) {
  const { events } = await api(`/v1/projects/${state.projectId}/events?limit=200`);
  el.innerHTML = `<div class="card">${events.length ? `<table><thead><tr><th>Événement</th><th>Client</th><th>Produit</th><th>Store</th><th>Montant</th><th>Date</th><th>Webhook</th></tr></thead><tbody>${events.map(e =>
    `<tr><td><b>${esc(e.type)}</b>${e.isSandbox ? ' <span class="pill">sandbox</span>' : ""}</td><td class="mono click" data-c="${esc(e.appUserId)}">${esc(e.appUserId)}</td><td class="mono">${esc(e.productId)}</td><td>${esc(e.store)}</td><td>${e.priceMicros ? money(e.priceMicros, e.currency) : ""}</td><td>${date(e.at)}</td><td>${e.delivered ? "✓" : e.deliveryErrors?.length ? `<span class="pill bad" title="${esc(e.deliveryErrors.join(", "))}">échec</span>` : "…"}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">Aucun événement. Achats, renouvellements, annulations et remboursements s'afficheront ici en temps réel.</div>`}</div>`;
  document.querySelectorAll("td[data-c]").forEach(r => r.onclick = () => customerDialog(r.dataset.c));
}

async function tabProducts(el) {
  const p = await api(`/v1/projects/${state.projectId}`);
  const cfg = p.config;
  el.innerHTML = `<div class="card section"><h2>Accès (entitlements)</h2><p class="muted">Un accès = ce que l'utilisateur débloque. Liste les identifiants produits (App Store, Play, Stripe price/lookup_key) qui le donnent. <code>*</code> = n'importe quel produit.</p>
    <textarea id="ent">${esc(JSON.stringify(cfg.entitlements, null, 2))}</textarea></div>
    <div class="card section"><h2>Offres (paywall)</h2><p class="muted">Ce que le SDK renvoie via <code>offerings()</code> : modifie ton paywall sans republier l'app.</p>
    <textarea id="off" style="min-height:220px">${esc(JSON.stringify(Object.keys(cfg.offerings).length ? cfg.offerings : { default: { description: "Paywall principal", packages: [
      { id: "monthly", productIds: { app_store: "com.example.monthly", play_store: "monthly", stripe: "price_xxx" } },
      { id: "annual", productIds: { app_store: "com.example.annual", play_store: "annual" }, metadata: { badge: "-40 %" } }] } }, null, 2))}</textarea>
    <div class="field" style="margin-top:10px"><label>Offre courante</label><input id="cur" value="${esc(cfg.currentOffering ?? "")}" placeholder="default"></div></div>
    <button class="primary" id="saveP">Enregistrer</button>`;
  $("#saveP").onclick = async () => {
    try {
      await api(`/v1/projects/${state.projectId}`, { method: "PATCH", body: { config: { entitlements: JSON.parse($("#ent").value), offerings: JSON.parse($("#off").value), currentOffering: $("#cur").value || undefined } } });
      await loadProjects(); toast("Enregistré");
    } catch (e) { toast(e.message); }
  };
}

async function tabSettings(el) {
  const p = await api(`/v1/projects/${state.projectId}`);
  const c = p.config;
  el.innerHTML = `<div class="grid2">
  <div class="card"><h2>Général</h2>
    <div class="field"><label>Nom</label><input id="name" value="${esc(p.name)}"></div>
    <div class="field"><label>Devise de reporting</label><input id="currency" value="${esc(c.currency)}" maxlength="3"></div>
    <div class="field"><label>Bundle ID iOS</label><input id="bundle" value="${esc(c.apple?.bundleId ?? "")}" placeholder="com.example.app"></div>
    <div class="field"><label>Apple ID de l'app (numérique, requis en production)</label><input id="appleId" value="${esc(c.apple?.appAppleId ?? "")}" placeholder="6123456789"></div>
    <div class="field"><label>Package Android</label><input id="pkg" value="${esc(c.google?.packageName ?? "")}" placeholder="com.example.app"></div>
    <div class="field"><label>Webhooks sortants (une URL https par ligne)</label><textarea id="hooks" style="min-height:70px">${esc(c.webhooks.map(w => w.url).join("\n"))}</textarea></div>
    <div class="row"><button class="primary" id="saveS">Enregistrer</button><button id="testHook">Tester les webhooks</button></div></div>
  <div class="card"><h2>Identifiants des stores</h2><p class="muted">Chiffrés côté serveur, jamais renvoyés au navigateur.</p>
    <div class="field"><label>Apple Issuer ID · Key ID</label><div class="row"><input id="aIss" placeholder="Issuer ID"><input id="aKid" placeholder="Key ID"></div></div>
    <div class="field"><label>Clé .p8 (contenu)</label><textarea id="aKey" style="min-height:70px" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
    <div class="field"><label>Google : JSON du compte de service</label><textarea id="gSa" style="min-height:70px" placeholder='{"type":"service_account",…}'></textarea></div>
    <div class="field"><label>Stripe : clé secrète/restreinte · secret webhook</label><div class="row"><input id="sKey" placeholder="rk_live_…"><input id="sWh" placeholder="whsec_…"></div></div>
    <button class="primary" id="saveC">Enregistrer les identifiants</button></div></div>
  <div class="card" style="margin-top:12px"><h2>Clés API</h2><p class="muted">Clé publique (<code>mm_pub_</code>) : dans tes apps. Clé secrète (<code>mm_sk_</code>) : uniquement sur tes serveurs. Elles ne sont affichées qu'une fois.</p>
    <div class="row"><button id="kPub">Nouvelle clé publique</button><button id="kSec">Nouvelle clé secrète</button><button id="kRot" class="danger">Révoquer et régénérer la secrète</button></div><div id="newKey" style="margin-top:10px"></div></div>`;
  $("#saveS").onclick = async () => {
    try {
      await api(`/v1/projects/${state.projectId}`, { method: "PATCH", body: { name: $("#name").value, config: {
        currency: $("#currency").value.toUpperCase(), apple: { bundleId: $("#bundle").value || undefined, appAppleId: $("#appleId").value || undefined },
        google: { packageName: $("#pkg").value || undefined },
        webhooks: $("#hooks").value.split("\n").map(s => s.trim()).filter(Boolean).map((url, i) => ({ id: `wh_${i}`, url })) } } });
      await loadProjects(); toast("Enregistré");
    } catch (e) { toast(e.message); }
  };
  $("#testHook").onclick = async () => { await api(`/v1/projects/${state.projectId}/webhooks/test`, { method: "POST" }); toast("Événement TEST envoyé — voir l'onglet Événements"); };
  $("#saveC").onclick = async () => {
    const body = {};
    if ($("#aKey").value.trim()) body.apple = { issuerId: $("#aIss").value.trim(), keyId: $("#aKid").value.trim(), privateKey: $("#aKey").value.trim() };
    if ($("#gSa").value.trim()) body.google = { serviceAccount: $("#gSa").value.trim() };
    if ($("#sKey").value.trim() || $("#sWh").value.trim()) body.stripe = { secretKey: $("#sKey").value.trim() || undefined, webhookSecret: $("#sWh").value.trim() || undefined };
    try { const r = await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body }); toast(`Mis à jour : ${r.updated.join(", ") || "rien"}`); el.querySelectorAll("textarea, #aIss, #aKid, #sKey, #sWh").forEach(i => { if (i.id !== "hooks") i.value = ""; }); }
    catch (e) { toast(e.message); }
  };
  const key = async (kind, revokeExisting = false) => {
    if (revokeExisting && !confirm("Les anciennes clés secrètes cesseront de fonctionner immédiatement. Continuer ?")) return;
    const r = await api(`/v1/projects/${state.projectId}/keys`, { method: "POST", body: { kind, revokeExisting } });
    $("#newKey").innerHTML = `<p class="muted">Copie-la maintenant :</p>${copyRow(r.key)}`;
  };
  $("#kPub").onclick = () => key("public"); $("#kSec").onclick = () => key("secret"); $("#kRot").onclick = () => key("secret", true);
}

// ── Account / tokens ────────────────────────────────────────────────────
async function renderAccount(main) {
  main.innerHTML = `<div class="head"><div><h1>Compte & accès</h1><p class="muted">${esc(auth.currentUser.email ?? auth.currentUser.uid)}</p></div></div>
  <div class="card section"><h2>Jeton personnel (app iPhone, widgets, agents, scripts)</h2>
    <p class="muted">Un jeton <code>mm_pat_</code> lit tous tes business. Colle-le dans l'app MoneyMaker sur iPhone pour les widgets, ou donne-le à ton agent pour qu'il crée et configure des projets.</p>
    <div class="row"><input id="label" placeholder="Nom du jeton (ex. iPhone)"><button class="primary" style="flex:0;white-space:nowrap" id="mk">Créer un jeton</button></div><div id="tok" style="margin-top:12px"></div></div>
  <div class="card"><h2>API</h2><p class="muted">Base URL :</p>${copyRow(location.origin + "/v1")}<p><a href="/docs">Documentation</a> · <a href="/llms.txt">llms.txt (pour agents)</a></p></div>`;
  $("#mk").onclick = async () => { const r = await api("/v1/tokens", { method: "POST", body: { label: $("#label").value || "token" } }); $("#tok").innerHTML = `<p class="muted">Affiché une seule fois :</p>${copyRow(r.token)}`; };
}

// ── Modals ──────────────────────────────────────────────────────────────
function openModal(html) { $("#modalBody").innerHTML = html; if (!$("#modal").open) $("#modal").showModal(); }
function newProjectDialog() {
  openModal(`<h2>Nouveau business</h2><div class="field"><label>Nom</label><input id="pName" placeholder="ex. V2" required></div>
    <div class="field"><label>Devise</label><input id="pCur" value="EUR" maxlength="3"></div>
    <div class="row"><button value="cancel">Annuler</button><button type="button" class="primary" id="pCreate">Créer</button></div>`);
  $("#pCreate").onclick = async () => {
    const r = await api("/v1/projects", { method: "POST", body: { name: $("#pName").value, config: { currency: $("#pCur").value.toUpperCase(), entitlements: { premium: ["*"] } } } });
    await loadProjects();
    openModal(`<h2>✅ Business créé</h2><p class="muted">Copie la clé secrète maintenant : elle ne sera plus jamais affichée.</p>
      <div class="field"><label>Clé publique (apps)</label>${copyRow(r.publicKey)}</div><div class="field"><label>Clé secrète (serveurs)</label>${copyRow(r.secretKey)}</div>
      <div class="row"><button type="button" class="primary" id="goSetup">Brancher mes stores →</button></div>`);
    $("#goSetup").onclick = () => { $("#modal").close(); go({ view: "project", projectId: r.projectId, tab: "connect" }); };
  };
}
