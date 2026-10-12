import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { tabGrowth } from "./growth.js";

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
const loginFail = e => { $("#loginError").textContent = e.message; document.querySelectorAll(".wl-field").forEach(f => { f.classList.remove("is-shake"); void f.offsetWidth; f.classList.add("is-shake"); }); };
$("#emailForm").onsubmit = e => { e.preventDefault(); signInWithEmailAndPassword(auth, $("#email").value, $("#password").value).catch(loginFail); };
$("#signup").onclick = () => createUserWithEmailAndPassword(auth, $("#email").value, $("#password").value).catch(loginFail);
$("#logout").onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  $("#login").classList.toggle("hidden", Boolean(user));
  $("#app").classList.toggle("hidden", !user);
  if (user) { await acceptPendingInvite(); await loadProjects(); route(); }
});

async function loadProjects() {
  state.projects = (await api("/v1/projects")).projects;
  $("#projectNav").innerHTML = state.projects.map(p => `<button class="nav" data-project="${esc(p.id)}">${esc(p.name)}</button>`).join("");
  document.querySelectorAll("[data-project]").forEach(b => b.onclick = () => openProject(b.dataset.project));
}
document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => go({ view: b.dataset.view, projectId: null }));
$("#newProject").onclick = newProjectDialog;

function go(patch) { Object.assign(state, patch); history.replaceState(null, "", state.projectId ? `#${state.projectId}/${state.tab}` : `#${state.view}`); route(); }
function route() {
  if (!state.projectId && location.hash.includes("/")) { const [pid, tab, cust] = location.hash.slice(1).split("/"); if (state.projects.some(p => p.id === pid)) Object.assign(state, { view: "project", projectId: pid, tab, openCustomer: cust ? decodeURIComponent(cust) : null }); }
  document.querySelectorAll(".nav").forEach(b => b.classList.toggle("active", b.dataset.view === state.view && !state.projectId || b.dataset.project === state.projectId));
  const main = $("#main");
  main.innerHTML = `<div class="empty">Chargement…</div>`;
  const render = state.view === "project" ? renderProject : state.view === "account" ? renderAccount : renderOverview;
  render(main).catch(e => main.innerHTML = `<div class="empty error">${esc(e.message)}</div>`);
}

