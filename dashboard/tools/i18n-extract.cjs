// Liste les textes français du site (dashboard/public) pour le dictionnaire anglais de public/i18n-en.js.
// Usage : node dashboard/tools/i18n-extract.cjs > sortie.json
// Les expressions ${…} des gabarits deviennent {0}, {1}… et les balises HTML séparent les fragments.
const fs = require("fs"), path = require("path");
const ts = require(path.join(__dirname, "../../backend/functions/node_modules/typescript"));
const PUB = path.join(__dirname, "../public");
const FILES = ["app.js", "screens.js", "kit.js", "growth.js", "pay.js", "globe.js", "index.html", "connect.html", "manage.html", "pay.html", "app-login.html", "leaderboard.html", "docs.html", "mcp-docs.html", "guide.html"];
const EXPR = "\u0001";
const ENT = { "&nbsp;": " ", "&#8239;": " ", "&thinsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&rarr;": "→", "&middot;": "·", "&mdash;": "—", "&hellip;": "…", "&euro;": "€" };
const norm = s => s.replace(/&[#a-z0-9]+;/gi, m => ENT[m] ?? m).replace(/[   ]/g, " ").replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
const out = new Map();
function add(raw, file, exprs = []) {
  let n = norm(raw);
  if (!/\p{L}{2,}/u.test(n.replaceAll(EXPR, ""))) return;
  if (/^[\/#.]|^https?:|^mailto:|=>|^[\w-]+:\s*[\w#-]+;|^var\(/.test(n)) return;
  if (/^[a-z0-9_.:\/-]+$/.test(n) && !/[éèêàùçôîâûëï]/.test(n) && !FRENCH_WORD.test(n)) return; // identifiant de code
  if (/^[A-Z0-9_]+$/.test(n)) return;
  let i = 0; const used = [];
  const key = n.replace(new RegExp(EXPR, "g"), () => { used.push(exprs[i]); return `{${i++}}`; });
  if (!out.has(key)) out.set(key, { k: key, f: file, x: used.map(e => (e ?? "").replace(/\s+/g, " ").slice(0, 40)) });
}
const FRENCH_WORD = /^(annuel|mensuel|hebdo|gratuit|essai|actif|inactif|pays|revenus?|abonn|ventes?|aucun|tous|hier|demain|jours?|mois|ans?|semaine|et|ou|de|du|le|la|les|un|une|sur|par|avec|sans|pour|net|brut|nouveau|nouveaux)/;
const TAG = /<\/?[a-zA-Z][^<>]*>|<!--[\s\S]*?-->/g;
function html(text, file, exprs = []) {
  // Répartit les expressions entre les balises (ignorées) et les fragments de texte.
  let idx = 0, last = 0, m;
  const consume = s => { const e = []; for (const c of s) if (c === EXPR) e.push(exprs[idx++]); return e; };
  TAG.lastIndex = 0;
  while ((m = TAG.exec(text))) {
    const before = text.slice(last, m.index); add(before, file, consume(before));
    const tag = m[0], tagEx = consume(tag);
    for (const a of tag.matchAll(/\b(title|placeholder|aria-label|alt|data-tip|label)="([^"]*)"/g)) if (!a[2].includes(EXPR)) add(a[2], file);
    last = TAG.lastIndex;
  }
  const rest = text.slice(last); add(rest, file, consume(rest));
}
const SKIP_CALLS = new Set(["$", "$$", "api", "querySelector", "querySelectorAll", "getElementById", "closest", "addEventListener", "removeEventListener", "fetch", "getItem", "setItem", "removeItem", "matchMedia", "createElement", "getAttribute", "setAttribute", "icon", "Intl", "pref", "import", "get", "open", "toggle", "add", "remove", "contains", "startsWith", "endsWith", "includes", "split", "replace", "join", "getContext", "go", "route"]);
function js(code, file) {
  const sf = ts.createSourceFile("x.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (SKIP_CALLS.has(name) && node.arguments[0] && (ts.isStringLiteralLike(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]))) {
        node.arguments.slice(1).forEach(visit); visit(node.expression); return;
      }
    }
    if (ts.isStringLiteralLike(node)) { html(node.text, file); return; }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text; const ex = [];
      for (const sp of node.templateSpans) { ex.push(sp.expression.getText(sf)); text += EXPR + sp.literal.text; visit(sp.expression); }
      html(text, file, ex);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const f of FILES) {
  let s = fs.readFileSync(path.join(PUB, f), "utf8");
  if (f.endsWith(".js")) { js(s, f); continue; }
  s = s.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (_, c) => { if (c.trim()) js(c, f); return ""; }).replace(/<style\b[\s\S]*?<\/style>/g, "");
  s = s.replace(/<meta name="description" content="([^"]*)"[^>]*>/g, (_, d) => { add(d, f); return ""; });
  html(s, f);
}
process.stdout.write(JSON.stringify([...out.values()], null, 0));
