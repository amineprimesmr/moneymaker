// Onglet « Paywalls & tests » : paywalls distants, ciblage, placements, expériences A/B.
// Chargé par app.js : tabGrowth(el, { api, esc, toast, money, pct, date, projectId, reload }).

const PLATFORMS = ["ios", "android", "web"];
const split = (v, sep = ",") => v.split(sep).map(s => s.trim()).filter(Boolean);
const lines = v => v.split("\n").map(s => s.trim()).filter(Boolean);

export async function tabGrowth(el, h) {
  const { api, esc, toast, projectId } = h;
  const q = s => el.querySelector(s);
  const qa = s => [...el.querySelectorAll(s)];
  const p = await api(`/v1/projects/${projectId}`);
  const cfg = p.config;
  const offerings = structuredClone(cfg.offerings ?? {});
  const offIds = Object.keys(offerings);
  if (!offIds.length) {
    el.innerHTML = `<div class="card empty">Crée d'abord une offre dans l'onglet « Produits &amp; accès » : paywalls, ciblage et tests A/B s'appuient sur tes offres.</div>`;
    return;
  }
  const targeting = structuredClone(cfg.targeting ?? { rules: [], placements: {} });
  const experiments = structuredClone(cfg.experiments ?? []);
  const stats = await api(`/v1/projects/${projectId}/paywall-stats?days=30`).catch(() => ({ totals: {} }));
  const offSelect = (id, val, extra = "") => `<select ${id} ${extra}>${offIds.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  const save = async (config, msg = "Enregistré") => {
    try { await api(`/v1/projects/${projectId}`, { method: "PATCH", body: { config } }); await h.reload(); toast(msg); return true; }
    catch (e) { toast(e.message); return false; }
  };

  el.innerHTML = `
  <div class="card section"><h2>Paywall distant</h2>
    <p class="muted">Le SDK iOS (<code>MoneyMakerPaywall</code>) affiche ce paywall sans republier l'app. Sans configuration, la mise en page intégrée est utilisée.</p>
    <div class="grid2">
      <div>
        <div class="row"><div class="field"><label>Offre</label>${offSelect('id="pwOff"', cfg.currentOffering ?? offIds[0])}</div>
          <div class="field"><label>Modèle</label><select id="pwTpl"><option value="stack">Pile</option><option value="cards">Cartes</option><option value="minimal">Minimal</option></select></div></div>
        <div class="field"><label>Titre</label><input id="pwTitle" placeholder="Passe à Pro"></div>
        <div class="field"><label>Sous-titre</label><input id="pwSub" placeholder="Tout débloquer, sans limite"></div>
        <div class="field"><label>Avantages (une ligne : <code>icône SF Symbol | texte</code>)</label><textarea id="pwFeat" placeholder="star.fill | Projets illimités"></textarea></div>
        <div class="field"><label>Image (URL https)</label><input id="pwHero" placeholder="https://…"></div>
        <div class="row"><div class="field"><label>Fond</label><input id="pwBg" type="color" value="#0b0b0c"></div><div class="field"><label>Accent</label><input id="pwAcc" type="color" value="#00d084"></div><div class="field"><label>Texte</label><input id="pwTxt" type="color" value="#ffffff"></div></div>
        <div class="field"><label>Bouton</label><input id="pwCta" placeholder="Continuer"></div>
        <div class="row"><label class="row" style="flex:0;white-space:nowrap"><input type="checkbox" id="pwClose" style="width:auto"> bouton fermer</label>
          <div class="field"><label>Délai avant fermeture (s)</label><input id="pwDelay" type="number" min="0" max="30" value="0"></div></div>
        <div class="field"><label>Liens de pied de page (<code>titre | https://…</code>)</label><textarea id="pwLinks" placeholder="Conditions | https://exemple.com/cgu"></textarea></div>
        <div class="field"><label>Traductions (JSON par langue : title, subtitle, cta, features, footerLinks)</label><textarea id="pwLoc" placeholder='{"en": {"title": "Go Pro"}}'></textarea></div>
        <div class="row"><button class="primary" id="pwSave">Enregistrer le paywall</button><button class="ghost" id="pwDel">Retirer</button>
          <select id="pwLang" style="flex:0"><option value="">Aperçu : base</option></select></div>
      </div>
      <div><div id="pwPreview"></div><p class="muted" id="pwStats" style="margin-top:10px"></p></div>
    </div>
  </div>

  <div class="card section"><h2>Ciblage</h2>
    <p class="muted">Règles évaluées dans l'ordre : la première qui correspond choisit l'offre « courante ». Une condition dont le SDK n'envoie pas l'info ne correspond pas. Les expériences en cours sont prioritaires.</p>
    <div id="rules"></div><button class="small" id="addRule">+ Règle</button>
  </div>

  <div class="card section"><h2>Placements</h2>
    <p class="muted">Un placement = un endroit de l'app (<code>onboarding</code>, <code>settings</code>…). Le SDK appelle <code>offering(forPlacement:)</code>. Sans offre ni règle, l'offre courante est utilisée.</p>
    <div id="placements"></div><button class="small" id="addPl">+ Placement</button>
  </div>
  <button class="primary section" id="tgSave">Enregistrer ciblage &amp; placements</button>

  <div class="card section"><h2>Expériences A/B</h2>
    <p class="muted">Chaque utilisateur (appUserId) est affecté de façon stable à une variante (hachage). Une seule expérience active par placement ; les variantes sont figées une fois l'expérience lancée.</p>
    <div id="exps"></div>
    <h3 style="margin-top:14px">Nouvelle expérience</h3>
    <div class="row"><div class="field"><label>Nom</label><input id="exName" placeholder="Prix annuel 49 € vs 59 €"></div>
      <div class="field"><label>Placement</label><select id="exPl"><option value="default">default (offre courante)</option>${Object.keys(targeting.placements).map(k => `<option>${esc(k)}</option>`).join("")}</select></div></div>
    <div id="exVars"></div><button class="small" id="exAddVar">+ Variante</button>
    <div class="row" style="margin-top:10px"><button id="exDraft">Créer en brouillon</button><button class="primary" id="exStart">Créer et lancer</button></div>
    <div id="exResults"></div>
  </div>`;

  // ── Paywall editor + live preview ──
  const pw = () => offerings[q("#pwOff").value].paywall ?? {};
  const fill = () => {
    const c = pw();
    q("#pwTpl").value = c.template ?? "stack";
    q("#pwTitle").value = c.title ?? ""; q("#pwSub").value = c.subtitle ?? ""; q("#pwCta").value = c.cta ?? "";
    q("#pwFeat").value = (c.features ?? []).map(f => `${f.icon ?? ""} | ${f.text}`).join("\n");
    q("#pwHero").value = c.heroImage ?? "";
    q("#pwBg").value = c.colors?.background ?? "#0b0b0c"; q("#pwAcc").value = c.colors?.accent ?? "#00d084"; q("#pwTxt").value = c.colors?.text ?? "#ffffff";
    q("#pwClose").checked = c.showCloseButton !== false; q("#pwDelay").value = c.closeDelay ?? 0;
    q("#pwLinks").value = (c.footerLinks ?? []).map(l => `${l.title} | ${l.url}`).join("\n");
    q("#pwLoc").value = c.localizations ? JSON.stringify(c.localizations, null, 2) : "";
    const t = stats.totals?.[q("#pwOff").value] ?? {};
    q("#pwStats").textContent = `30 derniers jours : ${t.impression ?? 0} affichages · ${t.purchase ?? 0} achats · ${t.close ?? 0} fermetures${t.impression ? ` · conversion ${h.pct((t.purchase ?? 0) / t.impression)}` : ""}`;
    preview();
  };
  const read = () => {
    let localizations;
    const loc = q("#pwLoc").value.trim();
    if (loc) localizations = JSON.parse(loc);
    return {
      template: q("#pwTpl").value,
      title: q("#pwTitle").value.trim() || undefined, subtitle: q("#pwSub").value.trim() || undefined, cta: q("#pwCta").value.trim() || undefined,
      features: lines(q("#pwFeat").value).map(l => { const [a, b] = l.includes("|") ? split(l, "|") : ["", l]; return { ...(a ? { icon: a } : {}), text: b ?? a }; }),
      heroImage: q("#pwHero").value.trim() || undefined,
      colors: { background: q("#pwBg").value, accent: q("#pwAcc").value, text: q("#pwTxt").value },
      showCloseButton: q("#pwClose").checked, closeDelay: Number(q("#pwDelay").value) || 0,
      footerLinks: lines(q("#pwLinks").value).map(l => { const [title, url] = split(l, "|"); return { title, url }; }),
      ...(localizations ? { localizations } : {}),
    };
  };
  const preview = () => {
    let c;
    try { c = read(); } catch { q("#pwPreview").innerHTML = `<div class="notice">JSON des traductions invalide</div>`; return; }
    const langs = Object.keys(c.localizations ?? {});
    const ls = q("#pwLang"), cur = ls.value;
    ls.innerHTML = `<option value="">Aperçu : base</option>${langs.map(l => `<option ${l === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
    const t = { ...c, ...(c.localizations?.[ls.value] ?? {}) };
    const pk = offerings[q("#pwOff").value].packages ?? [];
    const col = c.colors, minimal = c.template === "minimal", cards = c.template === "cards";
    const pkgHtml = pk.map((x, i) => `<div style="border:2px solid ${i === pk.length - 1 ? col.accent : "transparent"};background:rgba(127,127,127,.12);border-radius:14px;padding:12px;${cards ? "min-width:110px;text-align:center" : "display:flex;justify-content:space-between"}">
      <b>${esc(x.id)}</b><span style="opacity:.8">${esc(x.metadata?.badge ?? "")} ${esc(x.productIds?.app_store ?? x.productIds?.play_store ?? "")}</span></div>`).join("");
    q("#pwPreview").innerHTML = `<div style="position:relative;max-width:320px;margin:0 auto;border-radius:36px;border:8px solid #222;background:${col.background};color:${col.text};padding:28px 18px 18px;min-height:520px;display:flex;flex-direction:column;gap:12px;font-family:-apple-system,system-ui,sans-serif">
      ${c.showCloseButton ? `<span style="position:absolute;top:12px;right:16px;opacity:${c.closeDelay ? .35 : .8}" title="${c.closeDelay ? `visible après ${c.closeDelay} s` : ""}">✕</span>` : ""}
      ${!minimal && c.heroImage ? `<img src="${esc(c.heroImage)}" style="width:100%;max-height:150px;object-fit:cover;border-radius:16px">` : ""}
      ${t.title ? `<div style="font-size:24px;font-weight:800;text-align:center">${esc(t.title)}</div>` : ""}
      ${t.subtitle ? `<div style="opacity:.75;text-align:center">${esc(t.subtitle)}</div>` : ""}
      ${!minimal ? (t.features ?? []).map(f => `<div style="display:flex;gap:10px"><span style="color:${col.accent}">●</span><span>${esc(f.text)}</span><span style="opacity:.4;font-size:11px;margin-left:auto">${esc(f.icon ?? "")}</span></div>`).join("") : ""}
      <div style="display:flex;${cards ? "flex-direction:row;overflow-x:auto" : "flex-direction:column"};gap:8px;margin-top:auto">${pkgHtml}</div>
      <div style="background:${col.accent};color:#000;border-radius:14px;padding:14px;text-align:center;font-weight:700">${esc(t.cta || "Continuer")}</div>
      <div style="display:flex;gap:12px;justify-content:center;font-size:11px;opacity:.7"><span>Restaurer</span>${(t.footerLinks ?? []).map(l => `<span>${esc(l.title)}</span>`).join("")}</div></div>`;
  };
  el.querySelectorAll("#pwOff").forEach(s => s.onchange = fill);
  qa("#pwTpl,#pwTitle,#pwSub,#pwFeat,#pwHero,#pwBg,#pwAcc,#pwTxt,#pwCta,#pwClose,#pwDelay,#pwLinks,#pwLoc,#pwLang").forEach(i => i.oninput = i.onchange = preview);
  q("#pwOff").onchange = fill;
  q("#pwSave").onclick = async () => {
    try { offerings[q("#pwOff").value].paywall = read(); } catch { return toast("JSON des traductions invalide"); }
    await save({ offerings }, "Paywall enregistré");
  };
  q("#pwDel").onclick = async () => { delete offerings[q("#pwOff").value].paywall; if (await save({ offerings }, "Paywall retiré")) fill(); };
  fill();

  // ── Targeting rules ──
  const ruleRow = (r, i, scope) => {
    const c = r.conditions ?? {};
    return `<div class="card" style="margin-bottom:8px" data-rule="${scope}:${i}">
      <div class="row"><input data-k="name" placeholder="Nom" value="${esc(r.name ?? "")}"><div class="field"><label>→ offre</label>${offSelect('data-k="offeringId"', r.offeringId)}</div>
        <button class="small" data-up="${scope}:${i}">↑</button><button class="small danger" data-del="${scope}:${i}">✕</button></div>
      <div class="row"><div class="field"><label>Pays (FR, BE…)</label><input data-k="countries" value="${esc((c.countries ?? []).join(", "))}"></div>
        <div class="field"><label>Plateformes</label><div class="row">${PLATFORMS.map(pl => `<label class="row" style="flex:0;white-space:nowrap"><input type="checkbox" data-pl="${pl}" style="width:auto" ${(c.platforms ?? []).includes(pl) ? "checked" : ""}> ${pl}</label>`).join("")}</div></div></div>
      <div class="row"><div class="field"><label>Version min</label><input data-k="appVersionMin" value="${esc(c.appVersionMin ?? "")}" placeholder="2.0"></div>
        <div class="field"><label>Version max</label><input data-k="appVersionMax" value="${esc(c.appVersionMax ?? "")}"></div>
        <div class="field"><label>Attributs (clé=valeur, …)</label><input data-k="attributes" value="${esc(Object.entries(c.attributes ?? {}).map(([k, v]) => `${k}=${v}`).join(", "))}"></div>
        <label class="row" style="flex:0;white-space:nowrap"><input type="checkbox" data-k="newCustomersOnly" style="width:auto" ${c.newCustomersOnly ? "checked" : ""}> nouveaux clients</label></div></div>`;
  };
  const readRule = node => {
    const v = k => node.querySelector(`[data-k="${k}"]`).value.trim();
    const attrs = Object.fromEntries(split(v("attributes")).map(s => s.split("=").map(x => x.trim())).filter(([k]) => k));
    return {
      id: node.dataset.id, name: v("name") || undefined, offeringId: v("offeringId"),
      conditions: {
        ...(split(v("countries")).length ? { countries: split(v("countries")).map(x => x.toUpperCase()) } : {}),
        ...(() => { const pl = [...node.querySelectorAll("[data-pl]:checked")].map(x => x.dataset.pl); return pl.length ? { platforms: pl } : {}; })(),
        ...(v("appVersionMin") ? { appVersionMin: v("appVersionMin") } : {}),
        ...(v("appVersionMax") ? { appVersionMax: v("appVersionMax") } : {}),
        ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
        ...(node.querySelector('[data-k="newCustomersOnly"]').checked ? { newCustomersOnly: true } : {}),
      },
    };
  };
  const syncFromDom = () => {
    targeting.rules = qa('#rules [data-rule]').map((n, i) => ({ ...readRule(n), id: targeting.rules[i]?.id ?? `rule_${Date.now()}_${i}` }));
    const next = {};
    qa("#placements [data-place]").forEach(n => {
      const id = n.querySelector("[data-pid]").value.trim();
      if (!id) return;
      const off = n.querySelector("[data-poff]").value;
      let rules;
      const raw = n.querySelector("[data-prules]").value.trim();
      if (raw) rules = JSON.parse(raw);
      next[id] = { ...(off ? { offeringId: off } : {}), ...(rules?.length ? { rules } : {}) };
    });
    targeting.placements = next;
  };
  const renderTargeting = () => {
    q("#rules").innerHTML = targeting.rules.map((r, i) => ruleRow(r, i, "g")).join("") || `<p class="muted">Aucune règle : tout le monde voit l'offre courante.</p>`;
    q("#placements").innerHTML = Object.entries(targeting.placements).map(([id, pl]) => `<div class="row" data-place style="align-items:flex-start;margin-bottom:8px">
      <div class="field"><label>Identifiant</label><input data-pid value="${esc(id)}"></div>
      <div class="field"><label>Offre</label><select data-poff><option value="">(offre courante)</option>${offIds.map(o => `<option ${o === pl.offeringId ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>
      <div class="field" style="flex:2"><label>Règles propres (JSON, même format, optionnel)</label><textarea data-prules style="min-height:40px">${pl.rules?.length ? esc(JSON.stringify(pl.rules)) : ""}</textarea></div>
      <button class="small danger" data-pdel>✕</button></div>`).join("") || `<p class="muted">Aucun placement.</p>`;
    qa("[data-del]").forEach(b => b.onclick = () => { syncFromDom(); targeting.rules.splice(Number(b.dataset.del.split(":")[1]), 1); renderTargeting(); });
    qa("[data-up]").forEach(b => b.onclick = () => { syncFromDom(); const i = Number(b.dataset.up.split(":")[1]); if (i > 0) [targeting.rules[i - 1], targeting.rules[i]] = [targeting.rules[i], targeting.rules[i - 1]]; renderTargeting(); });
    qa("[data-pdel]").forEach(b => b.onclick = () => { b.closest("[data-place]").remove(); });
  };
  q("#addRule").onclick = () => { try { syncFromDom(); } catch {} targeting.rules.push({ id: `rule_${Date.now()}`, conditions: {}, offeringId: offIds[0] }); renderTargeting(); };
  q("#addPl").onclick = () => { try { syncFromDom(); } catch {} targeting.placements[`placement_${Object.keys(targeting.placements).length + 1}`] = {}; renderTargeting(); };
  q("#tgSave").onclick = async () => {
    try { syncFromDom(); } catch { return toast("JSON des règles de placement invalide"); }
    await save({ targeting }, "Ciblage enregistré");
  };
  renderTargeting();

  // ── Experiments ──
  const statusPill = s => `<span class="pill ${s === "running" ? "ok" : s === "stopped" ? "" : "warn"}">${{ draft: "brouillon", running: "en cours", stopped: "terminée" }[s]}</span>`;
  const renderExps = () => {
    q("#exps").innerHTML = experiments.length ? `<table><thead><tr><th>Expérience</th><th>Placement</th><th>Variantes</th><th>Statut</th><th>Début</th><th></th></tr></thead><tbody>${experiments.map((e, i) => `<tr>
      <td><b>${esc(e.name)}</b><div class="muted mono">${esc(e.id)}</div></td><td>${esc(e.placement ?? "default")}</td>
      <td>${e.variants.map(v => `${esc(v.id)} → <span class="mono">${esc(v.offeringId)}</span> (${v.weight})`).join("<br>")}</td>
      <td>${statusPill(e.status)}</td><td>${h.date(e.startedAt)}</td>
      <td style="white-space:nowrap">${e.status === "draft" ? `<button class="small primary" data-exgo="${i}">Lancer</button> <button class="small danger" data-exrm="${i}">Supprimer</button>` : ""}
        ${e.status === "running" ? `<button class="small danger" data-exstop="${i}">Arrêter</button>` : ""}
        ${e.status !== "draft" ? `<button class="small" data-exres="${esc(e.id)}">Résultats</button>` : ""}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">Aucune expérience.</p>`;
    const mutate = async (fn, msg) => { const backup = structuredClone(experiments); fn(); if (!(await save({ experiments }, msg))) { experiments.splice(0, experiments.length, ...backup); } renderExps(); };
    qa("[data-exgo]").forEach(b => b.onclick = () => mutate(() => { experiments[b.dataset.exgo].status = "running"; }, "Expérience lancée"));
    qa("[data-exstop]").forEach(b => b.onclick = () => confirm("Arrêter l'expérience ? Elle ne pourra pas être relancée.") && mutate(() => { experiments[b.dataset.exstop].status = "stopped"; }, "Expérience arrêtée"));
    qa("[data-exrm]").forEach(b => b.onclick = () => mutate(() => { experiments.splice(Number(b.dataset.exrm), 1); }, "Supprimée"));
    qa("[data-exres]").forEach(b => b.onclick = () => showResults(b.dataset.exres));
  };
  const showResults = async id => {
    const box = q("#exResults");
    box.innerHTML = `<p class="muted">Chargement…</p>`;
    try {
      const r = await api(`/v1/projects/${projectId}/experiments/${encodeURIComponent(id)}/results`);
      const best = Math.max(...r.variants.map(v => v.probabilityToBeBest));
      box.innerHTML = `<h3 style="margin-top:16px">Résultats — ${esc(r.experiment.name)}</h3><table><thead><tr><th>Variante</th><th>Offre</th><th>Inscrits</th><th>Affichages</th><th>Conversions</th><th>Taux</th><th>Revenu</th><th>ARPU</th><th>Proba. meilleure</th></tr></thead><tbody>${r.variants.map(v => `<tr>
        <td><b>${esc(v.id)}</b></td><td class="mono">${esc(v.offeringId)}</td><td>${v.enrolled}</td><td>${v.impressions}</td><td>${v.conversions}</td>
        <td>${h.pct(v.conversionRate)}</td><td>${h.money(v.revenueMicros, r.currency)}</td><td>${h.money(v.arpuMicros, r.currency)}</td>
        <td>${v.probabilityToBeBest === best && best >= 0.95 ? `<span class="pill ok">${h.pct(v.probabilityToBeBest)}</span>` : h.pct(v.probabilityToBeBest)}</td></tr>`).join("")}</tbody></table>
        <p class="muted">Conversion = client inscrit ayant fait un premier achat après son inscription (hors sandbox). Revenu net (achats + renouvellements − remboursements). Probabilité bayésienne (Beta → approximation normale) d'avoir le meilleur taux de conversion ; ≥ 95 % = gagnant probable.</p>`;
    } catch (e) { box.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  let draftVars = [{ id: "control", offeringId: cfg.currentOffering ?? offIds[0], weight: 50 }, { id: "test", offeringId: offIds[1] ?? offIds[0], weight: 50 }];
  const renderVars = () => {
    q("#exVars").innerHTML = draftVars.map((v, i) => `<div class="row" data-var="${i}"><input data-vid value="${esc(v.id)}" placeholder="variante"><div class="field">${offSelect("data-voff", v.offeringId)}</div>
      <input data-vw type="number" min="0" value="${v.weight}" style="max-width:90px"><button class="small danger" data-vdel="${i}">✕</button></div>`).join("");
    qa("[data-vdel]").forEach(b => b.onclick = () => { readVars(); if (draftVars.length > 2) draftVars.splice(Number(b.dataset.vdel), 1); renderVars(); });
  };
  const readVars = () => { draftVars = qa("[data-var]").map(n => ({ id: n.querySelector("[data-vid]").value.trim(), offeringId: n.querySelector("[data-voff]").value, weight: Number(n.querySelector("[data-vw]").value) || 0 })); };
  q("#exAddVar").onclick = () => { readVars(); if (draftVars.length < 5) draftVars.push({ id: `v${draftVars.length + 1}`, offeringId: offIds[0], weight: 50 }); renderVars(); };
  const create = async status => {
    readVars();
    const name = q("#exName").value.trim();
    if (!name) return toast("Donne un nom à l'expérience");
    const id = name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) + "_" + Date.now().toString(36);
    const pl = q("#exPl").value;
    experiments.push({ id, name, status, ...(pl !== "default" ? { placement: pl } : {}), variants: draftVars });
    if (await save({ experiments }, status === "running" ? "Expérience lancée" : "Brouillon créé")) { q("#exName").value = ""; }
    else experiments.pop();
    renderExps();
  };
  q("#exDraft").onclick = () => create("draft");
  q("#exStart").onclick = () => create("running");
  renderVars(); renderExps();
  webSection(el, h, cfg, offIds, save);
}

// ══ Web : liens d'achat, paywall web, lien de récupération ══
function webSection(el, h, cfg, offIds, save) {
  const { esc, toast, projectId } = h;
  const web = cfg.web ?? {};
  const base = location.origin;
  const box = document.createElement("div");
  box.className = "card section";
  box.innerHTML = `<h2>Achats web</h2>
    <p class="muted">Paywall hébergé (mêmes modèles que l'app) payé via Stripe Checkout : seuls les packages dont <code>productIds.stripe</code> est un <code>price_…</code> sont proposés. Codes promo Stripe acceptés (champ dans Checkout ou <code>&amp;code=PROMO</code>).</p>
    <div class="row"><div class="field"><label>Offre</label><select id="webOff">${offIds.map(o => `<option>${esc(o)}</option>`).join("")}</select></div>
      <div class="field"><label>app_user_id (optionnel)</label><input id="webUid" placeholder="laisser vide = acheteur anonyme"></div>
      <div class="field"><label>Code promo (optionnel)</label><input id="webCode" placeholder="BIENVENUE"></div></div>
    <div class="row"><input id="webLink" readonly><button id="webCopy" style="flex:0;white-space:nowrap">Copier le lien</button><a id="webOpen" target="_blank" rel="noopener" style="align-self:center;white-space:nowrap">Ouvrir</a></div>
    <h3 style="margin-top:16px">Récupération dans l'app</h3>
    <p class="muted">Un acheteur sans compte reçoit un lien <code>…?mm_redeem=TOKEN</code> (+ QR code). Dans l'app : <code>MoneyMaker.shared.redeemWebPurchase(token:)</code>.</p>
    <div class="row"><div class="field"><label>URL de récupération (lien universel ou schéma)</label><input id="webRedeem" placeholder="monapp://redeem ou https://monapp.com/redeem" value="${esc(web.redemptionUrl ?? "")}"></div>
      <div class="field"><label>Retour après achat (optionnel)</label><input id="webSuccess" placeholder="https://monapp.com/merci" value="${esc(web.successUrl ?? "")}"></div></div>
    <label><input type="checkbox" id="webOn" ${web.enabled === false ? "" : "checked"}> Achats web activés</label>
    <div><button class="primary" id="webSave">Enregistrer</button></div>`;
  el.appendChild(box);
  const q = s => box.querySelector(s);
  const link = () => {
    const u = new URL(`${base}/pay/${encodeURIComponent(projectId)}/${encodeURIComponent(q("#webOff").value)}`);
    if (q("#webUid").value.trim()) u.searchParams.set("app_user_id", q("#webUid").value.trim());
    if (q("#webCode").value.trim()) u.searchParams.set("code", q("#webCode").value.trim());
    q("#webLink").value = u.toString(); q("#webOpen").href = u.toString();
  };
  ["#webOff", "#webUid", "#webCode"].forEach(s => q(s).addEventListener("input", link));
  link();
  q("#webCopy").onclick = async () => { try { await navigator.clipboard.writeText(q("#webLink").value); toast("Lien copié"); } catch { q("#webLink").select(); } };
  q("#webSave").onclick = () => save({ web: { enabled: q("#webOn").checked, redemptionUrl: q("#webRedeem").value.trim() || undefined, successUrl: q("#webSuccess").value.trim() || undefined } }, "Réglages web enregistrés");
}
