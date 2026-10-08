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
const daysPicker = () => `<div class="row" style="flex:0">${[7, 30, 90, 365].map(d => `<button class="small ${state.days === d ? "primary" : ""}" data-days="${d}">${d} j</button>`).join("")}</div>`;
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
  </tbody></table></div>`;
  bindDays();
  document.querySelectorAll("[data-open]").forEach(r => r.onclick = () => go({ view: "project", projectId: r.dataset.open, tab: "metrics" }));
}

// ── Project ─────────────────────────────────────────────────────────────
const TABS = { metrics: "Métriques", customers: "Clients", events: "Événements", products: "Produits & accès", setup: "Branchement", settings: "Réglages" };
async function renderProject(main) {
  const p = state.projects.find(x => x.id === state.projectId);
  main.innerHTML = `<div class="head"><div><h1>${esc(p?.name)}</h1><p class="muted mono">${esc(state.projectId)}</p></div>${state.tab === "metrics" ? daysPicker() : ""}</div>
    <div class="tabs">${Object.entries(TABS).map(([k, v]) => `<button class="small ${state.tab === k ? "active" : ""}" data-tab="${k}">${v}</button>`).join("")}</div><div id="tab"></div>`;
  document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => go({ tab: b.dataset.tab }));
  bindDays();
  await ({ metrics: tabMetrics, customers: tabCustomers, events: tabEvents, products: tabProducts, setup: tabSetup, settings: tabSettings }[state.tab] ?? tabMetrics)($("#tab"));
}

async function tabMetrics(el) {
  const m = await api(`/v1/projects/${state.projectId}/metrics?days=${state.days}`);
  const c = m.currency;
  const mrrHistory = m.history.map(h => ({ label: h.date, v: h.mrrMicros }));
  el.innerHTML = `<div class="kpis">${kpi("MRR", money(m.mrrMicros, c), `ARR ${money(m.arrMicros, c)}`, true)}
    ${kpi(`Revenu ${state.days} j`, money(m.netRevenueMicros, c), m.refundsMicros ? `remboursé ${money(m.refundsMicros, c)}` : "aucun remboursement")}
    ${kpi("Abonnés actifs", m.activeSubscriptions, `${m.willNotRenew} ne renouvelleront pas`)}${kpi("Essais", m.activeTrials, `conversion ${pct(m.trialConversionRate)}`)}
    ${kpi("Churn", pct(m.churnRate), `${m.eventCounts.EXPIRATION ?? 0} expirations`)}${kpi("Problèmes de paiement", m.billingIssues, "en grâce / retry")}
    ${kpi(`Nouveaux clients`, m.newCustomers, `${m.newSubscriptions} nouveaux abonnés`)}${kpi("Clients payants actifs", m.activeCustomers)}</div>
    <div class="grid2"><div class="card"><h3>MRR</h3>${lineChart(mrrHistory, c)}</div><div class="card"><h3>Revenu par jour</h3>${barChart(m.revenueByDay, Math.min(state.days, 90), c)}</div></div>
    <div class="grid2" style="margin-top:12px">
      <div class="card"><h3>Par store</h3><table>${Object.entries(m.byStore).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.active}</td><td>${money(v.mrrMicros, c)}</td></tr>`).join("") || `<tr><td class="muted">—</td></tr>`}</table></div>
      <div class="card"><h3>Par produit</h3><table>${Object.entries(m.byProduct).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${v.active}</td><td>${money(v.mrrMicros, c)}</td></tr>`).join("") || `<tr><td class="muted">—</td></tr>`}</table></div>
    </div>`;
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

async function tabSetup(el) {
  const p = await api(`/v1/projects/${state.projectId}`);
  const ok = b => b ? `<span class="pill ok">connecté</span>` : `<span class="pill warn">à faire</span>`;
  const agentPrompt = `Intègre MoneyMaker (abonnements) dans cette app en suivant ${location.origin}/llms.txt.
Projet: ${p.id}
Base URL: ${location.origin}/v1
Clé publique SDK: <colle ta clé mm_pub_ ici>
Accès à vérifier: ${Object.keys(p.config.entitlements)[0] ?? "premium"}
Remplace toute logique RevenueCat/StoreKit existante, appelle MoneyMaker.configure au lancement, logIn avec l'id utilisateur, purchase() depuis le paywall, et verrouille les écrans premium avec isEntitled.`;
  el.innerHTML = `<div class="card section"><h2>⚡ Le plus rapide : demande à ton agent</h2><p class="muted">Colle ce prompt dans Claude Code / Cursor / Codex à la racine de ton app.</p><pre>${esc(agentPrompt)}</pre>
    <div class="row" style="margin-top:10px"><button class="primary" style="flex:0" onclick='mmCopy(${esc(JSON.stringify(agentPrompt))})'>Copier le prompt</button><a href="/docs" style="flex:0;white-space:nowrap">Documentation complète →</a></div></div>
    <div class="steps">
    <div class="card"><h2>App Store ${ok(p.config.apple?.bundleId)} ${ok(p.credentials.apple)}</h2>
      <p class="muted">1. Bundle ID + Apple ID de l'app (Réglages). 2. Clé In-App Purchase (.p8) : App Store Connect → Utilisateurs et accès → Intégrations → In-App Purchase. 3. URL de notifications serveur V2 (Production <b>et</b> Sandbox) :</p>${copyRow(p.endpoints.appleNotifications)}</div>
    <div class="card"><h2>Google Play ${ok(p.config.google?.packageName)} ${ok(p.credentials.google)}</h2>
      <p class="muted">1. Package name (Réglages). 2. Compte de service avec accès « Finances » dans Play Console, JSON à téléverser dans Réglages. 3. Notifications en temps réel : crée un topic Pub/Sub, un abonnement <b>push</b> vers cette URL, et renseigne le topic dans Play Console → Monétisation :</p>${copyRow(p.endpoints.googleRtdn, true)}</div>
    <div class="card"><h2>Stripe ${ok(p.credentials.stripeKey)} ${ok(p.credentials.stripeWebhook)}</h2>
      <p class="muted">1. Clé restreinte (lecture abonnements/clients + écriture Checkout) dans Réglages. 2. Webhook Stripe vers cette URL avec les événements <code>customer.subscription.*</code>, <code>invoice.paid</code>, <code>invoice.payment_failed</code>, <code>checkout.session.completed</code>, <code>charge.refunded</code>, puis colle le <code>whsec_</code> :</p>${copyRow(p.endpoints.stripeWebhook)}</div>
    <div class="card"><h2>Tes backends (webhooks sortants)</h2><p class="muted">Chaque événement est envoyé en POST signé <code>MoneyMaker-Signature: t=…,v1=HMAC-SHA256(secret, t + "." + body)</code>. Secret de signature :</p>${copyRow(p.webhookSigningSecret, true)}</div>
    </div>`;
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
    $("#goSetup").onclick = () => { $("#modal").close(); go({ view: "project", projectId: r.projectId, tab: "setup" }); };
  };
}