// ── Charts (dependency-free SVG) ────────────────────────────────────────
let chartSeq = 0;
// Courbe lissée (Catmull-Rom → Bézier), dégradé bleu → accent, halo flou, aire en fondu.
function smoothPath(pts) {
  return pts.map((p, i) => {
    if (!i) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    const p0 = pts[i - 2] ?? pts[i - 1], p1 = pts[i - 1], p3 = pts[i + 1] ?? p;
    const c1 = [p1[0] + (p[0] - p0[0]) / 6, p1[1] + (p[1] - p0[1]) / 6], c2 = [p[0] - (p3[0] - p1[0]) / 6, p[1] - (p3[1] - p1[1]) / 6];
    return `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  }).join("");
}
function lineChart(points, cur, color = "var(--accent)", fmt = null) {
  if (points.length < 2) return `<div class="empty">Pas encore assez d'historique — le graphique se remplit chaque jour.</div>`;
  const id = `c${++chartSeq}`;
  const W = 600, H = 220, P = 10, max = Math.max(1, ...points.map(p => p.v)) * 1.08, min = Math.min(0, ...points.map(p => p.v));
  const x = i => P + (i / (points.length - 1)) * (W - 2 * P), y = v => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const xy = points.map((p, i) => [x(i), y(p.v)]);
  const d = smoothPath(xy);
  const accent = color === "var(--accent)" ? "#00F19F" : color;
  const grid = [0.25, 0.5, 0.75].map(f => `<line x1="0" x2="${W}" y1="${(H * f).toFixed(0)}" y2="${(H * f).toFixed(0)}" stroke="rgba(255,255,255,.05)" stroke-dasharray="2 5" vector-effect="non-scaling-stroke"/>`).join("");
  const step = (W - 2 * P) / (points.length - 1);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="graphique">
    <defs>
      <linearGradient id="${id}s" x1="0" x2="1"><stop offset="0" stop-color="#2E8BFF"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".26"/><stop offset=".6" stop-color="#2E8BFF" stop-opacity=".05"/><stop offset="1" stop-color="#2E8BFF" stop-opacity="0"/></linearGradient>
      <filter id="${id}g" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>
    ${grid}
    <path d="${d}L${x(points.length - 1)},${H}L${x(0)},${H}Z" fill="url(#${id}f)"/>
    <path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="5" opacity=".7" filter="url(#${id}g)"/>
    <path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="2.2" stroke-linecap="round" vector-effect="non-scaling-stroke" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="animation:mmDraw 1.4s cubic-bezier(.16,1,.3,1) forwards"/>
    ${xy.map(([cx, cy], i) => `<g><rect class="hit" x="${(cx - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="transparent"><title>${esc(points[i].label)} · ${esc(fmt ? fmt(points[i].v) : money(points[i].v, cur))}</title></rect><g class="dot" opacity="0" pointer-events="none" style="transition:opacity .15s"><line x1="${cx}" x2="${cx}" y1="0" y2="${H}" stroke="rgba(255,255,255,.3)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/><circle cx="${cx}" cy="${cy}" r="9" fill="${accent}" opacity=".25"/><circle cx="${cx}" cy="${cy}" r="4" fill="#fff"/></g></g>`).join("")}
  </svg>`;
}
function barChart(byDay, days, cur) {
  const id = `c${++chartSeq}`;
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const k = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); out.push({ label: k, v: byDay[k] ?? 0 }); }
  const W = 600, H = 220, max = Math.max(1, ...out.map(p => p.v)), bw = W / out.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="revenus par jour">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00F19F"/><stop offset="1" stop-color="#2E8BFF" stop-opacity=".25"/></linearGradient></defs>
    ${out.map((p, i) => {
    const h = Math.max(p.v > 0 ? 2 : 0, (Math.max(0, p.v) / max) * (H - 4));
    return `<rect x="${i * bw + bw * 0.18}" y="${H - h}" width="${Math.max(1, bw * 0.64)}" height="${h}" rx="${Math.min(4, bw * 0.3)}" fill="url(#${id})" style="transform-origin:bottom;transform-box:fill-box;animation:mmBarUp .8s cubic-bezier(.16,1,.3,1) ${(i * 12)}ms both"><title>${p.label} · ${esc(money(p.v, cur))}</title></rect>`;
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
  document.querySelectorAll("[data-open]").forEach(r => r.onclick = () => openProject(r.dataset.open));
}

// ── Project ─────────────────────────────────────────────────────────────
const TABS = { start: "Démarrage", metrics: "Métriques", map: "Carte", cohorts: "Cohortes", charts: "Graphiques", appstore: "App Store", reviews: "Avis", alerts: "Alertes", customers: "Clients", events: "Événements", products: "Produits & accès", growth: "Paywalls & tests", connect: "Connexions", settings: "Réglages" };
async function renderProject(main) {
  const p = state.projects.find(x => x.id === state.projectId);
  if (!TABS[state.tab]) state.tab = "metrics";
  main.innerHTML = `<div class="head"><div><h1>${esc(p?.name)}</h1><p class="muted mono">${esc(state.projectId)}</p></div>${["metrics", "map"].includes(state.tab) ? daysPicker() : ""}</div>
    <div class="tabs">${Object.entries(TABS).map(([k, v]) => `<button class="small ${state.tab === k ? "active" : ""}" data-tab="${k}">${v}</button>`).join("")}</div><div id="tab"></div>`;
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => go({ tab: b.dataset.tab }));
  bindDays();
  await ({ start: tabStart, metrics: tabMetrics, map: tabMap, cohorts: tabCohorts, charts: tabCharts, appstore: tabAppStore, reviews: tabReviews, alerts: tabAlerts, customers: tabCustomers, events: tabEvents, products: tabProducts, growth: el => tabGrowth(el, { api, esc, toast, money, pct, date, projectId: state.projectId, reload: loadProjects }), connect: tabConnect, settings: tabSettings }[state.tab] ?? tabMetrics)($("#tab"));
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

// ── Getting started (auto-detected checklist) ─────────────────────────
async function openProject(id) {
  const setup = await api(`/v1/projects/${id}/setup`).catch(() => null);
  go({ view: "project", projectId: id, tab: setup && setup.progress < 1 ? "start" : "metrics" });
}

async function tabStart(el) {
  const s = await api(`/v1/projects/${state.projectId}/setup`);
  const groups = [...new Set(s.steps.map(x => x.group))];
  const pctDone = Math.round(s.progress * 100);
  el.innerHTML = `<div class="card section"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${pctDone === 100 ? "✅ Tout est branché" : "Mise en route"}</h2><b style="flex:0">${pctDone} %</b></div>
    <div class="bar"><div style="width:${pctDone}%"></div></div>
    <p class="muted">Chaque étape se coche toute seule dès que MoneyMaker détecte qu'elle fonctionne. ${s.next ? "Prochaine étape surlignée." : "Les étapes bonus restent optionnelles."} <a href="/guide" target="_blank">Guide pas à pas →</a></p></div>
    ${groups.map(g => `<h3 style="margin:18px 0 8px">${esc(g)}</h3>${s.steps.filter(x => x.group === g).map(x => `<div class="card step ${x.id === s.next ? "next" : ""} ${x.done ? "done" : ""}">
      <div class="row" style="align-items:flex-start"><span class="check" style="flex:0">${x.done ? "✓" : ""}</span>
      <div style="flex:1"><b>${esc(x.title)}</b>${x.optional ? ' <span class="pill">optionnel</span>' : ""}${x.detail ? ` <span class="muted">· ${esc(x.detail)}</span>` : ""}<p class="muted" style="margin:4px 0 0">${esc(x.help)}</p></div>
      ${x.done ? "" : `<button class="small ${x.id === s.next ? "primary" : ""}" style="flex:0;white-space:nowrap" data-goto="${x.tab}">Faire →</button>`}</div></div>`).join("")}`).join("")}
    <div class="row" style="margin-top:12px"><button id="recheck" style="flex:0">↻ Revérifier</button></div>`;
  el.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => go({ tab: b.dataset.goto }));
  $("#recheck").onclick = () => tabStart(el);
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
    <div class="row" style="margin-top:10px"><button class="primary" style="flex:0" onclick='mmCopy(${esc(JSON.stringify(agentPrompt))})'>Copier le prompt</button><a href="/guide" style="flex:0;white-space:nowrap">Guide pas à pas →</a></div></div>
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
    <div class="card"><h2>Migrer depuis RevenueCat</h2><p class="muted">Importe les abonnements et achats en cours de tous tes clients. Clé secrète RevenueCat (Project settings → API keys). Avec une clé v2, tout est listé automatiquement ; avec une ancienne clé v1, colle la liste de tes ids utilisateurs (un par ligne).</p>
      <input id="rcKey" placeholder="sk_…" autocomplete="off"><textarea id="rcIds" style="min-height:60px;margin-top:8px" placeholder="ids utilisateurs (seulement pour une clé v1)"></textarea>
      <button class="primary" id="rcImport" style="margin-top:8px">Importer</button><div id="rcOut"></div></div>
    <div class="card"><h2>Paddle Billing ${ok(p.credentials.paddle)}</h2><p class="muted">Paddle → Developer tools → Notifications : crée une destination vers l'URL ci-dessous (événements <code>subscription.*</code> et <code>transaction.completed</code>), puis colle sa clé secrète. Passe l'id utilisateur dans <code>customData.app_user_id</code> au checkout Paddle.js.</p>
      ${copyRow(p.endpoints.paddleWebhook ?? `${location.origin}/v1/webhooks/paddle/${p.id}`)}
      <input id="pdSecret" placeholder="Clé secrète de la destination (pdl_ntfset_…)" autocomplete="off" style="margin-top:8px"><input id="pdKey" placeholder="Clé API (optionnelle, pdl_…)" autocomplete="off" style="margin-top:8px">
      <label class="row" style="gap:8px;margin:8px 0"><input type="checkbox" id="pdSandbox" style="width:auto;flex:0"> Environnement sandbox</label>
      <button class="primary" id="cPaddle">Enregistrer</button><div id="pdOut"></div></div>
    <div class="card"><h2>Amazon Appstore ${ok(p.credentials.amazon)}</h2><p class="muted">Clé partagée (Developer Console → Shared Key) : MoneyMaker vérifie chaque reçu auprès du Receipt Verification Service. Notifications en temps réel : App Services → Real-Time Notifications → ajoute l'URL ci-dessous, puis colle dans la console le jeton de confirmation qui s'affiche ici à réception.</p>
      ${copyRow(p.endpoints.amazonNotifications ?? "", true)}${p.amazonConfirmationToken ? `<p class="muted" style="margin-top:8px">Jeton de confirmation :</p>${copyRow(p.amazonConfirmationToken)}` : ""}
      <input id="amzSecret" placeholder="Clé partagée" autocomplete="off" style="margin-top:8px"><input id="amzPkg" placeholder="com.example.app (optionnel)" style="margin-top:8px">
      <label class="row" style="gap:8px;margin:8px 0"><input type="checkbox" id="amzSandbox" style="width:auto;flex:0"> Accepter le sandbox (App Tester)</label>
      <button class="primary" id="cAmazon">Enregistrer</button><div id="amzOut"></div></div>
    <div class="card"><h2>Samsung Galaxy Store ${ok(p.credentials.galaxy)}</h2><p class="muted">Seller Portal → Assistance → API Service : crée un compte de service (scope <code>publishing</code>). Requis pour les abonnements ; les achats uniques sont vérifiés via <code>iap/v6/receipt</code>.</p>
      <input id="gsSa" placeholder="Service account ID" autocomplete="off"><input id="gsPkg" placeholder="com.example.app" style="margin-top:8px"><textarea id="gsKey" style="min-height:60px;margin-top:8px" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>
      <button class="primary" id="cGalaxy" style="margin-top:8px">Enregistrer</button><div id="gsOut"></div></div>
    <div class="card"><h2>Roku Pay ${ok(p.credentials.roku)}</h2><p class="muted">Developer Dashboard → Roku Pay web services → clé API. Colle l'URL ci-dessous comme endpoint des notifications push.</p>
      ${copyRow(p.endpoints.rokuNotifications ?? "", true)}
      <input id="rkKey" placeholder="Clé API web services" autocomplete="off" style="margin-top:8px">
      <button class="primary" id="cRoku" style="margin-top:8px">Enregistrer</button><div id="rkOut"></div></div>
    <div class="card"><h2>Tes backends ${ok(p.config.webhooks.length)}</h2><p class="muted">Webhooks signés <code>MoneyMaker-Signature</code> pour chaque événement d'abonnement et chaque alerte de classement (<code>RANKING_*</code>). URLs dans Réglages. Secret de signature :</p>${copyRow(p.webhookSigningSecret, true)}</div>
  </div>
  <div class="card" style="margin-top:12px"><h2>Intégrations</h2><p class="muted">Les événements d'abonnement partent vers ces outils, et les alertes de classement vers Slack et Discord. Laisse un champ vide pour ne rien changer, ou tape <code>-</code> pour déconnecter.</p>
    <div class="grid2">
      ${[["slackWebhookUrl", "Slack — Incoming Webhook URL", "https://hooks.slack.com/services/…"], ["discordWebhookUrl", "Discord — Webhook URL", "https://discord.com/api/webhooks/…"],
         ["mixpanelToken", "Mixpanel — Project token", "token"], ["amplitudeApiKey", "Amplitude — API key", "api key"], ["segmentWriteKey", "Segment — Write key", "write key"], ["posthogKey", "PostHog — Project API key (EU par défaut)", "phc_…"]]
        .map(([k, label, ph]) => `<div class="field"><label>${label} ${integ.includes(k === "posthogKey" ? "posthog" : k) ? '<span class="pill ok">actif</span>' : ""}</label><input data-integ="${k}" placeholder="${ph}" autocomplete="off"></div>`).join("")}
      <div class="field"><label>AppsFlyer — App ID iOS / Android ${p.credentials.appsflyer ? '<span class="pill ok">actif</span>' : ""}</label><div class="row"><input id="afApp" placeholder="id123456789" value="${esc(p.config.integrations?.appsflyer?.appId ?? "")}"><input id="afAndroid" placeholder="com.example.app" value="${esc(p.config.integrations?.appsflyer?.androidAppId ?? "")}"></div></div>
      <div class="field"><label>AppsFlyer — Dev key</label><input id="afKey" placeholder="dev key" autocomplete="off"></div>
    </div><button class="primary" id="saveInteg">Enregistrer les intégrations</button></div>
  <div class="card" style="margin-top:12px"><h2>Intégrations serveur (attribution &amp; CRM)</h2><p class="muted">Envoi serveur à serveur de chaque événement d'abonnement, avec les identifiants envoyés par le SDK en attributs (<code>$idfa</code>, <code>$gpsAdId</code>, <code>$fbAnonId</code>, <code>$adjustId</code>, <code>$firebaseAppInstanceId</code>, <code>$onesignalId</code>…). Les champs vides gardent la valeur enregistrée ; coche « Déconnecter » pour retirer. Les événements sandbox sont ignorés sauf si « Sandbox » est coché.</p>
    <div class="grid2">${MM_CONNECTORS.map(([k, name, fields]) => `<details class="field" data-conn="${k}"><summary><b>${name}</b> ${integ.includes(k) ? '<span class="pill ok">actif</span>' : ""}</summary>
      ${fields.map(([f, label, ph]) => `<label class="muted">${label}</label>${f === "eventTokens" ? `<textarea data-f="${f}" style="min-height:60px" placeholder="${ph}"></textarea>` : `<input data-f="${f}" placeholder="${esc(ph)}" autocomplete="off">`}`).join("")}
      <label class="row" style="gap:8px"><input type="checkbox" data-f="sandbox" style="width:auto;flex:0"> Sandbox</label>
      <label class="row" style="gap:8px"><input type="checkbox" data-f="_remove" style="width:auto;flex:0"> Déconnecter</label></details>`).join("")}</div>
    <p class="muted">Apple Search Ads : rien à configurer. Le SDK envoie le jeton AdServices en attribut <code>$appleAdsToken</code>, MoneyMaker récupère campagne / groupe / mot-clé (fiche client, et « revenueByCampaign » dans les métriques).</p>
    <button class="primary" id="saveConn">Enregistrer les intégrations serveur</button></div>
  <div class="card" style="margin-top:12px"><h2>Exports programmés ${ok((p.config.exports ?? []).length)}</h2><p class="muted">Fichiers incrémentaux (depuis le dernier export réussi) chaque jour à 03:00 UTC, ou le lundi pour « hebdo ». L'e-mail n'est pas encore disponible (aucun fournisseur d'envoi) : choisis S3, GCS ou webhook.</p>
    <div id="exList">${(p.config.exports ?? []).map(x => `<div class="row"><span class="pill ${p.credentials.exports?.includes(x.id) || x.destination === "webhook" ? "ok" : "warn"}">${esc(x.id)}</span><span>${esc(x.destination)} · ${x.schedule === "weekly" ? "hebdo" : "quotidien"} · ${esc(x.format)} · ${x.datasets.map(esc).join(", ")}</span><button style="flex:0" data-exdel="${esc(x.id)}">Supprimer</button></div>`).join("") || '<p class="muted">Aucun export.</p>'}</div>
    <div class="row"><input id="exId" placeholder="identifiant (ex. s3-quotidien)"><select id="exDest"><option value="s3">Amazon S3</option><option value="gcs">Google Cloud Storage</option><option value="webhook">Webhook</option><option value="email">E-mail (bientôt)</option></select>
      <select id="exSched"><option value="daily">Quotidien</option><option value="weekly">Hebdo</option></select><select id="exFmt"><option value="csv">CSV</option><option value="jsonl">JSONL</option></select></div>
    <div class="row">${["transactions", "events", "customers", "subscriptions"].map(d => `<label class="row" style="gap:6px;flex:0;white-space:nowrap"><input type="checkbox" data-exds="${d}" checked style="width:auto"> ${d}</label>`).join("")}</div>
    <div class="row"><input id="exBucket" placeholder="bucket (S3 / GCS)"><input id="exRegion" placeholder="région S3 (eu-west-3)"><input id="exPrefix" placeholder="préfixe (optionnel)"></div>
    <div class="row"><input id="exAk" placeholder="S3 Access key ID" autocomplete="off"><input id="exSk" placeholder="S3 Secret access key" autocomplete="off"></div>
    <input id="exUrl" placeholder="URL webhook https://… (signée MoneyMaker-Signature)"><input id="exTo" placeholder="e-mail destinataire">
    <textarea id="exSa" style="min-height:60px" placeholder='GCS : compte de service {"type":"service_account",…}'></textarea>
    <button class="primary" id="exAdd">Ajouter l'export</button></div>`;
  const out = (id, html) => $(id).innerHTML = `<div class="notice">${html}</div>`;
  const busy = async (btn, fn) => { btn.disabled = true; const t = btn.textContent; btn.textContent = "…"; try { await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = t; } };
  $("#cStripe").onclick = e => busy(e.target, async () => {
    const r = await api(`/v1/projects/${state.projectId}/connect/stripe`, { method: "POST", body: { secretKey: $("#stripeKey").value.trim() } });
    $("#stripeKey").value = ""; out("#stripeOut", `✅ ${esc(r.account)} (${r.livemode ? "live" : "test"}) · webhook créé · ${r.importedSubscriptions} abonnements et ${r.importedInvoices} factures importés`);
  });
  $("#cAmazon").onclick = e => busy(e.target, async () => {
    const amazon = { sharedSecret: $("#amzSecret").value.trim() || undefined, packageName: $("#amzPkg").value.trim() || undefined, allowSandbox: $("#amzSandbox").checked };
    await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body: { amazon } });
    $("#amzSecret").value = ""; out("#amzOut", "✅ Amazon Appstore enregistré");
  });
  $("#cGalaxy").onclick = e => busy(e.target, async () => {
    const galaxy = { serviceAccountId: $("#gsSa").value.trim() || undefined, packageName: $("#gsPkg").value.trim() || undefined, privateKey: $("#gsKey").value.trim() || undefined };
    await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body: { galaxy } });
    $("#gsKey").value = ""; out("#gsOut", "✅ Galaxy Store enregistré");
  });
  $("#cRoku").onclick = e => busy(e.target, async () => {
    await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body: { roku: { devApiKey: $("#rkKey").value.trim() } } });
    $("#rkKey").value = ""; out("#rkOut", "✅ Roku Pay enregistré");
  });
  $("#cPaddle").onclick = e => busy(e.target, async () => {
    const paddle = { webhookSecret: $("#pdSecret").value.trim() || undefined, apiKey: $("#pdKey").value.trim() || undefined, environment: $("#pdSandbox").checked ? "sandbox" : "production" };
    await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body: { paddle } });
    $("#pdSecret").value = ""; $("#pdKey").value = ""; out("#pdOut", "✅ Paddle enregistré");
  });
  $("#cAsc").onclick = e => busy(e.target, async () => {
    const r = await api(`/v1/projects/${state.projectId}/connect/appstore`, { method: "POST", body: { issuerId: $("#ascIss").value.trim(), keyId: $("#ascKid").value.trim(), privateKey: $("#ascKey").value.trim(), appAppleId: $("#ascApp").value.trim(), setNotificationUrl: $("#ascForce").checked ? true : undefined } });
    $("#ascKey").value = ""; out("#ascOut", `✅ ${esc(r.app.name)} (${esc(r.app.bundleId)}) · ${r.importedProducts.length} produits importés · ${r.notificationsConfigured ? "notifications serveur réglées sur MoneyMaker" : `notifications laissées sur ${esc(r.previousNotificationUrls.production ?? "—")} (coche « Remplacer » pour basculer)`} · suivi des classements activé`);
  });
  $("#cGoogle").onclick = e => busy(e.target, async () => {
    const r = await api(`/v1/projects/${state.projectId}/connect/google`, { method: "POST", body: { packageName: $("#gPkg").value.trim(), serviceAccount: $("#gSa2").value.trim() } });
    $("#gSa2").value = ""; out("#gOut", `✅ ${esc(r.packageName)} · ${r.importedProducts.length} abonnements importés · compte ${esc(r.serviceAccount)}`);
  });
  $("#rcImport").onclick = e => busy(e.target, async () => {
    const ids = $("#rcIds").value.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    const { jobId } = await api(`/v1/projects/${state.projectId}/import/revenuecat`, { method: "POST", body: { secretKey: $("#rcKey").value.trim(), appUserIds: ids } });
    $("#rcKey").value = ""; out("#rcOut", "Import en cours…");
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const j = await api(`/v1/projects/${state.projectId}/import/${jobId}`);
      if (j.status === "done") { out("#rcOut", `✅ ${j.result.customers} clients analysés · ${j.result.purchases} achats importés`); return; }
      if (j.status === "failed") { out("#rcOut", `❌ ${esc(j.error)}`); return; }
      out("#rcOut", `Import ${j.status === "running" ? "en cours" : "en file d'attente"}…`);
    }
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
  $("#saveConn").onclick = e => busy(e.target, async () => {
    const integrations = {};
    el.querySelectorAll("[data-conn]").forEach(d => {
      const k = d.dataset.conn, cfg = {}; let touched = false;
      d.querySelectorAll("[data-f]").forEach(i => {
        if (i.type === "checkbox") { if (i.dataset.f === "sandbox" && (i.checked || integ.includes(k))) cfg.sandbox = i.checked; return; }
        const v = i.value.trim(); if (!v) return; touched = true;
        cfg[i.dataset.f] = i.dataset.f === "eventTokens" ? Object.fromEntries(v.split(/\n+/).map(l => l.split(/[=:\s]+/).map(x => x.trim())).filter(x => x[0] && x[1])) : v;
      });
      if (d.querySelector('[data-f="_remove"]').checked) integrations[k] = null;
      else if (touched || (integ.includes(k) && "sandbox" in cfg)) integrations[k] = cfg;
    });
    if (!Object.keys(integrations).length) return toast("Rien à enregistrer");
    await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body: { integrations } });
    toast("Intégrations serveur enregistrées"); tabConnect(el);
  });
  const saveExports = list => api(`/v1/projects/${state.projectId}`, { method: "PATCH", body: { config: { exports: list } } });
  el.querySelectorAll("[data-exdel]").forEach(b => b.onclick = () => busy(b, async () => {
    await saveExports((p.config.exports ?? []).filter(x => x.id !== b.dataset.exdel));
    await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body: { exports: { [b.dataset.exdel]: null } } });
    toast("Export supprimé"); await loadProjects(); tabConnect(el);
  }));
  $("#exAdd").onclick = e => busy(e.target, async () => {
    const dest = $("#exDest").value, id = $("#exId").value.trim(), v = s => $(s).value.trim();
    const x = { id, destination: dest, schedule: $("#exSched").value, format: $("#exFmt").value, datasets: [...el.querySelectorAll("[data-exds]:checked")].map(i => i.dataset.exds) };
    if (dest === "s3") x.s3 = { bucket: v("#exBucket"), region: v("#exRegion"), prefix: v("#exPrefix") };
    if (dest === "gcs") x.gcs = { bucket: v("#exBucket"), prefix: v("#exPrefix") };
    if (dest === "webhook") x.webhook = { url: v("#exUrl") };
    if (dest === "email") x.email = { to: v("#exTo") };
    const secrets = {};
    if (dest === "s3" && v("#exAk")) secrets.s3 = { accessKeyId: v("#exAk"), secretAccessKey: v("#exSk") };
    if (dest === "gcs" && v("#exSa")) secrets.gcs = { serviceAccount: v("#exSa") };
    if (Object.keys(secrets).length) await api(`/v1/projects/${state.projectId}/credentials`, { method: "PUT", body: { exports: { [id]: secrets } } });
    await saveExports([...(p.config.exports ?? []).filter(y => y.id !== id), x]);
    toast("Export enregistré"); await loadProjects(); tabConnect(el);
  });
}

