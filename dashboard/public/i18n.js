// Langue du site : français ou anglais. Le français reste la langue des textes dans le code ;
// en anglais, ce script charge le dictionnaire (i18n-en.js) et remplace les textes dès qu'ils arrivent
// dans la page. Nouveau texte : l'ajouter à dashboard/tools/i18n-en.json puis lancer `python3 dashboard/tools/i18n-build.py`
// (`node dashboard/tools/i18n-extract.cjs` liste les textes du code). `window.__mmMisses` montre ce qui manque sur une page.
(function () {
  var KEY = "mmLang", q = new URLSearchParams(location.search).get("lang"), stored = null;
  if (q !== "fr" && q !== "en") q = null;
  try { if (q) localStorage.setItem(KEY, q); stored = localStorage.getItem(KEY); } catch (e) {}
  var lang = q || (stored === "fr" || stored === "en" ? stored : (navigator.language || "en").toLowerCase().indexOf("fr") === 0 ? "fr" : "en");
  window.MM_LANG = lang;
  window.MM_LOCALE = lang === "fr" ? "fr-FR" : "en-US";
  window.mmSetLang = function (l) { try { localStorage.setItem(KEY, l); } catch (e) {} var u = new URL(location.href); u.searchParams.delete("lang"); location.href = u.href; };
  window.mmT = function (s) { return s; };
  var html = document.documentElement;
  html.lang = lang; html.classList.add("l-" + lang);
  var regions = null;
  try { regions = new Intl.DisplayNames([lang], { type: "region" }); } catch (e) {}
  /** Nom du pays dans la langue du site. */
  window.mmCountry = function (cc, fallback) { try { if (lang !== "fr" && regions && /^[A-Z]{2}$/.test(cc)) return regions.of(cc) || fallback; } catch (e) {} return fallback; };
  if (lang === "fr") return;

  var exact = new Map(), patterns = [], cache = new Map(), produced = new Set(), misses = new Set();
  var norm = function (s) { return s.replace(/[   ]/g, " ").replace(/’/g, "'").replace(/\s+/g, " ").trim(); };
  var hasLetter = /\p{L}{2}/u;
  var looksFrench = /[éèêàùçôîâûëïœ]|\b(le|la|les|des|une|ton|ta|tes|pour|avec|dans|sur|sans|est|pas|aucun|tous|jours?|mois)\b/i;

  window.MM_I18N_START = function (dict) {
    Object.keys(dict).forEach(function (k) {
      var v = dict[k];
      if (k.indexOf("{0}") < 0) { exact.set(k, v); return; }
      var parts = k.split(/\{\d+\}/), order = (k.match(/\{\d+\}/g) || []).map(function (m) { return +m.slice(1, -1); });
      if (parts.join("").replace(/[^\p{L}]/gu, "").length < 2) return;
      var re = "^" + parts.map(function (p) { return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("(.*?)") + "$";
      patterns.push({ re: new RegExp(re), order: order, tpl: v, weight: parts.join("").length });
    });
    patterns.sort(function (a, b) { return b.weight - a.weight; });
    window.mmT = function (s) { return translate(s) ?? s; };
    window.__mmMisses = misses;
    ["confirm", "alert", "prompt"].forEach(function (name) {
      var orig = window[name];
      window[name] = function (msg, def) { return orig.call(window, translate(String(msg)) ?? msg, def); };
    });
    var fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, w) {
      var t = typeof text === "string" ? translate(text) ?? text : text;
      return w === undefined ? fill.call(this, t, x, y) : fill.call(this, t, x, y, w);
    };
    run(html);
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === "attributes") attr(r.target, r.attributeName);
        else if (r.type === "characterData") text(r.target);
        else r.addedNodes.forEach(run);
      });
    }).observe(html, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };

  function translate(raw) {
    var n = norm(raw);
    if (produced.has(n)) return null;
    if (exact.has(n)) { produced.add(norm(exact.get(n))); return exact.get(n); }
    // Durées courtes : « 30 j » → « 30d ».
    var dur = /^(\d+) j$/.exec(n);
    if (dur) return dur[1] + "d";
    if (!hasLetter.test(n)) return null;
    if (cache.has(n)) return cache.get(n);
    var out = exact.has(n) ? exact.get(n) : null;
    if (out === null) {
      for (var i = 0; i < patterns.length && out === null; i++) {
        var m = patterns[i].re.exec(n);
        if (!m) continue;
        var values = {};
        patterns[i].order.forEach(function (o, j) { values[o] = m[j + 1]; });
        out = patterns[i].tpl.replace(/\{(\d+)\}/g, function (_, d) { var v = values[+d] ?? ""; return translate(v) ?? v; });
      }
    }
    if (out === null && n.indexOf(" · ") > 0) {
      // Morceaux assemblés par le code : « Éditeur · Catégorie · pas encore de notes ».
      var hit = false;
      var joined = n.split(" · ").map(function (p) { var t = translate(p); if (t !== null) hit = true; return t ?? p; }).join(" · ");
      if (hit) out = joined;
    }
    if (out === null && looksFrench.test(n) && misses.size < 2000) misses.add(n);
    cache.set(n, out);
    if (out !== null) produced.add(norm(out));
    return out;
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, BDI: 1, NOSCRIPT: 1 };
  var ATTRS = ["title", "placeholder", "aria-label", "alt", "data-tip", "label"];
  function text(node) {
    var v = node.nodeValue;
    if (!v) return;
    var p = node.parentNode;
    if (p && (SKIP[p.nodeName] || (p.closest && p.closest("bdi,[contenteditable],[data-raw]")))) return;
    var t = translate(v), next = v;
    if (t !== null) {
      var lead = /^\s*/.exec(v)[0], trail = /\s*$/.exec(v)[0];
      if (/^[:;,.)!?]/.test(t)) lead = "";
      next = lead + t + trail;
    }
    // « 12 % » s'écrit « 12% » en anglais.
    if (next.indexOf("%") >= 0) next = next.replace(/(\d)[\s\u00a0\u202f]+%/g, "$1%");
    if (next !== v) node.nodeValue = next;
  }
  function attr(el, name) {
    var v = el.getAttribute && el.getAttribute(name);
    if (!v) return;
    var t = translate(v);
    if (t !== null && t !== v) el.setAttribute(name, t);
  }
  function run(root) {
    if (root.nodeType === 3) return text(root);
    if (root.nodeType !== 1 || SKIP[root.nodeName]) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n, nodes = [];
    while ((n = w.nextNode())) nodes.push(n);
    nodes.forEach(text);
    ATTRS.forEach(function (a) {
      if (root.hasAttribute && root.hasAttribute(a)) attr(root, a);
      root.querySelectorAll("[" + a + "]").forEach(function (el) { attr(el, a); });
    });
    root.querySelectorAll('meta[name="description"]').forEach(function (m) { var t = translate(m.content); if (t) m.content = t; });
  }
  document.write('<script src="/i18n-en.js"><\/script>');
})();
