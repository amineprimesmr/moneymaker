// Planète des ventes : mêmes données (land.json, countries.json) et même rendu que GlobeRender.draw dans l'app.
let landCache, countriesCache;
const unit = (lat, lng) => { const la = lat * Math.PI / 180, lo = lng * Math.PI / 180; return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]; };
async function data() {
  landCache ??= fetch("/land.json").then(r => r.json()).then(flat => { const out = []; for (let i = 0; i + 1 < flat.length; i += 2) out.push(unit(flat[i], flat[i + 1])); return out; });
  countriesCache ??= fetch("/countries.json").then(r => r.json());
  return { land: await landCache, countries: await countriesCache };
}

/** Pour chaque point de terre : ventes des pays voisins (noyau gaussien de ~9°), normalisé de 0 à 1. */
function computeHeat(land, spots, countries) {
  const placed = spots.filter(s => s.value > 0 && countries[s.cc]).map(s => ({ v: Math.sqrt(s.value), g: unit(countries[s.cc].lat, countries[s.cc].lng) }));
  if (!placed.length) return new Float32Array(land.length);
  const heat = new Float32Array(land.length), sigma = 9 * Math.PI / 180, k = 1 / (2 * sigma * sigma);
  let max = 0;
  for (let i = 0; i < land.length; i++) {
    const p = land[i];
    let h = 0;
    for (const s of placed) {
      const dot = p[0] * s.g[0] + p[1] * s.g[1] + p[2] * s.g[2];
      if (dot < .9) continue;
      const a = Math.acos(Math.min(1, dot));
      h += s.v * Math.exp(-a * a * k);
    }
    heat[i] = h;
    if (h > max) max = h;
  }
  if (max > 0) for (let i = 0; i < heat.length; i++) heat[i] /= max;
  return heat;
}

/**
 * Monte une planète dans `host`. options : spots [{cc,value,lastSale}], interactive, onTap(cc), highlight,
 * halo (atmosphère violette), spinSpeed. Renvoie { setSpots, setHighlight, focus, zoomBy, destroy }.
 */