/** Server-side connectors: [key, label, [[field, label, placeholder]]] — mirrors SCHEMA in backend integrations.ts. */
const MM_CONNECTORS = [
  ["meta", "Meta (Conversions API)", [["datasetId", "Dataset ID (ID de l'app / jeu de données)", "1234567890"], ["accessToken", "Jeton d'accès Conversions API", "EAAB…"], ["testEventCode", "Code d'événement test (optionnel)", "TEST123"]]],
  ["adjust", "Adjust", [["appToken", "App token", "abc123def456"], ["s2sToken", "Jeton S2S (Bearer)", "jeton S2S"], ["eventTokens", "Jetons d'événements (un par ligne)", "INITIAL_PURCHASE=abc123\nRENEWAL=def456\nTRIAL_STARTED=ghi789"]]],
  ["branch", "Branch", [["branchKey", "Branch key", "key_live_…"]]],
  ["singular", "Singular", [["sdkKey", "SDK key", "clé SDK"]]],
  ["kochava", "Kochava", [["appGuid", "App GUID", "komyapp-xxxx"]]],
  ["tenjin", "Tenjin", [["apiKey", "SDK / API key", "clé"]]],
  ["braze", "Braze", [["restEndpoint", "REST endpoint", "https://rest.fra-01.braze.eu"], ["apiKey", "Clé REST API (users.track)", "clé"]]],
  ["onesignal", "OneSignal", [["appId", "App ID", "xxxxxxxx-…"], ["restApiKey", "REST API key", "os_v2_app_…"]]],
  ["iterable", "Iterable", [["apiKey", "Server-side API key", "clé"], ["region", "Région (us / eu)", "us"]]],
  ["customerio", "Customer.io", [["siteId", "Site ID", "site id"], ["apiKey", "Track API key", "clé"], ["region", "Région (us / eu)", "us"]]],
  ["clevertap", "CleverTap", [["accountId", "Account ID", "XXX-XXX-XXXX"], ["passcode", "Passcode", "passcode"], ["region", "Région (eu1, us1, in1, sg1…)", "eu1"]]],
  ["airship", "Airship", [["appKey", "App key", "clé d'app"], ["token", "Bearer token", "jeton"], ["region", "Région (us / eu)", "us"]]],
  ["airbridge", "Airbridge", [["appName", "Nom de l'app Airbridge", "monapp"], ["apiToken", "Jeton API S2S", "jeton"]]],
  ["intercom", "Intercom", [["accessToken", "Access token", "dG9r…"], ["region", "Région (us / eu / au)", "us"]]],
  ["ga4", "Firebase / Google Analytics 4", [["firebaseAppId", "Firebase App ID (iOS)", "1:123:ios:abc"], ["androidFirebaseAppId", "Firebase App ID Android (optionnel)", "1:123:android:abc"], ["apiSecret", "Measurement Protocol API secret", "secret"]]],
  ["mparticle", "mParticle", [["apiKey", "Server key", "us1-…"], ["apiSecret", "Server secret", "secret"], ["pod", "Pod (us1, us2, eu1, au1)", "us1"]]],
  ["statsig", "Statsig", [["serverSecret", "Server secret key", "secret-…"]]],
  ["telemetrydeck", "TelemetryDeck", [["appId", "App ID", "XXXXXXXX-…"], ["namespace", "Namespace (optionnel)", "com.monapp"]]],
];

