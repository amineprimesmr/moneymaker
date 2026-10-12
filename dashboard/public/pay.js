// Paywall web hébergé : /pay/{projectId}/{offeringId}?app_user_id=…&email=…&code=PROMO  et  /pay/success?pid=…&session_id=…
(() => {
  const app = document.getElementById("app");
  const qs = new URLSearchParams(location.search);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lang = (navigator.language || "fr").toLowerCase();
  const fr = lang.startsWith("fr");
  const t = (a, b) => (fr ? a : b);
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { method: opts.method || "GET", headers: opts.body ? { "Content-Type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || r.statusText);
    return j;
  };
  const fail = msg => { app.innerHTML = `<div class="err">${esc(msg)}</div>`; };
  const parts = location.pathname.split("/").filter(Boolean); // ["pay", pid, oid] | ["pay", "success"]

  const fmt = p => {
    if (!p.price || p.price.amount == null) return "";
    const amount = new Intl.NumberFormat(lang, { style: "currency", currency: p.price.currency }).format(p.price.amount / 100);
    if (!p.price.interval) return amount;
    const n = p.price.intervalCount || 1;
    const unit = { day: t("jour", "day"), week: t("semaine", "week"), month: t("mois", "month"), year: t("an", "year") }[p.price.interval];
    return `${amount} / ${n > 1 ? n + " " : ""}${unit}`;
  };
  const localized = pw => {
    const loc = pw?.localizations || {};
    const key = Object.keys(loc).find(k => k.toLowerCase().replace("_", "-") === lang) || Object.keys(loc).find(k => lang.startsWith(k.toLowerCase().slice(0, 2)));
    return { ...(pw || {}), ...(key ? loc[key] : {}) };
  };

  async function paywall(pid, oid) {
    const off = await api(`/v1/web/${encodeURIComponent(pid)}/offering/${encodeURIComponent(oid)}`);
    const pw = localized(off.paywall);
    const col = off.paywall?.colors || {};
    const root = document.documentElement.style;
    if (col.background) root.setProperty("--bg", col.background);
    if (col.text) root.setProperty("--fg", col.text);
    if (col.accent) root.setProperty("--accent", col.accent);
    document.title = pw.title || off.projectName;
    if (!off.packages.length) return fail(t("Aucun produit disponible à l'achat sur le web.", "No product available for web purchase."));
    let sel = off.packages.find(p => p.metadata?.default) || off.packages[0];
    app.className = `tpl-${off.paywall?.template || "stack"}`;
    app.innerHTML = `
      ${pw.heroImage ? `<img class="hero" src="${esc(pw.heroImage)}" alt="">` : ""}
      <h1>${esc(pw.title || off.projectName)}</h1>
      ${pw.subtitle || off.description ? `<p class="sub">${esc(pw.subtitle || off.description)}</p>` : ""}
      ${(pw.features || []).length ? `<ul class="feat">${pw.features.map(f => `<li>${esc(f.text)}</li>`).join("")}</ul>` : ""}
      <div class="pkgs">${off.packages.map(p => `<button class="pkg" data-id="${esc(p.id)}" aria-pressed="${p === sel}">
        <span><b>${esc(p.metadata?.title || p.productName || p.id)}</b><br><small>${esc(fmt(p))}${p.price?.trialDays ? ` · ${p.price.trialDays} ${t("jours d'essai", "days free")}` : ""}</small></span>
        ${p.metadata?.badge ? `<span class="badge">${esc(p.metadata.badge)}</span>` : ""}</button>`).join("")}</div>
      ${qs.get("email") ? "" : `<input id="email" type="email" placeholder="${t("E-mail (pour le reçu)", "Email (for the receipt)")}" autocomplete="email">`}
      <details ${qs.get("code") ? "open" : ""}><summary>${t("Code promo", "Promo code")}</summary><input id="code" value="${esc(qs.get("code") || "")}" placeholder="CODE" style="margin-top:8px"></details>
      <button class="cta" id="buy">${esc(pw.cta || t("Continuer", "Continue"))}</button>
      <div id="msg"></div>
      ${off.livemode === false ? `<p class="sub" style="font-size:12px">${t("Mode test Stripe", "Stripe test mode")}</p>` : ""}
      <footer>${(pw.footerLinks || []).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>`).join("")}</footer>`;
    app.querySelectorAll(".pkg").forEach(b => b.onclick = () => {
      sel = off.packages.find(p => p.id === b.dataset.id);
      app.querySelectorAll(".pkg").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    });
    document.getElementById("buy").onclick = async e => {
      e.target.disabled = true;
      try {
        const r = await api(`/v1/web/${encodeURIComponent(pid)}/offering/${encodeURIComponent(oid)}/checkout`, { method: "POST", body: {
          packageId: sel.id, appUserId: qs.get("app_user_id") || undefined,
          email: qs.get("email") || document.getElementById("email")?.value.trim() || undefined,
          promoCode: document.getElementById("code").value.trim() || undefined,
        } });
        location.href = r.url;
      } catch (err) { document.getElementById("msg").innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
    };
  }

  async function success() {
    const pid = qs.get("pid"), sid = qs.get("session_id");
    if (!pid || !sid) return fail(t("Lien incomplet.", "Incomplete link."));
    let r;
    for (let i = 0; i < 5; i++) {
      try { r = await api(`/v1/web/${encodeURIComponent(pid)}/success?session_id=${encodeURIComponent(sid)}`); break; }
      catch (e) { if (i === 4) return fail(e.message); await new Promise(res => setTimeout(res, 1500)); }
    }
    const redeem = r.redemptionLink;
    app.innerHTML = `<h1>${t("Merci !", "Thank you!")}</h1>
      <p class="sub">${t("Ton achat est confirmé", "Your purchase is confirmed")}${r.email ? ` — ${t("reçu envoyé à", "receipt sent to")} ${esc(r.email)}` : ""}.</p>
      ${r.redemptionToken ? (redeem ? `<p class="sub">${t("Ouvre l'app pour activer ton accès :", "Open the app to activate your access:")}</p>
        <a class="cta btn" href="${esc(redeem)}"><button class="cta">${t("Activer dans l'app", "Activate in the app")}</button></a>
        <p class="sub">${t("Ou scanne ce code avec ton téléphone :", "Or scan this code with your phone:")}</p><div id="qr"></div><p class="link">${esc(redeem)}</p>`
        : `<p class="sub">${t("Code d'activation à saisir dans l'app :", "Activation code to enter in the app:")}</p><p class="link" style="font-size:16px;color:inherit">${esc(r.redemptionToken)}</p>`)
      : r.successUrl ? `<a class="btn" href="${esc(r.successUrl)}"><button class="cta">${t("Retourner à l'app", "Back to the app")}</button></a>` : ""}
      <footer><a href="${esc(r.manageUrl)}">${t("Gérer mon abonnement", "Manage my subscription")}</a></footer>`;
    if (redeem && window.QRCode) new QRCode(document.getElementById("qr"), { text: redeem, width: 200, height: 200 });
  }

  if (parts[1] === "success") success().catch(e => fail(e.message));
  else if (parts.length >= 3) paywall(decodeURIComponent(parts[1]), decodeURIComponent(parts[2])).catch(e => fail(e.message));
  else fail(t("Lien d'achat invalide.", "Invalid purchase link."));
})();