export async function mountGlobe(host, opts = {}) {
  host.classList.add("globe");
  host.innerHTML = `<canvas></canvas>`;
  const cv = host.firstChild, ctx = cv.getContext("2d");
  const { land, countries } = await data();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cam = { spin: -0.35, tilt: .35, scale: 1, tSpin: null, tTilt: null, tScale: 1 };
  let spots = opts.spots ?? [], heat = computeHeat(land, spots, countries), highlight = opts.highlight ?? null;
  let W = 0, H = 0, dpr = 1, raf = 0, visible = true, last = performance.now(), dragging = null, moved = 0, destroyed = false;
  const interactive = opts.interactive !== false, baseSpin = opts.spinSpeed ?? .09;
  if (opts.initial) Object.assign(cam, opts.initial);

  const size = () => {
    const r = host.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = W * dpr; cv.height = H * dpr;
  };
  const radius = () => Math.min(W, H) / 2 * .86 * cam.scale;
  const project = (g, lift = 1) => {
    const r = radius(), cs = Math.cos(cam.spin), sn = Math.sin(cam.spin), ct = Math.cos(cam.tilt), st = Math.sin(cam.tilt);
    const x1 = g[0] * cs - g[2] * sn, z1 = g[0] * sn + g[2] * cs, y2 = g[1] * ct - z1 * st, z2 = g[1] * st + z1 * ct;
    return { x: W / 2 + x1 * r * lift, y: H / 2 - y2 * r * lift, z: z2 };
  };

  function draw(now) {
    const r = radius(), cx = W / 2, cy = H / 2, c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    // Atmosphère : halo violet posé derrière le disque, qui respire très lentement.
    if (opts.halo !== false) {
      const t = now / 1000, br = reduce ? 1 : 1 + .05 * Math.sin(t / 2.3), R = r * 1.34 * br, ox = (reduce ? 0 : Math.sin(t / 3.1) * r * .012);
      const g = c.createRadialGradient(cx + ox, cy, r * .94, cx + ox, cy, R);
      g.addColorStop(0, "rgba(107,92,242,.62)"); g.addColorStop(.16, "rgba(107,92,242,.36)"); g.addColorStop(.48, "rgba(77,77,199,.13)"); g.addColorStop(1, "rgba(77,77,199,0)");
      c.fillStyle = g; c.beginPath(); c.arc(cx + ox, cy, R, 0, 6.2832); c.fill();
    }
    // Disque sombre.
    const ocean = c.createRadialGradient(cx, cy - r * .35, 0, cx, cy - r * .35, r * 1.1);
    ocean.addColorStop(0, "#090909"); ocean.addColorStop(1, "#000");
    c.fillStyle = ocean; c.beginPath(); c.arc(cx, cy, r, 0, 6.2832); c.fill();

    // Terres : opacité et taille selon la profondeur ; les points proches des ventes s'allument en vert.
    const dot = Math.max(1.1, r / 150 / Math.max(1, Math.sqrt(cam.scale)));
    const cs = Math.cos(cam.spin), sn = Math.sin(cam.spin), ct = Math.cos(cam.tilt), st = Math.sin(cam.tilt);
    const levels = 32, hot = 6, base = Array.from({ length: levels }, () => []), heated = Array.from({ length: hot * 8 }, () => []);
    for (let i = 0; i < land.length; i++) {
      const v = land[i], z1 = v[0] * sn + v[2] * cs, z = v[1] * st + z1 * ct;
      if (z <= .02) continue;
      const x1 = v[0] * cs - v[2] * sn, y2 = v[1] * ct - z1 * st, px = cx + x1 * r, py = cy - y2 * r;
      if (cam.scale > 1 && (px < -8 || py < -8 || px > W + 8 || py > H + 8)) continue;
      const depth = Math.min(1, z), w = heat[i] ?? 0, s = dot * (.45 + .55 * Math.sqrt(depth)) * (1 + .45 * w);
      if (w > .04) heated[Math.min(hot - 1, Math.floor(w * hot)) * 8 + Math.min(7, Math.floor(depth * 8))].push(px, py, s);
      else base[Math.min(levels - 1, Math.floor(depth * levels))].push(px, py, s);
    }
    const fill = (arr, style) => {
      if (!arr.length) return;
      c.fillStyle = style; c.beginPath();
      for (let k = 0; k < arr.length; k += 3) { c.moveTo(arr[k] + arr[k + 2], arr[k + 1]); c.arc(arr[k], arr[k + 1], arr[k + 2], 0, 6.2832); }
      c.fill();
    };
    base.forEach((a, i) => { const d = (i + .5) / levels, e = Math.min(1, d / .22); fill(a, `rgba(255,255,255,${(.10 + .40 * d) * e * e})`); });
    heated.forEach((a, i) => { const w = (Math.floor(i / 8) + .5) / hot, d = (i % 8 + .5) / 8, e = Math.min(1, d / .22); fill(a, `rgba(0,241,159,${(.30 + .70 * w) * (.35 + .65 * d) * e * e})`); });

    // Faisceaux, de l'arrière vers l'avant.
    const maxV = Math.max(...spots.map(s => s.value), .0001), t = now / 1000;
    const placed = spots.filter(s => s.value > 0 && countries[s.cc]).map(s => { const g = unit(countries[s.cc].lat, countries[s.cc].lng); return { s, g, q: project(g) }; }).filter(p => p.q.z > -.05).sort((a, b) => a.q.z - b.q.z);
    for (const { s, g, q } of placed) {
      const norm = s.value / maxV, fade = Math.max(0, Math.min(1, q.z * 3)), sel = s.cc === highlight, tint = sel ? "255,255,255" : "0,241,159";
      const top = project(g, 1 + .04 + .34 * norm + (sel ? .06 : 0));
      const lg = c.createLinearGradient(q.x, q.y, top.x, top.y);
      lg.addColorStop(0, `rgba(${tint},${.95 * fade})`); lg.addColorStop(1, `rgba(${tint},${.05 * fade})`);
      c.strokeStyle = lg; c.lineWidth = 1.5 + 3 * norm; c.lineCap = "round"; c.beginPath(); c.moveTo(q.x, q.y); c.lineTo(top.x, top.y); c.stroke();
      const gr = 3 + 7 * norm, rg = c.createRadialGradient(q.x, q.y, 0, q.x, q.y, gr);
      rg.addColorStop(0, `rgba(${tint},${.9 * fade})`); rg.addColorStop(1, `rgba(${tint},0)`);
      c.fillStyle = rg; c.beginPath(); c.arc(q.x, q.y, gr, 0, 6.2832); c.fill();
      c.fillStyle = `rgba(255,255,255,${.9 * fade})`; c.beginPath(); c.arc(top.x, top.y, 2, 0, 6.2832); c.fill();
      if (s.lastSale && Date.now() - s.lastSale < 6e5 && fade > 0) {
        const b = .5 + .5 * Math.sin(t * 3), pr = gr * (1.4 + .8 * b), bg = c.createRadialGradient(q.x, q.y, 0, q.x, q.y, pr);
        bg.addColorStop(0, `rgba(0,241,159,${.55 * fade * (.6 + .4 * b)})`); bg.addColorStop(1, "rgba(0,241,159,0)");
        c.fillStyle = bg; c.beginPath(); c.arc(q.x, q.y, pr, 0, 6.2832); c.fill();
      }
    }

    // Liseré du limbe : fin, plus vif en haut, qui s'éteint vers le bas.
    if (opts.halo !== false) {
      const lg = c.createLinearGradient(cx, cy - r, cx, cy - r + r * .9);
      lg.addColorStop(0, "rgba(204,199,255,.9)"); lg.addColorStop(.5, "rgba(107,92,242,.35)"); lg.addColorStop(1, "rgba(107,92,242,0)");
      c.strokeStyle = lg; c.lineWidth = 1.2; c.beginPath(); c.arc(cx, cy, r * 1.002, 0, 6.2832); c.stroke();
    }
  }

  function frame(now) {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (!visible || !W) return;
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (cam.tSpin != null) {
      let d = cam.tSpin - cam.spin;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      cam.spin += d * Math.min(1, dt * 5);
      cam.tilt += (cam.tTilt - cam.tilt) * Math.min(1, dt * 5);
      if (Math.abs(d) < .002) cam.tSpin = null;
    } else if (!dragging && !reduce && !highlight) cam.spin -= baseSpin * dt;
    cam.scale += (cam.tScale - cam.scale) * Math.min(1, dt * 8);
    draw(now);
  }

  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; last = performance.now(); });
  io.observe(host);
  const ro = new ResizeObserver(size);
  ro.observe(host);
  size();

  function pickAt(px, py) {
    let best = null, bd = 28;
    for (const s of spots) {
      if (!countries[s.cc] || s.value <= 0) continue;
      const q = project(unit(countries[s.cc].lat, countries[s.cc].lng));
      if (q.z <= 0) continue;
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < bd) { bd = d; best = s.cc; }
    }
    return best;
  }
  if (interactive) {
    host.addEventListener("pointerdown", e => { dragging = { x: e.clientX, y: e.clientY, spin: cam.spin, tilt: cam.tilt }; moved = 0; cam.tSpin = null; host.classList.add("drag"); host.setPointerCapture?.(e.pointerId); });
    host.addEventListener("pointermove", e => {
      if (!dragging) return;
      const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y; moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      const k = 1 / (radius() || 1);
      cam.spin = dragging.spin + dx * k; cam.tilt = Math.max(-1.2, Math.min(1.2, dragging.tilt + dy * k));
    });
    const end = e => {
      if (!dragging) return;
      dragging = null; host.classList.remove("drag");
      if (moved < 6) { const r = host.getBoundingClientRect(); opts.onTap?.(pickAt(e.clientX - r.left, e.clientY - r.top)); }
    };
    host.addEventListener("pointerup", end); host.addEventListener("pointercancel", () => { dragging = null; host.classList.remove("drag"); });
    if (opts.wheelZoom) host.addEventListener("wheel", e => { e.preventDefault(); cam.tScale = Math.max(.6, Math.min(5, cam.tScale * Math.exp(-e.deltaY * .002))); }, { passive: false });
  } else if (opts.onTap) host.addEventListener("click", () => opts.onTap(null));

  raf = requestAnimationFrame(frame);
  return {
    setSpots(next) { spots = next; heat = computeHeat(land, spots, countries); },
    setHighlight(cc) { highlight = cc; },
    focus(cc) { const co = countries[cc]; if (!co) return; cam.tSpin = -co.lng * Math.PI / 180; cam.tTilt = co.lat * Math.PI / 180 * .85; },
    zoomBy(f) { cam.tScale = Math.max(.6, Math.min(5, cam.tScale * f)); },
    reset() { cam.tScale = 1; cam.tTilt = .35; cam.tSpin = cam.spin; },
    destroy() { destroyed = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); },
  };
}

/** Revenu par pays d'un ensemble de business + dernière vente vue dans le flux. */
export function globeSpots(projects, feed = []) {
  const ids = new Set(projects.map(p => p.projectId)), by = {};
  for (const p of projects) for (const [cc, v] of Object.entries(p.revenueByCountry ?? {})) if (cc !== "??") by[cc] = (by[cc] ?? 0) + v / 1e6;
  const last = {};
  for (const e of feed) if ((e.priceMicros ?? 0) > 0 && ids.has(e.projectId) && e.country && !last[e.country]) last[e.country] = e.at;
  for (const cc of Object.keys(last)) if (by[cc] == null) by[cc] = .0001;
  return Object.entries(by).map(([cc, value]) => ({ cc, value, lastSale: last[cc] ?? null }));
}