const statusPill = s => `<span class="pill ${["active"].includes(s) ? "ok" : ["grace", "billing_retry", "paused"].includes(s) ? "warn" : "bad"}">${esc(s)}</span>`;
async function tabCustomers(el) {
  el.innerHTML = `<div id="audBox" class="card section"></div><div class="row section"><input id="cid" placeholder="Rechercher un appUserId exact…"><button class="primary" style="flex:0" id="find">Ouvrir</button>
    <label class="row" style="flex:0;white-space:nowrap"><input type="checkbox" id="paying" style="width:auto"> payants</label></div><div id="list" class="card"></div>`;
  $("#find").onclick = () => $("#cid").value.trim() && customerDialog($("#cid").value.trim());
  // Lien profond #<pid>/customers/<appUserId> (ex. depuis l'app Stripe) : ouvre directement la fiche.
  if (state.openCustomer) { const c = state.openCustomer; state.openCustomer = null; customerDialog(c); }
  const load = async () => {
    const { customers } = await api(`/v1/projects/${state.projectId}/customers?limit=100${$("#paying").checked ? "&paying=true" : ""}`);
    $("#list").innerHTML = customers.length ? `<table><thead><tr><th>Client</th><th>Accès</th><th>Payant</th><th>Dépensé</th><th>Vu</th></tr></thead><tbody>${customers.map(c =>
      `<tr class="click" data-c="${esc(c.id)}"><td class="mono">${esc(c.id)}</td><td>${(c.activeEntitlements ?? []).map(e => `<span class="pill ok">${esc(e)}</span>`).join(" ") || "—"}</td><td>${c.isPaying ? "✓" : ""}</td><td>${c.totalSpentMicros ? money(c.totalSpentMicros) : "—"}</td><td>${date(c.lastSeenAt)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">Aucun client pour l'instant. Ils apparaissent dès que le SDK est branché.</div>`;
    document.querySelectorAll("[data-c]").forEach(r => r.onclick = () => customerDialog(r.dataset.c));
  };
  $("#paying").onchange = load; await load();
  audiencesSection($("#audBox")).catch(e => $("#audBox").innerHTML = `<div class="empty error">${esc(e.message)}</div>`);
}

// ── Audiences (segments enregistrés) ───────────────────────────────────────
const AUD_STATUS = { "": "Tous", active: "Abonné actif", trial: "En essai", churned: "Perdu", billing_issue: "Problème de paiement", never_paid: "Jamais payé" };
async function audiencesSection(box) {
  const pid = state.projectId;
  const { audiences = [] } = await api(`/v1/projects/${pid}/audiences`);
  const f = (state.audFilters ??= {});
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(v) === String(sel ?? "") ? "selected" : ""}>${esc(l)}</option>`;
  const d = t => t ? new Date(t).toISOString().slice(0, 10) : "";
  box.innerHTML = `<h2>Audiences</h2>
    ${audiences.length ? `<table><tbody>${audiences.map(a => `<tr><td><b>${esc(a.name)}</b> <span class="muted mono">${esc(a.id)}</span></td><td>${a.count ?? "—"} clients</td>
      <td style="text-align:right"><button class="small" data-audload="${esc(a.id)}">Modifier</button> <button class="small" data-audcsv="${esc(a.id)}">⬇︎ CSV</button> <button class="small danger" data-auddel="${esc(a.id)}">Supprimer</button></td></tr>`).join("")}</tbody></table>` : `<p class="muted">Aucune audience. Compose des filtres, prévisualise, puis enregistre.</p>`}
    <div class="row" style="flex-wrap:wrap;gap:8px;align-items:end;margin-top:12px">
      <div class="field"><label>Statut</label><select data-af="status">${Object.entries(AUD_STATUS).map(([v, l]) => opt(v, l, f.status)).join("")}</select></div>
      <div class="field"><label>Store</label><select data-af="store">${[["", "Tous"], ["app_store", "App Store"], ["play_store", "Google Play"], ["stripe", "Stripe"], ["paddle", "Paddle"], ["amazon", "Amazon"], ["galaxy", "Galaxy Store"], ["roku", "Roku"], ["promotional", "Promo"]].map(([v, l]) => opt(v, l, f.store)).join("")}</select></div>
      <div class="field"><label>Pays</label><input data-af="country" maxlength="2" placeholder="FR" value="${esc(f.country ?? "")}" style="width:70px"></div>
      <div class="field"><label>Produit</label><input data-af="productId" value="${esc(f.productId ?? "")}"></div>
      <div class="field"><label>Accès actif</label><input data-af="entitlement" value="${esc(f.entitlement ?? "")}"></div>
      <div class="field"><label>Vu après</label><input type="date" data-af="firstSeenAfter" value="${d(f.firstSeenAfter)}"></div>
      <div class="field"><label>Vu avant</label><input type="date" data-af="firstSeenBefore" value="${d(f.firstSeenBefore)}"></div>
      <div class="field"><label>Dépensé min.</label><input type="number" min="0" data-af="spentMin" value="${f.spentMinMicros != null ? f.spentMinMicros / 1e6 : ""}" style="width:90px"></div>
      <div class="field"><label>Attribut (clé=valeur)</label><input data-af="attr" placeholder="plan=pro" value="${esc(Object.entries(f.attributes ?? {}).map(([k, v]) => `${k}=${v}`).join(","))}"></div>
      <div class="field"><label>Campagne Apple Ads</label><input data-af="appleAdsCampaign" value="${esc(f.appleAdsCampaign ?? "")}" style="width:110px"></div>
      <button class="small" id="audPrev">Prévisualiser</button></div>
    <div class="row" style="margin-top:8px"><input id="audName" placeholder="Nom de l'audience" value="${esc(state.audEditing?.name ?? "")}"><button class="primary" id="audSave" style="flex:0;white-space:nowrap">${state.audEditing ? "Mettre à jour" : "Enregistrer l'audience"}</button></div>
    <div id="audOut"></div>`;
  const read = () => {
    const v = k => box.querySelector(`[data-af="${k}"]`).value.trim();
    const out = {};
    for (const k of ["status", "store", "productId", "entitlement", "appleAdsCampaign"]) if (v(k)) out[k] = v(k);
    if (v("country")) out.country = v("country").toUpperCase();
    if (v("firstSeenAfter")) out.firstSeenAfter = Date.parse(v("firstSeenAfter"));
    if (v("firstSeenBefore")) out.firstSeenBefore = Date.parse(v("firstSeenBefore"));
    if (v("spentMin")) out.spentMinMicros = Math.round(Number(v("spentMin")) * 1e6);
    if (v("attr")) out.attributes = Object.fromEntries(v("attr").split(",").map(p => p.split("=").map(x => x.trim())).filter(([k, val]) => k && val !== undefined));
    return (state.audFilters = out);
  };
  const saveAll = async list => {
    await api(`/v1/projects/${pid}`, { method: "PATCH", body: { config: { audiences: list.map(({ id, name, filters }) => ({ id, name, filters })) } } });
    await loadProjects(); state.audEditing = null; audiencesSection(box);
  };
  $("#audPrev").onclick = async () => {
    const r = await api(`/v1/projects/${pid}/audiences/preview`, { method: "POST", body: { filters: read() } });
    $("#audOut").innerHTML = `<p><b>${r.count}</b> clients${r.truncated ? " (sur les 20 000 plus récents)" : ""}.</p>${r.customers.length ? `<table><thead><tr><th>Client</th><th>Statut</th><th>Pays</th><th>Dépensé</th><th>Produits</th></tr></thead><tbody>${r.customers.map(c =>
      `<tr class="click" data-c="${esc(c.id)}"><td class="mono">${esc(c.id)}</td><td>${esc(AUD_STATUS[c.status] ?? c.status)}</td><td>${flag(c.country)} ${esc(c.country ?? "")}</td><td>${c.totalSpentMicros ? money(c.totalSpentMicros) : "—"}</td><td class="mono">${esc(c.products.join(", "))}</td></tr>`).join("")}</tbody></table>` : ""}`;
    box.querySelectorAll("[data-c]").forEach(r => r.onclick = () => customerDialog(r.dataset.c));
  };
  $("#audSave").onclick = async () => {
    const name = $("#audName").value.trim();
    if (!name) return toast("Donne un nom à l'audience");
    const filters = read(), editing = state.audEditing;
    const id = editing?.id ?? (name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "aud") + "_" + Date.now().toString(36);
    await saveAll(editing ? audiences.map(a => a.id === id ? { id, name, filters } : a) : [...audiences, { id, name, filters }]).then(() => toast("Audience enregistrée")).catch(e => toast(e.message));
  };
  box.querySelectorAll("[data-audload]").forEach(b => b.onclick = () => { const a = audiences.find(x => x.id === b.dataset.audload); state.audFilters = { ...a.filters }; state.audEditing = a; audiencesSection(box); });
  box.querySelectorAll("[data-auddel]").forEach(b => b.onclick = () => confirm("Supprimer cette audience ?") && saveAll(audiences.filter(a => a.id !== b.dataset.auddel)).catch(e => toast(e.message)));
  box.querySelectorAll("[data-audcsv]").forEach(b => b.onclick = async () => {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(`/v1/projects/${pid}/audiences/${encodeURIComponent(b.dataset.audcsv)}/customers?format=csv`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return toast("Export impossible");
    const a = document.createElement("a"); a.href = URL.createObjectURL(await res.blob()); a.download = `${b.dataset.audcsv}.csv`; a.click(); URL.revokeObjectURL(a.href);
  });
}

async function customerDialog(id) {
  const c = await api(`/v1/projects/${state.projectId}/customers/${encodeURIComponent(id)}`);
  const p = state.projects.find(x => x.id === state.projectId);
  const ents = Object.keys(p.config?.entitlements ?? {});
  openModal(`<h2 class="mono">${esc(id)}</h2>
    <h3>Accès</h3><p>${Object.values(c.entitlements).map(e => `<span class="pill ${e.active ? "ok" : "bad"}">${esc(e.id)} ${e.active ? "actif" : "inactif"}</span> <span class="muted">jusqu'au ${e.expiresAt ? date(e.expiresAt) : "à vie"}</span>`).join("<br>") || "Aucun"}</p>
    <h3>Achats</h3><table>${c.purchases.map(x => `<tr><td>${esc(x.store)}</td><td class="mono">${esc(x.productId)}</td><td>${statusPill(x.status)}${x.isSandbox ? ' <span class="pill">sandbox</span>' : ""}</td><td>${x.expiresAt ? date(x.expiresAt) : "à vie"}</td></tr>`).join("") || `<tr><td class="muted">Aucun</td></tr>`}</table>
    ${c.appleAds?.attribution ? `<h3 style="margin-top:14px">Apple Search Ads</h3><p class="mono">campagne ${esc(c.appleAds.campaignId)} · groupe ${esc(c.appleAds.adGroupId)} · mot-clé ${esc(c.appleAds.keywordId ?? "—")} · ${esc(c.appleAds.countryOrRegion ?? "")}</p>` : ""}
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
    <div class="field"><label>Site web (sert aussi d'icône au business quand il n'a pas d'app sur l'App Store)</label><input id="website" type="url" value="${esc(c.website ?? "")}" placeholder="https://monapp.com"></div>
    <div class="field"><label>Numéro de fournisseur App Store (téléchargements) — App Store Connect → Paiements et rapports financiers, en haut à gauche</label><input id="vendor" inputmode="numeric" value="${esc(c.apple?.vendorNumber ?? "")}" placeholder="87654321"></div>
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
    <div class="row"><button id="kPub">Nouvelle clé publique</button><button id="kTest" title="Clé mm_test_ : le SDK n'utilise ni StoreKit ni Google Play, les achats sont des achats sandbox (store « test »), exclus des métriques">Clé Test Store</button><button id="kSec">Nouvelle clé secrète</button><button id="kRot" class="danger">Révoquer et régénérer la secrète</button></div><div id="newKey" style="margin-top:10px"></div></div>`;
  $("#saveS").onclick = async () => {
    try {
      await api(`/v1/projects/${state.projectId}`, { method: "PATCH", body: { name: $("#name").value, config: {
        currency: $("#currency").value.toUpperCase(), website: $("#website").value.trim() || null, apple: { bundleId: $("#bundle").value || undefined, appAppleId: $("#appleId").value || undefined, vendorNumber: $("#vendor").value.trim() || undefined },
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
  $("#kPub").onclick = () => key("public"); $("#kTest").onclick = () => key("test"); $("#kSec").onclick = () => key("secret"); $("#kRot").onclick = () => key("secret", true);
  el.insertAdjacentHTML("beforeend", `<div class="card" style="margin-top:12px" id="team"></div>`);
  teamSection($("#team")).catch(e => { $("#team").innerHTML = `<h2>Équipe</h2><div class="empty error">${esc(e.message)}</div>`; });
}

// ── Account / tokens ────────────────────────────────────────────────────
async function renderAccount(main) {
  main.innerHTML = `<div class="head"><div><h1>Compte & accès</h1><p class="muted">${esc(auth.currentUser.email ?? auth.currentUser.uid)}</p></div></div>
  <div class="card section"><h2>Jeton personnel (app iPhone, widgets, agents, scripts)</h2>
    <p class="muted">Un jeton <code>mm_pat_</code> lit tous tes business. Colle-le dans l'app MoneyMaker sur iPhone pour les widgets, ou donne-le à ton agent pour qu'il crée et configure des projets.</p>
    <div class="row"><input id="label" placeholder="Nom du jeton (ex. iPhone)"><button class="primary" style="flex:0;white-space:nowrap" id="mk">Créer un jeton</button></div><div id="tok" style="margin-top:12px"></div></div>
  <div class="card section"><h2>Export comptable</h2>
    <p class="muted">CSV du mois pour ton comptable : chaque transaction avec TVA, HT, commissions stores, frais Stripe et net, plus un récapitulatif par pays (déclaration TVA OSS).</p>
    <div class="row"><input id="exportMonth" type="month" value="${new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 7)}"><button class="primary" style="flex:0;white-space:nowrap" id="exportCsv">Télécharger le CSV</button></div></div>
  <div class="card"><h2>API</h2><p class="muted">Base URL :</p>${copyRow(location.origin + "/v1")}<p><a href="/guide">Guide pas à pas</a> · <a href="/docs">Référence API</a> · <a href="/llms.txt">llms.txt (pour agents)</a></p></div>`;
  $("#exportCsv").onclick = async () => {
    const month = $("#exportMonth").value;
    const res = await fetch(`/v1/finance/export?month=${encodeURIComponent(month)}`, { headers: { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    if (!res.ok) return toast("Export impossible");
    Object.assign(document.createElement("a"), { href: URL.createObjectURL(await res.blob()), download: `moneymaker-${month}.csv` }).click();
  };
  $("#mk").onclick = async () => { const r = await api("/v1/tokens", { method: "POST", body: { label: $("#label").value || "token" } }); $("#tok").innerHTML = `<p class="muted">Affiché une seule fois :</p>${copyRow(r.token)}`; };
}

// ── Modals ──────────────────────────────────────────────────────────────
function openModal(html) { $("#modalBody").innerHTML = html; if (!$("#modal").open) $("#modal").showModal(); }
function newProjectDialog() {
  openModal(`<h2>Nouveau business</h2>
    <div class="field"><label>Ton app sur l'App Store (optionnel — remplit tout automatiquement)</label><div class="row"><input id="pSearch" placeholder="Nom de l'app…"><button type="button" id="pFind" style="flex:0">Chercher</button></div><div id="pResults"></div></div>
    <div class="field"><label>Nom du business</label><input id="pName" placeholder="ex. V2" required></div>
    <div class="field"><label>Package Android (optionnel)</label><input id="pPkg" placeholder="com.example.app"></div>
    <div class="field"><label>Devise de reporting</label><input id="pCur" value="EUR" maxlength="3"></div>
    <div class="row"><button value="cancel">Annuler</button><button type="button" class="primary" id="pCreate">Créer</button></div>`);
  let appId = null;
  $("#pFind").onclick = async () => {
    const term = $("#pSearch").value.trim(); if (!term) return;
    const { results } = await api(`/v1/appstore/search?term=${encodeURIComponent(term)}&country=fr`);
    $("#pResults").innerHTML = results.slice(0, 5).map(r => `<div class="row pick" data-app="${esc(r.appId)}" data-name="${esc(r.name)}" style="gap:10px;padding:8px;border-radius:10px;cursor:pointer;margin-top:6px">
      <img src="${esc(r.icon)}" class="appicon sm" alt="" style="flex:0 0 40px"><div><b>${esc(r.name)}</b><div class="muted">${esc(r.developer)}</div></div></div>`).join("") || `<p class="muted">Aucun résultat — tu peux créer sans.</p>`;
    document.querySelectorAll(".pick").forEach(el => el.onclick = () => {
      document.querySelectorAll(".pick").forEach(x => x.classList.remove("picked")); el.classList.add("picked");
      appId = el.dataset.app; if (!$("#pName").value) $("#pName").value = el.dataset.name;
    });
  };
  $("#pSearch").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("#pFind").click(); } };
  $("#pCreate").onclick = async () => {
    if (!$("#pName").value.trim()) return toast("Donne un nom au business");
    const r = await api("/v1/projects", { method: "POST", body: { name: $("#pName").value, appStoreAppId: appId ?? undefined, googlePackageName: $("#pPkg").value.trim() || undefined,
      config: { currency: $("#pCur").value.toUpperCase(), entitlements: { premium: ["*"] } } } });
    await loadProjects();
    openModal(`<h2>✅ Business créé</h2><p class="muted">Copie la clé secrète maintenant : elle ne sera plus jamais affichée.${appId ? " Ton app est reconnue : bundle ID, Apple ID et suivi des classements sont déjà réglés." : ""}</p>
      <div class="field"><label>Clé publique (apps)</label>${copyRow(r.publicKey)}</div><div class="field"><label>Clé secrète (serveurs)</label>${copyRow(r.secretKey)}</div>
      <div class="row"><button type="button" class="primary" id="goSetup">Continuer la mise en route →</button></div>`);
    $("#goSetup").onclick = () => { $("#modal").close(); go({ view: "project", projectId: r.projectId, tab: "start" }); };
  };
}

// ── Graphiques (parité RevenueCat Charts) ─────────────────────────────────
const CHARTS = {
  active_subscriptions: ["Abonnements actifs", "line"], active_subscriptions_movement: ["Mouvement des abonnements", "bars"],
  active_trials: ["Essais actifs", "line"], active_trials_movement: ["Mouvement des essais", "bars"],
  mrr: ["MRR", "line"], mrr_movement: ["Mouvement du MRR", "bars"], arr: ["ARR", "line"], revenue: ["Revenus", "bars"],
  new_customers: ["Nouveaux clients", "bars"], conversion_to_paying: ["Conversion en payant", "line"], initial_conversion: ["Conversion initiale", "line"],
  trial_conversion_funnel: ["Entonnoir des essais", "funnel"], trial_conversion_rate: ["Taux de conversion des essais", "line"],
  trial_cancellation_rate: ["Taux d'annulation des essais", "line"], subscription_retention: ["Rétention des abonnements", "retention"],
  churn: ["Churn", "line"], refund_rate: ["Taux de remboursement", "line"], refunds: ["Remboursements", "bars"],
  realized_ltv_per_customer: ["LTV réalisée par client", "line"], realized_ltv_per_paying_customer: ["LTV réalisée par client payant", "line"],
  non_subscription_purchases: ["Achats hors abonnement", "bars"], subscription_status: ["Statut des abonnements", "bars"], paywall: ["Paywall", "line"],
  ad_revenue: ["Revenus publicitaires", "bars"], ad_impressions: ["Impressions publicitaires", "bars"], ad_ecpm: ["eCPM publicitaire", "line"], arpdau: ["ARPDAU (pub)", "line"],
};
const MOVE_KEYS = { active_subscriptions_movement: ["new", "reactivated", "churned"], mrr_movement: ["new", "reactivated", "churned"], active_trials_movement: ["new", "converted", "expired"], subscription_status: ["active", "cancelled_active", "grace", "billing_retry"] };
const MOVE_LABEL = { new: "Nouveaux", reactivated: "Réactivés", churned: "Perdus", converted: "Convertis", expired: "Expirés", active: "Actifs", cancelled_active: "Annulés (encore actifs)", grace: "Période de grâce", billing_retry: "Relance de paiement", revenue: "Revenus", refunds: "Remboursements", net: "Net", transactions: "Transactions", amount: "Montant", customers: "Clients", payingCustomers: "Clients payants", converted: "Convertis", started: "Essais démarrés", stillActive: "Toujours actifs", cancelled: "Annulés", pending: "En cours", churned: "Perdus", impressions: "Affichages", conversions: "Achats", purchaseStarts: "Achats commencés", closes: "Fermetures", immature: "Trop récents", cohorts: "Cohortes", expired: "Expirés", conversionDays: "Fenêtre (jours)" };
const MOVE_COLOR = ["#00F19F", "#2E8BFF", "#FF5C7A", "#FFB547"];

function seriesBars(series, keys, fmt) {
  const id = `c${++chartSeq}`, W = 600, H = 220, n = Math.max(1, series.length), bw = W / n;
  const pos = p => keys.reduce((a, k) => a + Math.max(0, p[k] ?? 0), 0), neg = p => keys.reduce((a, k) => a + Math.min(0, p[k] ?? 0), 0);
  const max = Math.max(1, ...series.map(pos)), min = Math.min(0, ...series.map(neg)), span = max - min || 1;
  const y = v => ((max - v) / span) * H;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="graphique en barres">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00F19F"/><stop offset="1" stop-color="#2E8BFF" stop-opacity=".25"/></linearGradient></defs>
    ${min < 0 ? `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,.2)" vector-effect="non-scaling-stroke"/>` : ""}
    ${series.map((p, i) => { let up = 0, down = 0; return keys.map((k, j) => {
      const v = p[k] ?? 0; if (!v) return "";
      const top = v > 0 ? y(up + v) : y(down), h = Math.abs(y(0) - y(Math.abs(v))) || 1;
      if (v > 0) up += v; else down += v;
      const fill = keys.length === 1 ? `url(#${id})` : MOVE_COLOR[j % MOVE_COLOR.length];
      return `<rect x="${(i * bw + bw * 0.15).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw * 0.25).toFixed(1)}" fill="${fill}"><title>${esc(p.date)} · ${esc(MOVE_LABEL[k] ?? k)} : ${esc(fmt(v))}</title></rect>`;
    }).join(""); }).join("")}</svg>`;
}

// ── Prédiction LTV (modèle sBG par cohorte) ───────────────────────────────
const LTV_GROUP_LABEL = { product: "Produit", country: "Pays", store: "Store" };
const CONF_LABEL = { high: ["ok", "fiable"], medium: ["", "moyenne"], low: ["bad", "faible"] };
// ── Benchmarks anonymisés (percentiles inter-projets, benchmarks.ts) ─────
const BENCH_LABEL = {
  trial_conversion_rate: ["Conversion des essais", "ratio"], monthly_churn: ["Churn mensuel", "ratio"], refund_rate: ["Taux de remboursement", "ratio"],
  arppu: ["ARPPU (30 j)", "micros"], realized_ltv_12m: ["LTV réalisée 12 mois", "micros"], initial_conversion: ["Conversion initiale", "ratio"], mrr_growth_30d: ["Croissance du MRR (30 j)", "ratio"],
};
const BENCH_TIER = { lt3: "< 3 €/mois", "3to8": "3–8 €/mois", "8to15": "8–15 €/mois", gte15: "≥ 15 €/mois", all: "tous prix", unknown: "prix inconnu" };
async function benchmarksSection(box) {
  box.innerHTML = `<h2>Benchmarks</h2><div class="empty">Calcul…</div>`;
  const r = await api(`/v1/projects/${state.projectId}/benchmarks`);
  const fmt = (v, u) => v == null ? "—" : u === "micros" ? money(v, r.currency) : pct(v);
  const rows = Object.entries(BENCH_LABEL).map(([k, [label, u]]) => {
    const m = r.metrics?.[k] ?? { status: "insufficient_data" };
    if (m.status !== "ok") return `<tr><td>${label}</td><td>${fmt(m.value, u)}</td><td colspan="3" class="muted">Données insuffisantes (moins de 5 apps comparables)</td></tr>`;
    const p = m.percentiles, s = m.score;
    const cls = s == null ? "" : s >= 60 ? "ok" : s < 35 ? "bad" : "";
    return `<tr><td>${label}${m.higherIsBetter ? "" : ' <span class="muted">(plus bas = mieux)</span>'}</td><td><b>${fmt(m.value, u)}</b></td>
      <td>${m.percentileRank == null ? "—" : `<span class="pill ${cls}">P${m.percentileRank}</span>`}</td>
      <td class="muted">${fmt(p.p25, u)} · <b>${fmt(p.p50, u)}</b> · ${fmt(p.p75, u)}</td>
      <td class="muted">${esc(m.bucket.category === "all" ? "Toutes catégories" : m.bucket.category)} · ${esc(BENCH_TIER[m.bucket.tier] ?? m.bucket.tier)} · ${m.bucket.projects} apps</td></tr>`;
  }).join("");
  box.innerHTML = `<h2>Benchmarks</h2><p class="muted">Ton app comparée aux autres apps MoneyMaker (données anonymisées, ≥ 30 clients payants, au moins 5 apps par groupe). Catégorie : <b>${esc(r.category === "all" ? "toutes" : r.category)}</b> · palier : <b>${esc(BENCH_TIER[r.priceTier] ?? r.priceTier)}</b>${r.eligible ? "" : " · ton app n'entre pas encore dans le panel"}. Montants en EUR, mis à jour chaque nuit.</p>
    <div style="overflow-x:auto"><table><thead><tr><th>Métrique</th><th>Toi</th><th>Rang</th><th>P25 · médiane · P75</th><th>Groupe comparé</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function ltvSection(box) {
  const g = (state.ltvGroup ??= "product");
  box.innerHTML = `<div class="row" style="justify-content:space-between;align-items:center"><h2>Prédiction LTV</h2><div class="row seg">${Object.entries(LTV_GROUP_LABEL).map(([k, l]) => `<button class="small ${k === g ? "primary" : ""}" data-ltvg="${k}">${l}</button>`).join("")}</div></div><div class="empty">Calcul…</div>`;
  box.querySelectorAll("[data-ltvg]").forEach(b => b.onclick = () => { state.ltvGroup = b.dataset.ltvg; ltvSection(box); });
  const r = await api(`/v1/projects/${state.projectId}/ltv-prediction?groupBy=${g}`);
  const label = k => g === "country" ? `${flag(k)} ${esc(countryName(k))}` : `<span class="mono">${esc(k)}</span>`;
  const spark = curve => { const W = 120, H = 28; const pts = curve.map((v, i) => `${(i / Math.max(1, curve.length - 1) * W).toFixed(1)},${(H - v * H).toFixed(1)}`).join(" "); return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${pts}" fill="none" stroke="#00F19F" stroke-width="1.5"/></svg>`; };
  box.querySelector(".empty").outerHTML = r.groups.length ? `<p class="muted">Rétention mensuelle observée par cohorte, ajustée par un modèle shifted-beta-geometric (repli géométrique si peu de données), × revenu net par mois payé (remboursements déduits).</p>
    <div style="overflow-x:auto"><table><thead><tr><th>${LTV_GROUP_LABEL[g]}</th><th>Clients</th><th>Mois observés</th><th>Rétention M1 / M3 / M6</th><th>Courbe</th><th>Churn M1</th><th style="text-align:right">LTV 12 mois</th><th style="text-align:right">LTV 24 mois</th><th>Confiance</th></tr></thead>
    <tbody>${r.groups.map(x => { const rc = x.retentionCurve, c = CONF_LABEL[x.confidence]; return `<tr><td>${label(x.key)}</td><td>${x.customers}</td><td>${x.observedMonths}</td>
      <td>${[1, 3, 6].map(i => rc[i] == null ? "—" : pct(rc[i])).join(" / ")}</td><td>${spark(x.predictedCurve)}</td>
      <td title="${x.churnParams.model === "sbg" ? `α ${x.churnParams.alpha} · β ${x.churnParams.beta}` : "géométrique"}">${pct(x.churnParams.monthlyChurn)} <span class="muted">${x.churnParams.model === "sbg" ? "sBG" : "géo"}</span></td>
      <td style="text-align:right"><b>${money(x.ltv12, r.currency)}</b></td><td style="text-align:right">${money(x.ltv24, r.currency)}</td><td><span class="pill ${c[0]}">${c[1]}</span></td></tr>`; }).join("")}</tbody></table></div>`
    : `<div class="empty">Pas encore de paiements pour prédire la LTV.</div>`;
}

async function tabCharts(el) {
  const c = (state.chart ??= { name: "mrr", days: 90, resolution: "day", store: "", country: "", product: "" }), cur = state.projects.find(p => p.id === state.projectId)?.config?.currency ?? "EUR";
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`;
  el.innerHTML = `<div class="card section"><div class="row" style="flex-wrap:wrap;gap:8px;align-items:end">
      <div class="field" style="min-width:220px"><label>Graphique</label><select id="chName">${Object.entries(CHARTS).map(([k, [l]]) => opt(k, l, c.name)).join("")}</select></div>
      <div class="field"><label>Période</label><select id="chDays">${[[7, "7 j"], [30, "30 j"], [90, "90 j"], [180, "6 mois"], [365, "12 mois"], [730, "24 mois"]].map(([v, l]) => opt(String(v), l, String(c.days))).join("")}</select></div>
      <div class="field"><label>Résolution</label><select id="chRes">${[["day", "Jour"], ["week", "Semaine"], ["month", "Mois"]].map(([v, l]) => opt(v, l, c.resolution)).join("")}</select></div>
      <div class="field"><label>Store</label><select id="chStore">${[["", "Tous"], ["app_store", "App Store"], ["play_store", "Google Play"], ["stripe", "Stripe"], ["paddle", "Paddle"], ["amazon", "Amazon"], ["galaxy", "Galaxy Store"], ["roku", "Roku"]].map(([v, l]) => opt(v, l, c.store)).join("")}</select></div>
      <div class="field"><label>Pays</label><input id="chCountry" maxlength="2" placeholder="FR" value="${esc(c.country)}" style="width:70px"></div>
      <div class="field"><label>Produit</label><input id="chProduct" placeholder="tous" value="${esc(c.product)}"></div>
      <button id="chCsv" class="small">⬇︎ CSV</button></div></div><div id="chOut"><div class="empty">Chargement…</div></div><div id="benchOut" class="card section"></div><div id="ltvOut" class="card section"></div>`;
  benchmarksSection($("#benchOut")).catch(e => $("#benchOut").innerHTML = `<div class="empty error">${esc(e.message)}</div>`);
  ltvSection($("#ltvOut")).catch(e => $("#ltvOut").innerHTML = `<div class="empty error">${esc(e.message)}</div>`);
  const read = () => Object.assign(c, { name: $("#chName").value, days: Number($("#chDays").value), resolution: $("#chRes").value, store: $("#chStore").value, country: $("#chCountry").value.trim().toUpperCase(), product: $("#chProduct").value.trim() });
  const qs = (extra = {}) => new URLSearchParams(Object.fromEntries(Object.entries({ days: c.days, resolution: c.resolution, store: c.store, country: c.country, product: c.product, ...extra }).filter(([, v]) => v !== "" && v != null))).toString();
  el.querySelectorAll("select, input").forEach(i => i.onchange = () => { read(); tabCharts(el); });
  $("#chCsv").onclick = async () => {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(`/v1/projects/${state.projectId}/charts/${c.name}?${qs({ format: "csv" })}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return toast("Export impossible");
    const a = document.createElement("a"); a.href = URL.createObjectURL(await res.blob()); a.download = `${c.name}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  let r;
  try { r = await api(`/v1/projects/${state.projectId}/charts/${c.name}?${qs()}`); } catch (e) { $("#chOut").innerHTML = `<div class="card empty error">${esc(e.message)}</div>`; return; }
  const currency = r.currency ?? cur;
  const fmt = v => v == null ? "—" : r.unit === "micros" ? money(v, currency) : r.unit === "ratio" ? pct(v) : new Intl.NumberFormat("fr-FR").format(v);
  const [label, kind] = CHARTS[c.name];
  const sum = Object.entries(r.summary ?? {}).filter(([k, v]) => typeof v === "number" && !/^p\d+$/.test(k));
  const sumFmt = (k, v) => k === "value" ? fmt(v) : /^(revenue|refunds|amount|net)$/.test(k) || (r.unit === "micros" && ["new", "reactivated", "churned"].includes(k)) ? money(v, currency) : new Intl.NumberFormat("fr-FR").format(v);
  const kpis = `<div class="kpis">${sum.slice(0, 6).map(([k, v]) => kpi(k === "value" ? label : (MOVE_LABEL[k] ?? k), sumFmt(k, v))).join("")}</div>`;
  let body;
  if (kind === "retention") {
    const ks = Object.keys(r.series[0] ?? {}).filter(k => /^p\d+$/.test(k));
    const cell = v => v == null ? "<td></td>" : `<td style="text-align:center;background:rgba(0,208,132,${(v * 0.85).toFixed(2)});color:${v > .45 ? "#001a10" : "inherit"}">${Math.round(v * 100)}%</td>`;
    body = r.series.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Cohorte</th><th>Abonnés</th>${ks.map(k => `<th style="text-align:center">M${k.slice(1)}</th>`).join("")}</tr></thead>
      <tbody>${r.series.map(p => `<tr><td>${esc(p.date.slice(0, 7))}</td><td>${p.size}</td>${ks.map(k => cell(p[k])).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty">Aucune cohorte sur la période.</div>`;
  } else if (kind === "funnel") {
    const s = r.summary, steps = [["Essais démarrés", s.started], ["Convertis", s.converted], ["Toujours actifs", s.stillActive]];
    body = `<div>${steps.map(([l, v]) => `<div style="margin:8px 0"><div class="row" style="justify-content:space-between"><span>${l}</span><b>${v ?? 0}${s.started ? ` · ${pct((v ?? 0) / s.started)}` : ""}</b></div><div style="height:10px;border-radius:6px;background:rgba(255,255,255,.06)"><div style="height:10px;border-radius:6px;width:${s.started ? ((v ?? 0) / s.started) * 100 : 0}%;background:linear-gradient(90deg,#2E8BFF,#00F19F)"></div></div></div>`).join("")}</div>
      ${lineChart(r.series.filter(p => p.value != null).map(p => ({ label: p.date, v: p.value })), currency, undefined, fmt)}`;
  } else if (kind === "bars") {
    const keys = MOVE_KEYS[c.name] ?? ["value"];
    body = seriesBars(r.series, keys, fmt) + (keys.length > 1 ? `<div class="row" style="gap:14px;margin-top:8px">${keys.map((k, j) => `<span class="muted"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${MOVE_COLOR[j]}"></span> ${MOVE_LABEL[k] ?? k}</span>`).join("")}</div>` : "");
  } else {
    body = lineChart(r.series.filter(p => p.value != null).map(p => ({ label: p.date, v: p.value })), currency, undefined, fmt);
  }
  $("#chOut").innerHTML = `${kpis}<div class="card section"><h2>${esc(label)}</h2>${r.note ? `<p class="muted">${esc(r.note)}</p>` : ""}${body}
    <details style="margin-top:10px"><summary class="muted">Données</summary><div style="overflow-x:auto"><table><thead><tr>${Object.keys(r.series[0] ?? { date: 1, value: 1 }).map(k => `<th>${esc(k)}</th>`).join("")}</tr></thead>
    <tbody>${r.series.slice().reverse().map(p => `<tr>${Object.entries(p).map(([k, v]) => `<td>${k === "date" ? esc(v) : k === "value" ? fmt(v) : esc(v ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details></div>`;
}

// ── Équipe : membres, rôles, invitations, journal ─────────────────────────
const ROLE_LABEL = { owner: "Propriétaire", admin: "Admin", developer: "Développeur", viewer: "Lecteur" };
const AUDIT_LABEL = { "config.update": "Configuration modifiée", "credentials.update": "Identifiants modifiés", "keys.issue": "Clé API générée", "grant.update": "Accès accordé", "invite.create": "Invitation créée", "invite.revoke": "Invitation révoquée", "invite.accept": "Invitation acceptée", "member.role": "Rôle modifié", "member.remove": "Membre retiré" };

async function teamSection(box) {
  const pid = state.projectId, me = auth.currentUser?.uid;
  const t = await api(`/v1/projects/${pid}/members`);
  const admin = ["owner", "admin"].includes(t.role);
  const roleSel = (m) => `<select data-role="${esc(m.uid)}" ${!admin || m.role === "owner" && t.role !== "owner" ? "disabled" : ""}>${(m.role === "owner" ? ["owner", "admin", "developer", "viewer"] : ["admin", "developer", "viewer"]).map(r => `<option value="${r}" ${r === m.role ? "selected" : ""} ${r === "owner" ? "disabled" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>`;
  box.innerHTML = `<h2>Équipe</h2><p class="muted">Ton rôle : <b>${ROLE_LABEL[t.role] ?? esc(t.role)}</b>. Lecteur = lecture seule · Développeur = configuration, produits, clés publiques · Admin = tout sauf le transfert de propriété (membres, identifiants, révocation des clés).</p>
    <table><thead><tr><th>Membre</th><th>Rôle</th><th></th></tr></thead><tbody>${t.members.map(m => `<tr><td>${esc(m.email ?? m.uid)}${m.uid === me ? ' <span class="pill">toi</span>' : ""}</td><td>${roleSel(m)}</td>
      <td style="text-align:right">${m.uid === me ? `<button class="small" data-remove="${esc(m.uid)}">Quitter</button>` : admin && (m.role !== "owner" || t.role === "owner") ? `<button class="small danger" data-remove="${esc(m.uid)}">Retirer</button>` : ""}</td></tr>`).join("")}</tbody></table>
    ${admin ? `<h3 style="margin-top:16px">Inviter</h3><div class="row"><input id="invEmail" type="email" placeholder="email@exemple.com"><select id="invRole">${["developer", "viewer", "admin"].map(r => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join("")}</select><button class="primary" id="invGo">Créer le lien</button></div>
      <p class="muted">Aucun e-mail n'est envoyé : copie le lien et partage-le. Il expire après 14 jours et ne fonctionne que pour cette adresse.</p><div id="invLink"></div>
      ${t.invites.length ? `<h3 style="margin-top:16px">Invitations en attente</h3><table><tbody>${t.invites.map(i => `<tr><td>${esc(i.email)}</td><td>${ROLE_LABEL[i.role]}</td><td class="muted">expire ${date(i.expiresAt)}</td><td style="text-align:right"><button class="small" data-copyinv="${esc(i.link)}">Copier le lien</button> <button class="small danger" data-revoke="${esc(i.id)}">Révoquer</button></td></tr>`).join("")}</tbody></table>` : ""}
      <h3 style="margin-top:16px">Journal d'audit</h3><div id="auditLog"><div class="empty">Chargement…</div></div>` : ""}`;
  const reload = () => teamSection(box).catch(e => toast(e.message));
  box.querySelectorAll("[data-role]").forEach(s => s.onchange = async () => { try { await api(`/v1/projects/${pid}/members/${s.dataset.role}`, { method: "PATCH", body: { role: s.value } }); toast("Rôle mis à jour"); } catch (e) { toast(e.message); } reload(); });
  box.querySelectorAll("[data-remove]").forEach(b => b.onclick = async () => {
    const self = b.dataset.remove === me;
    if (!confirm(self ? "Quitter ce business ?" : "Retirer ce membre ?")) return;
    try { await api(`/v1/projects/${pid}/members/${b.dataset.remove}`, { method: "DELETE" }); if (self) { await loadProjects(); return go({ view: "overview", projectId: null }); } reload(); } catch (e) { toast(e.message); }
  });
  box.querySelectorAll("[data-copyinv]").forEach(b => b.onclick = () => copy(b.dataset.copyinv));
  box.querySelectorAll("[data-revoke]").forEach(b => b.onclick = async () => { try { await api(`/v1/projects/${pid}/invites/${b.dataset.revoke}`, { method: "DELETE" }); reload(); } catch (e) { toast(e.message); } });
  if (!admin) return;
  $("#invGo").onclick = async () => {
    try { const r = await api(`/v1/projects/${pid}/invites`, { method: "POST", body: { email: $("#invEmail").value.trim(), role: $("#invRole").value } }); await reload(); $("#invLink").innerHTML = `<p class="muted">Lien pour ${esc(r.email)} :</p>${copyRow(r.link)}`; }
    catch (e) { toast(e.message); }
  };
  const { entries } = await api(`/v1/projects/${pid}/audit?limit=50`).catch(() => ({ entries: [] }));
  $("#auditLog").innerHTML = entries.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Détails</th></tr></thead><tbody>${entries.map(a => `<tr><td>${date(a.at)}</td><td>${esc(a.email ?? (a.uid?.startsWith("key:") ? "clé secrète" : a.uid))}</td><td>${esc(AUDIT_LABEL[a.action] ?? a.action)}</td>
    <td class="muted mono" style="font-size:12px">${esc(Object.entries(a.details ?? {}).filter(([k]) => k !== "path").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · "))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Aucune action enregistrée.</div>`;
}

/** ?invite=TOKEN (reste dans l'URL pendant la connexion) : accepte l'invitation une fois connecté.
 *  Autonome (pas de const de module) : peut s'exécuter avant la fin de l'évaluation du module. */
async function acceptPendingInvite() {
  const token = new URLSearchParams(location.search).get("invite");
  if (!token) return;
  history.replaceState(null, "", location.pathname + location.hash);
  const roles = { admin: "Admin", developer: "Développeur", viewer: "Lecteur" };
  try {
    const info = await api(`/v1/invites/${encodeURIComponent(token)}`);
    if (!confirm(`Rejoindre « ${info.projectName} » en tant que ${roles[info.role] ?? info.role} ?`)) return;
    const r = await api(`/v1/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
    toast(`Tu as rejoint ${r.projectName}`);
    history.replaceState(null, "", `#${r.projectId}/metrics`);
  } catch (e) { toast(`Invitation : ${e.message}`); }
}
