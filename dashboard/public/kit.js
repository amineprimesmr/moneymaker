// Composants du design de l'app iPhone, transposés en HTML/SVG/canvas (mêmes tailles, mêmes courbes).
// Sources : RecoveryTileKit.swift, MMTheme.swift, HomeMetrics.swift, MMBadge.swift.

export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Icônes (dessinées à la main sur une grille de 24, pour remplacer les SF Symbols) ─────
const F = d => `<path fill="currentColor" d="${d}"/>`;
const S = (d, w = 2) => `<path fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`;
const ICONS = {
  grid: F("M4 3h6.5A1.5 1.5 0 0 1 12 4.5V10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 10V4.5A1.5 1.5 0 0 1 4 3Zm10 0h6a1.5 1.5 0 0 1 1.5 1.5V10a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 12.5 10V4.5A1.5 1.5 0 0 1 14 3ZM4 13h6.5a1.5 1.5 0 0 1 1.5 1.5V20a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 20v-5.5A1.5 1.5 0 0 1 4 13Zm10 0h6a1.5 1.5 0 0 1 1.5 1.5V20a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-5.5A1.5 1.5 0 0 1 14 13Z"),
  bolt: F("M13.4 1.6c.3-.6 1.2-.3 1.1.3l-1.3 7.8h6.1c.6 0 .9.7.5 1.1L9.9 22.3c-.5.5-1.3 0-1.1-.6l2-8h-6c-.6 0-1-.7-.6-1.2l9.2-10.9Z"),
  star: F("M12 2.2c.3 0 .6.2.7.5l2.6 6.3 6.8.5c.7 0 1 .9.4 1.3l-5.2 4.4 1.6 6.6c.2.7-.5 1.2-1.1.8L12 18.9l-5.8 3.6c-.6.4-1.3-.2-1.1-.8l1.6-6.6-5.2-4.4c-.5-.5-.2-1.3.4-1.3l6.8-.5 2.6-6.3c.1-.3.4-.5.7-.5Z"),
  trophy: F("M6.5 2.5h11c.5 0 .9.4.9.9V4h2.3c.7 0 1.3.6 1.3 1.3v1.4c0 2.6-2 4.8-4.6 5.1a6.6 6.6 0 0 1-4.1 3.2V18h2.3c1.2 0 2.1 1 2.1 2.1v.5c0 .5-.4.9-.9.9H7.2a.9.9 0 0 1-.9-.9v-.5c0-1.2 1-2.1 2.1-2.1h2.3v-2.9A6.6 6.6 0 0 1 6.6 11.8 5.2 5.2 0 0 1 2 6.7V5.3C2 4.6 2.6 4 3.3 4h2.3v-.6c0-.5.4-.9.9-.9ZM5.6 6H4v.7c0 1.4.9 2.6 2.1 3a7 7 0 0 1-.5-2.6V6Zm12.8 0v1.1c0 .9-.2 1.8-.5 2.6 1.2-.4 2.1-1.6 2.1-3V6h-1.6Z"),
  gear: S("M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm8 5.2-.1-3.6-2.2-.6-.6-1.4 1.2-2-2.5-2.5-2 1.2-1.4-.6L11.8 2H10l-.6 2.2-1.4.6-2-1.2-2.5 2.5 1.2 2-.6 1.4L2 10.2v3.6l2.2.6.6 1.4-1.2 2 2.5 2.5 2-1.2 1.4.6.6 2.2h3.6l.6-2.2 1.4-.6 2 1.2 2.5-2.5-1.2-2 .6-1.4 2.1-.6Z", 1.9),
  menu: S("M4.5 7.5h15M4.5 12h15M4.5 16.5h15", 1.8),
  left: S("M14.5 5 7.5 12l7 7", 2.3), right: S("M9.5 5l7 7-7 7", 2.3), down: S("m5 9 7 7 7-7", 2.3), up: S("m5 15 7-7 7 7", 2.3),
  cycle: S("M4 11a8 8 0 0 1 13.7-5.2L20 8m0-4.5V8h-4.5M20 13a8 8 0 0 1-13.7 5.2L4 16m0 4.5V16h4.5"),
  euro: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" d="M16.3 8.2a4.9 4.9 0 0 0-3.2-1.2c-2.5 0-4.4 2.2-4.4 5s1.9 5 4.4 5c1.2 0 2.4-.5 3.2-1.2M6.8 10.7h6.5M6.8 13.3h5.6"/>`,
  card: F("M4.2 4.5h15.6c1.2 0 2.2 1 2.2 2.2V8H2V6.7c0-1.2 1-2.2 2.2-2.2ZM2 10.5h20v6.8c0 1.2-1 2.2-2.2 2.2H4.2A2.2 2.2 0 0 1 2 17.30v-6.80Zm3 4a1 1 0 0 0 0 2h4a1 1 0 1 0 0-2H5Z"),
  hourglass: F("M6 2h12a1 1 0 0 1 0 2h-.5v2.2c0 2-1 3.80-2.80 5l-.9.80.9.80c1.80 1.20 2.80 3 2.80 5V20h.5a1 1 0 1 1 0 2H6a1 1 0 1 1 0-2h.5v-2.20c0-2 1-3.80 2.80-5l.9-.800-.9-.800C7.50 10 6.50 8.20 6.50 6.20V4H6a1 1 0 0 1 0-2Zm2.50 2v2.20c0 .4 0 .7.10 1h6.80c.1-.3.10-.6.10-1V4h-7Zm3.50 9.40-1.50 1.20c-1.20.900-2 2-2 3.20V20h7v-2.20c0-1.20-.8-2.30-2-3.20L12 13.40Z"),
  download: F("M6 2.50h12A3.50 3.50 0 0 1 21.50 6v12a3.50 3.50 0 0 1-3.50 3.50H6A3.50 3.50 0 0 1 2.50 18V6A3.50 3.50 0 0 1 6 2.50Zm6 3.70a1 1 0 0 0-1 1v5.70l-2.20-2.20a1 1 0 0 0-1.40 1.40l3.90 3.90a1 1 0 0 0 1.40 0l3.90-3.90a1 1 0 0 0-1.40-1.40L13 12.90V7.20a1 1 0 0 0-1-1Z"),
  sparkles: F("M10 3.50c.3 0 .5.20.6.40l1.30 4.20c.2.60.7 1.10 1.30 1.30l4.20 1.30c.5.20.5.90 0 1l-4.20 1.30c-.6.20-1.10.7-1.30 1.30L10.60 18.50c-.2.50-.9.50-1 0l-1.30-4.20c-.2-.6-.7-1.10-1.30-1.30l-4.20-1.30c-.5-.1-.5-.800 0-1L7 9.40c.6-.2 1.10-.7 1.30-1.30l1.30-4.20c.1-.3.30-.4.40-.4ZM18.50 2c.2 0 .3.10.4.30l.5 1.50c.1.30.3.50.6.60l1.50.5c.3.10.3.60 0 .7l-1.50.5c-.3.10-.5.30-.6.60l-.5 1.50c-.1.30-.6.30-.7 0l-.5-1.50c-.1-.3-.3-.5-.6-.6l-1.50-.5c-.3-.1-.3-.6 0-.7l1.50-.5c.3-.1.5-.3.6-.6l.5-1.50c0-.2.20-.3.30-.3Z"),
  people: F("M9 11.50a4.30 4.30 0 1 0 0-8.60 4.30 4.30 0 0 0 0 8.60Zm8 0a3.50 3.50 0 1 0 0-7 3.50 3.50 0 0 0 0 7ZM1.50 19c0-3.50 3.30-5.80 7.50-5.80s7.50 2.30 7.50 5.80c0 .8-.6 1.50-1.50 1.50H3c-.9 0-1.50-.7-1.50-1.50Zm16.90 1.50h2.60c.9 0 1.50-.6 1.50-1.40 0-2.90-2.60-5-6-5l-1.30.100c1.60 1.20 2.70 2.90 2.70 5 0 .5-.2 .9-.5 1.30Z"),
  person: S("M12 11.50a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.50 9c0-3.70 3.30-6 7.50-6s7.50 2.30 7.50 6", 1.8),
  calendar: S("M4 9.50h16M7.50 3v3.50M16.50 3v3.50M5.50 5h13A1.50 1.50 0 0 1 20 6.50v12a1.50 1.50 0 0 1-1.50 1.50h-13A1.50 1.50 0 0 1 4 18.50v-12A1.50 1.50 0 0 1 5.50 5Z", 1.8),
  divide: F("M4 11h16a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2Zm8-6.50a1.80 1.80 0 1 1 0 3.60 1.80 1.80 0 0 1 0-3.60Zm0 11.40a1.80 1.80 0 1 1 0 3.60 1.80 1.80 0 0 1 0-3.60Z"),
  cart: F("M2.50 3h2c.6 0 1.20.4 1.30 1l.4 1.50h15c.8 0 1.30.7 1.10 1.50l-1.80 7c-.2.70-.8 1.10-1.50 1.10H8.30c-.7 0-1.30-.5-1.50-1.20L4.20 5H2.50a1 1 0 0 1 0-2ZM9 17.50a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm9 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"),
  refresh: S("M20 12a8 8 0 1 1-2.30-5.70L20 8.50m0-5v5h-5"),
  undo: S("M9 6 4.50 10.50 9 15M4.50 10.50H15a4.50 4.50 0 0 1 0 9h-3"),
  xcircle: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-12 6 6m0-6-6 6", 1.8),
  undodown: S("M6.50 4v6.50c0 2.50 2 4.50 4.50 4.50h7m-4-4 4 4-4 4"),
  seal: F("M12 1.80 14.70 3.90l3.40-.3 1 3.20 2.80 2-1.20 3.20 1.20 3.20-2.80 2-1 3.20-3.40-.3L12 22.20l-2.70-2.10-3.40.3-1-3.20-2.80-2L3.30 12 2.10 8.80l2.80-2 1-3.20 3.40.3L12 1.80Zm4.30 7.30a1 1 0 0 0-1.40 0l-4 4-1.80-1.80a1 1 0 0 0-1.40 1.40l2.50 2.50a1 1 0 0 0 1.40 0l4.70-4.70a1 1 0 0 0 0-1.40Z"),
  list: S("M8.50 6h12M8.50 12h12M8.50 18h12M4 6h.01M4 12h.01M4 18h.01"),
  bag: F("M12 2a4.50 4.50 0 0 1 4.50 4.50V7h2.30c.8 0 1.50.6 1.60 1.40l1 11c.1 1-.7 1.80-1.60 1.80H4.20c-1 0-1.70-.8-1.60-1.80l1-11C3.70 7.60 4.40 7 5.20 7h2.30v-.5A4.50 4.50 0 0 1 12 2Zm0 2a2.50 2.50 0 0 0-2.50 2.50V7h5v-.5A2.50 2.50 0 0 0 12 4Z"),
  warning: F("M10.40 3.50c.7-1.20 2.50-1.20 3.20 0l8 14.20c.7 1.20-.2 2.80-1.60 2.80H4c-1.40 0-2.30-1.60-1.60-2.80l8-14.20ZM12 8.50a1 1 0 0 0-1 1v4.20a1 1 0 1 0 2 0V9.50a1 1 0 0 0-1-1Zm0 7.20a1.20 1.20 0 1 0 0 2.40 1.20 1.20 0 0 0 0-2.40Z"),
  play: F("M7 3.80c0-1 1-1.60 1.90-1.10l11.60 8c.8.50.8 1.70 0 2.20l-11.60 8c-.9.60-1.90 0-1.90-1V3.80Z"),
  playc: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-1.80-12.20 5 3.20-5 3.20V8.80Z", 1.8),
  checkc: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3.70-9 2.60 2.60 5-5", 1.8),
  checkf: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path fill="none" stroke="#fff" stroke-width="2.30" stroke-linecap="round" stroke-linejoin="round" d="m7.70 12.30 3 3 5.70-6"/>`,
  ring: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.70"/>`,
  plusc: `<path fill="currentColor" fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 5a1 1 0 0 0-1 1v3H8a1 1 0 1 0 0 2h3v3a1 1 0 1 0 2 0v-3h3a1 1 0 1 0 0-2h-3V8a1 1 0 0 0-1-1Z"/>`,
  gearf: F("M10.30 2h3.40l.6 2.50 1.70.7 2.20-1.40 2.40 2.40-1.40 2.20.7 1.70 2.50.6v3.40l-2.50.6-.7 1.70 1.40 2.20-2.40 2.40-2.20-1.40-1.70.7-.6 2.50h-3.40l-.6-2.50-1.70-.7-2.20 1.40-2.40-2.40 1.40-2.20-.7-1.70L1.60 13.70v-3.40l2.50-.6.70-1.70L3.40 5.80l2.40-2.40L8 4.80l1.70-.7L10.30 2ZM12 8.50a3.50 3.50 0 1 0 0 7 3.50 3.50 0 0 0 0-7Z"),
  phone: F("M8 1.50h8A2.50 2.50 0 0 1 18.50 4v16a2.50 2.50 0 0 1-2.50 2.50H8A2.50 2.50 0 0 1 5.50 20V4A2.50 2.50 0 0 1 8 1.50Zm4 17.40a1.20 1.20 0 1 0 0 2.40 1.20 1.20 0 0 0 0-2.40Z"),
  apple: F("M17.30 12.70c0-2.40 2-3.60 2.10-3.70-1.10-1.70-2.90-1.90-3.60-1.90-1.50-.2-3 .9-3.70.9-.8 0-2-.9-3.20-.9-1.70 0-3.20 1-4.10 2.50-1.70 3-.4 7.50 1.30 10 .8 1.20 1.80 2.50 3.10 2.50s1.70-.8 3.20-.8 2 .8 3.20.8 2.20-1.20 3-2.40c.9-1.40 1.30-2.70 1.30-2.80-.1 0-2.60-1-2.60-4.20ZM14.90 5.50c.7-.8 1.10-2 1-3.10-1 0-2.20.7-2.90 1.50-.6.70-1.20 1.90-1 3 1.10.1 2.20-.6 2.90-1.40Z"),
  link: S("M10 14a4 4 0 0 0 5.70 0l3-3a4 4 0 0 0-5.70-5.70l-1 1M14 10a4 4 0 0 0-5.70 0l-3 3A4 4 0 0 0 11 18.70l1-1", 1.8),
  search: S("M11 18.50a7.50 7.50 0 1 0 0-15 7.50 7.50 0 0 0 0 15Zm5.30-2.20L21 21"),
  xc: F("M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20ZM9.20 8a.9.9 0 0 0-.6 1.50L11.10 12l-2.50 2.50a.9.9 0 0 0 1.30 1.30l2.50-2.50 2.50 2.50a.9.9 0 0 0 1.30-1.30L13.70 12l2.50-2.50a.9.9 0 0 0-1.30-1.30L12.40 10.70 9.90 8.20A.9.9 0 0 0 9.20 8Z"),
  clock: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.50V12l3 2", 1.8),
  expand: S("M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"),
  ext: S("M7 17 17 7M9 7h8v8", 2.30),
  plus: S("M12 5v14M5 12h14", 2.20), minus: S("M5 12h14", 2.20),
  locate: S("M12 18.50a6.50 6.50 0 1 0 0-13 6.50 6.50 0 0 0 0 13Zm0-3.50a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2v3.50M12 18.50V22M2 12h3.50M18.50 12H22", 1.80),
  chart: S("M4 4v14.50A1.50 1.50 0 0 0 5.50 20H20M7.50 15l3.50-4.50 3.50 2.50 5-6.50"),
  dollar: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm2.80-11.80c-.5-.9-1.50-1.50-2.80-1.50-1.70 0-3 .9-3 2.20 0 3 6 1.50 6 4.40 0 1.30-1.30 2.20-3 2.20-1.30 0-2.30-.6-2.80-1.50M12 6v12", 1.70),
  square: S("M6 3.50h12A2.50 2.50 0 0 1 20.50 6v12a2.50 2.50 0 0 1-2.50 2.50H6A2.50 2.50 0 0 1 3.50 18V6A2.50 2.50 0 0 1 6 3.50Z", 1.70),
  globe: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.50 2.50 3.80 5.50 3.80 9S14.50 18.50 12 21c-2.50-2.50-3.80-5.50-3.80-9S9.50 5.50 12 3Z", 1.70),
  store: S("M4.50 10v9a1.50 1.50 0 0 0 1.50 1.50h12a1.50 1.50 0 0 0 1.50-1.50v-9M3 7.50 5 3.50h14l2 4c0 1.50-1.30 2.70-3 2.70s-3-1.20-3-2.70c0 1.50-1.30 2.70-3 2.70S9 9 9 7.50c0 1.50-1.30 2.70-3 2.70s-3-1.20-3-2.70Z", 1.70),
  tag: S("M3.50 12.50V5A1.50 1.50 0 0 1 5 3.50h7.50l8 8a1.50 1.50 0 0 1 0 2.10l-6.90 6.90a1.50 1.50 0 0 1-2.10 0l-8-8ZM8 8h.01", 1.80),
  renew: S("M17 2.50 20.50 6 17 9.50M3.50 11V9.50A3.50 3.50 0 0 1 7 6h13.50M7 21.50 3.50 18 7 14.50M20.50 13v1.50A3.50 3.50 0 0 1 17 18H3.50", 1.80),
  hash: S("M9 3.50 7 20.50M17 3.50l-2 17M4 9h17M3 15h17", 1.70),
  hammer: S("m14 7 3-3 3.50 3.50-3 3M14 7 4 17a2.10 2.10 0 0 0 3 3l10-10M14 7l3 3", 1.70),
  bell: F("M12 2a1.50 1.50 0 0 1 1.50 1.50v.700A6.50 6.50 0 0 1 18.50 10.50v3.80l1.60 2.60c.4.70 0 1.60-.9 1.60H4.80c-.9 0-1.30-.9-.9-1.60l1.60-2.60v-3.80a6.50 6.50 0 0 1 5-6.30v-.7A1.50 1.50 0 0 1 12 2Zm-2.80 18h5.60a2.80 2.80 0 0 1-5.60 0Z"),
  key: S("M15.50 3a5.50 5.50 0 0 0-5.30 7L3 17.20V21h3.80v-2.50h2.50V16h2.20l1-1a5.50 5.50 0 1 0 3-12Zm1 4.50h.01", 1.80),
  doc: F("M6.50 2h7.30c.4 0 .8.20 1.10.4l4.70 4.70c.3.30.4.70.4 1.10v11.30A2.50 2.50 0 0 1 17.50 22h-11A2.50 2.50 0 0 1 4 19.50v-15A2.50 2.50 0 0 1 6.50 2Zm1.50 10a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2H8Zm0 4a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2H8Z"),
  shield: F("M12 2c.2 0 .4 0 .5.10l7.50 2.80c.6.20 1 .8 1 1.40v5.20c0 5.20-3.60 8.80-8.50 10.40-.3.10-.7.10-1 0C6.60 20.30 3 16.70 3 11.50V6.30c0-.6.40-1.20 1-1.40l7.50-2.80c.1 0 .3-.1.50-.1Z"),
  life: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5.70 5.70l3.50 3.50M14.80 14.80l3.50 3.50M18.30 5.70l-3.50 3.50M9.20 14.80l-3.50 3.50", 1.80),
  chat: F("M4.50 3h15A2.50 2.50 0 0 1 22 5.50v10a2.50 2.50 0 0 1-2.50 2.50H12l-4.70 3.50c-.7.50-1.60 0-1.60-.8V18H4.50A2.50 2.50 0 0 1 2 15.50v-10A2.50 2.50 0 0 1 4.50 3Z"),
  safari: S("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.80-12.80-2.30 5.30-5.30 2.30 2.30-5.30 5.30-2.30Z", 1.80),
  logout: S("M14 4.50H6A1.50 1.50 0 0 0 4.50 6v12A1.50 1.50 0 0 0 6 19.50h8M10 12h10.50m-3.50-3.50 3.50 3.50-3.50 3.50", 1.90),
  crown: F("M3 7.50c0-.8 1-1.20 1.60-.6L8 10l3.20-6c.3-.6 1.30-.6 1.60 0L16 10l3.40-3.10c.6-.6 1.60-.2 1.60.6L19.80 17c-.1.90-.9 1.50-1.80 1.50H6c-.9 0-1.70-.6-1.80-1.50L3 7.50ZM6 20h12a1 1 0 1 1 0 2H6a1 1 0 1 1 0-2Z"),
};
export const ic = (name, size = 16, attrs = "") => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" ${attrs}>${ICONS[name] ?? ""}</svg>`;

// ── Formats (Int.money de l'app : le symbole collé au nombre) ────────────────────────────
const SYMBOLS = { EUR: "€", USD: "$", GBP: "£", JPY: "¥", CHF: "CHF", CAD: "CA$", AUD: "A$" };
const num = (v, d) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
export function money(micros, cur = "EUR", compact = false) {
  const v = (micros ?? 0) / 1e6, sym = SYMBOLS[cur] ?? `${cur} `, abs = Math.abs(v);
  if (compact && abs >= 1e6) return `${num(v / 1e6, abs >= 1e7 ? 0 : 1)} M${sym}`;
  if (compact && abs >= 1e4) return `${num(v / 1e3, abs >= 1e5 ? 0 : 1)} k${sym}`;
  const whole = abs >= 1000 || Math.abs(v - Math.round(v)) < 0.005;
  return `${num(v, whole ? 0 : 2)}${sym}`;
}
export const int = v => new Intl.NumberFormat("fr-FR").format(Math.round(v ?? 0));
export const flag = cc => cc && cc.length === 2 && cc !== "??" ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1a5 + c.charCodeAt(0))) : "🌐";

// ── Séries (dailySeries, halfOverHalf) ───────────────────────────────────────────────────
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export function dailySeries(byDay, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const t = Date.now() - i * 864e5, k = dayKey(t); out.push({ t, key: k, v: (byDay?.[k] ?? 0) / 1e6 }); }
  return out;
}
export function halfOverHalf(values) {
  if (values.length < 4) return null;
  const m = Math.floor(values.length / 2), a = values.slice(0, m).reduce((s, v) => s + v, 0), b = values.slice(m).reduce((s, v) => s + v, 0);
  return a > 0 ? (b - a) / a : null;
}
export const deltaBadge = d => d == null || !isFinite(d) ? "" :
  `<span class="delta ${d >= 0 ? "up" : "down"}">${ic(d >= 0 ? "ext" : "ext", 10, d >= 0 ? "" : 'style="transform:scaleY(-1)"')}${num(Math.abs(d * 100), 1)} %</span>`;

// ── Icône de business (ProjectIcon, avec repli sur l'initiale) ──────────────────────────
function hsb(h, s, b) {
  const f = (n, k = (n + h * 6) % 6) => b - b * s * Math.max(Math.min(k, 4 - k, 1), 0);
  return `rgb(${Math.round(f(5) * 255)},${Math.round(f(3) * 255)},${Math.round(f(1) * 255)})`;
}
const fnvHue = id => { let h = 2166136261; for (const c of new TextEncoder().encode(String(id))) h = Math.imul(h ^ c, 16777619) >>> 0; return (h % 360) / 360; };
const initialGradient = id => { const h = fnvHue(id); return `linear-gradient(135deg,${hsb(h, .52, .62)},${hsb((h + .08) % 1, .62, .38)})`; };
export function projectIcon(p, size = 40) {
  const id = p.projectId ?? p.id, name = p.name ?? "?", r = size * .2237;
  return `<span class="pi" style="width:${size}px;height:${size}px;border-radius:${r}px;font-size:${size * .42}px;background:${initialGradient(id)}">${esc(String(name).slice(0, 1).toUpperCase())}${p.iconUrl ? `<img src="${esc(p.iconUrl)}" alt="" style="position:absolute;inset:0" onerror="this.remove()">` : ""}</span>`;
}
export function platformKind(stores = []) { return stores.includes("app_store") ? "app_store" : stores.includes("play_store") ? "play_store" : stores.includes("stripe") ? "stripe" : stores[0] ?? null; }
export function platformMark(stores, size = 24) {
  switch (platformKind(stores)) {
    case "app_store": return `<span class="pm" style="width:${size}px;height:${size}px;background:#fff;color:#000">${ic("apple", size * .6)}</span>`;
    case "stripe": return `<span class="pm" style="width:${size}px;height:${size}px;background:rgb(99,92,255);color:#fff;font-weight:700;font-size:${size * .56}px">S</span>`;
    case "play_store": return `<span class="pm" style="width:${size}px;height:${size}px;background:rgb(51,179,102);color:#fff">${ic("play", size * .46)}</span>`;
    default: return "";
  }
}
export function storeBadges(stores = [], size = 13) {
  const k = platformKind(stores);
  if (!k) return "";
  const body = k === "app_store" ? `${ic("apple", size)}App Store` : k === "stripe" ? `<b style="color:rgb(99,92,255);font-weight:700">S</b>Stripe` : k === "play_store" ? `<span style="color:var(--accent)">${ic("play", size)}</span>Google Play` : `${ic("link", size)}${esc(k.replace(/_/g, " "))}`;
  return `<div class="store-badges" style="font-size:${size}px"><span>${body}</span></div>`;
}

// ── Éventail de logos (LogoFan) ─────────────────────────────────────────────────────────
export function logoFan(projects, focusId, size = 36) {
  const shown = projects.slice(0, 7), step = size * .88, rest = projects.length - shown.length;
  const width = shown.length * step + size * .4 + (rest > 0 ? 34 : 0);
  return `<div class="fan" style="width:${width}px">${shown.map((p, i) => {
    const on = p.projectId === focusId, dim = focusId && !on;
    return `<button class="${on ? "focus" : ""} ${dim ? "dim" : ""}" data-focus="${esc(p.projectId)}" aria-label="${esc(p.name)}" style="left:${i * step}px;z-index:${on ? 20 : 10 - i}">${projectIcon(p, size)}</button>`;
  }).join("")}${rest > 0 ? `<span class="more" style="left:${shown.length * step + size * .5}px">+${rest}</span>` : ""}</div>`;
}

// ── Tuile RecoveryWideTile ──────────────────────────────────────────────────────────────
export const dotsCanvas = (anchor = "topTrailing", seed = 0, reach = .7) => `<canvas class="dots" data-anchor="${anchor}" data-seed="${seed}" data-reach="${reach}"></canvas>`;
export const tileHead = (icon, title) => `<div class="tile-head">${ic(icon, 17)}<span>${esc(title)}</span></div>`;
export const vline = (values, { money: m = false } = {}) => `<div class="vline" data-v='${JSON.stringify(values.map(v => +(+v).toFixed(2)))}' data-money="${m ? 1 : 0}"></div>`;
export function sliderTrack(fraction, small = false) {
  const f = Math.min(Math.max(fraction, 0), 1), p = n => `${(n * 100).toFixed(1)}%`;
  const g = `linear-gradient(90deg,transparent,rgba(86,56,199,.75) ${p(Math.min(.12, f))},var(--violet) ${p(f)},rgba(86,56,199,.55) ${p(Math.min(1, f + .12))},transparent ${p(Math.min(1, f + .3))})`;
  return `<div class="track ${small ? "sm" : ""}"><i style="background:${g}"></i><b style="left:${p(f)}"></b></div>`;
}
export function wideTile({ icon, title, value, chart, anchor = "topTrailing", seed = 0, href, i = 0, attrs = "" }) {
  const tag = href ? "button" : "div";
  return `<${tag} class="tile anim-in plain-tile ${href ? "" : "static"}" ${href ? `data-href="${esc(href)}"` : ""} style="--i:${i}" ${attrs}>${dotsCanvas(anchor, seed)}
    <div class="tile-wide"><div class="l">${tileHead(icon, title)}<div class="v">${esc(value)}</div></div><div class="r">${chart}</div></div></${tag}>`;
}

// ── Grille de points (MetricDots) : même algorithme que l'app ───────────────────────────
const M64 = (1n << 64n) - 1n;
function dotNoise(col, row, seed) {
  let h = BigInt(col * 92821 + row * 68917 + seed * 1299709) & M64;
  h = ((h ^ (h >> 13n)) * 0x5bd1e995n) & M64;
  h ^= h >> 15n;
  return Number(h % 1000n) / 1000;
}
const ANCHORS = { topTrailing: [1, 0], bottomTrailing: [1, 1], topLeading: [0, 0], bottomLeading: [0, 1] };
export function paintDots(cv, { ink = "255,255,255", maxOpacity = .3 } = {}) {
  const r = cv.getBoundingClientRect(), W = cv.clientWidth || r.width, H = cv.clientHeight || r.height;
  if (!W || !H) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext("2d");
  c.scale(dpr, dpr);
  const [ax, ay] = ANCHORS[cv.dataset.anchor ?? "topTrailing"] ?? [1, 0], seed = Number(cv.dataset.seed ?? 0), reach = Number(cv.dataset.reach ?? .7);
  const sp = 4.6, dot = 1.5, ox = ax * W, oy = ay * H, radius = Math.max(W, H) * reach, s = ((seed * 37) % 100) / 100 * Math.PI * 2;
  const buckets = Array.from({ length: 24 }, () => []);
  for (let row = 0, nr = Math.ceil(H / sp); row <= nr; row++) for (let col = 0, nc = Math.ceil(W / sp); col <= nc; col++) {
    const x = col * sp, y = row * sp, dx = x - ox, dy = y - oy, a = Math.atan2(dy, dx);
    const wob = 1 + .22 * Math.sin(3 * a + s) + .14 * Math.sin(7 * a - 1.7 * s) + .08 * Math.sin(13 * a + 2.3 * s);
    const d = Math.hypot(dx, dy) / (radius * wob);
    if (d >= 1) continue;
    const n = dotNoise(col, row, seed);
    if (n <= .22) continue;
    const f = Math.pow(1 - d, 1.7) * (.35 + n * .9) / 1.25;
    buckets[Math.min(23, Math.max(0, Math.floor(f * 24)))].push(x, y);
  }
  buckets.forEach((b, i) => {
    if (!b.length) return;
    c.fillStyle = `rgba(${ink},${maxOpacity * 1.25 * (i + .5) / 24})`;
    c.beginPath();
    for (let k = 0; k < b.length; k += 2) { c.moveTo(b[k] + dot / 2, b[k + 1]); c.arc(b[k], b[k + 1], dot / 2, 0, 6.2832); }
    c.fill();
  });
}

// ── Courbe RecoveryVioletLine ───────────────────────────────────────────────────────────
let uid = 0;
const midBezier = pts => pts.map((p, i) => {
  if (!i) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const q = pts[i - 1], mx = (q[0] + p[0]) / 2;
  return `C${mx.toFixed(1)},${q[1].toFixed(1)} ${mx.toFixed(1)},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
}).join("");
const lineColors = m => m ? ["#40EB85", "#0F9E52"] : ["#8D6CF2", "#5638C7"];
function drawVLine(el) {
  const vals = JSON.parse(el.dataset.v || "[]"), W = el.clientWidth, H0 = el.clientHeight, pad = 8, H = H0 - pad * 2;
  if (!W || !H0) return;
  const [bright, deep] = lineColors(el.dataset.money === "1"), id = `v${++uid}`;
  const series = vals.length > 1 ? vals : [vals[0] ?? 0, vals[0] ?? 0];
  const lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const pts = series.map((v, i) => [i / (series.length - 1) * (W - 5) , pad + H * (1 - (hi === lo ? .1 : (v - lo) / span)) * .9 + H * .05]);
  const d = midBezier(pts), last = pts[pts.length - 1];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H0}" preserveAspectRatio="none"><defs>
    <linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bright}" stop-opacity=".22"/><stop offset="1" stop-color="${bright}" stop-opacity="0"/></linearGradient>
    <linearGradient id="${id}s" gradientUnits="userSpaceOnUse" x1="0" x2="${W}" y1="0" y2="0"><stop offset="0" stop-color="${deep}" stop-opacity=".3"/><stop offset=".45" stop-color="${deep}"/><stop offset="1" stop-color="${bright}"/></linearGradient>
    </defs>
    <path d="${d}L${last[0].toFixed(1)},${H0}L${pts[0][0].toFixed(1)},${H0}Z" fill="url(#${id}a)" opacity="0" style="animation:mmFadeIn .9s ease-out .15s forwards"/>
    <path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="filter:drop-shadow(0 0 6px ${bright}73);animation:mmDraw .9s ease-out .15s forwards"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="#fff" opacity="0" style="filter:drop-shadow(0 0 6px rgba(255,255,255,.8));animation:mmFadeIn .3s ease-out .95s forwards"/></svg>`;
}

// ── Grand graphique néon (NeonLine, page de détail) ─────────────────────────────────────
export const neon = (values, { money: m = false, labels = [] } = {}) => `<div class="neon" data-neon='${JSON.stringify(values.map(v => +(+v).toFixed(2)))}' data-money="${m ? 1 : 0}"></div>`;
function drawNeon(el) {
  const vals = JSON.parse(el.dataset.neon || "[]"), W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  const [bright, deep] = lineColors(el.dataset.money === "1"), id = `n${++uid}`;
  const series = vals.length > 1 ? vals : [vals[0] ?? 0, vals[0] ?? 0];
  const lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const pts = series.map((v, i) => [i / (series.length - 1) * W, H * (1 - (hi === lo ? .1 : (v - lo) / span)) * .86 + H * .07]);
  const d = midBezier(pts), last = pts[pts.length - 1];
  el._pts = pts;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs>
    <linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bright}" stop-opacity=".24"/><stop offset="1" stop-color="${bright}" stop-opacity="0"/></linearGradient>
    <linearGradient id="${id}s" gradientUnits="userSpaceOnUse" x1="0" x2="${W}" y1="0" y2="0"><stop offset="0" stop-color="${deep}" stop-opacity=".5"/><stop offset=".5" stop-color="${deep}"/><stop offset="1" stop-color="${bright}"/></linearGradient>
    <filter id="${id}b1" x="-5%" y="-40%" width="110%" height="180%"><feGaussianBlur stdDeviation="9"/></filter><filter id="${id}b2" x="-5%" y="-40%" width="110%" height="180%"><feGaussianBlur stdDeviation="3"/></filter></defs>
    <path d="${d}L${W},${H}L0,${H}Z" fill="url(#${id}a)" opacity="0" style="animation:mmFadeIn .6s ease-out .9s forwards"/>
    <g opacity="0" style="animation:mmFadeIn .6s ease-out .9s forwards"><path d="${d}" fill="none" stroke="${bright}" stroke-opacity=".55" stroke-width="12" filter="url(#${id}b1)"/><path d="${d}" fill="none" stroke="${bright}" stroke-opacity=".75" stroke-width="5" filter="url(#${id}b2)"/></g>
    <path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="animation:mmDraw 1.1s ease-out .3s forwards"/>
    <path d="${d}" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.1" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="animation:mmDraw 1.1s ease-out .3s forwards"/>
    <circle class="endp" cx="${last[0] - 2}" cy="${last[1]}" r="4.5" fill="#fff" opacity="0" style="filter:drop-shadow(0 0 6px #fff);animation:mmFadeIn .3s ease-out 1.3s forwards"/>
    <g class="sel" style="display:none"><line x1="0" x2="0" y1="0" y2="${H}" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 3"/><circle r="6" fill="#fff" style="filter:drop-shadow(0 0 8px ${bright})"/></g></svg>`;
}

// ── Courbe MMGlowChart (Business, Graphiques) ──────────────────────────────────────────
const catmull = pts => pts.map((p, i) => {
  if (!i) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const p0 = pts[i - 2] ?? pts[i - 1], p1 = pts[i - 1], p3 = pts[i + 1] ?? p;
  return `C${(p1[0] + (p[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p[1] - p0[1]) / 6).toFixed(1)} ${(p[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
}).join("");
/** points : [{ label, v, text }]. Axe de 4 dates, sélection au survol comme au doigt. */
export const glowChart = (points, { height = 150, axis = true } = {}) =>
  `<div class="gc" style="height:${height}px" data-axis="${axis ? 1 : 0}" data-gc='${esc(JSON.stringify(points))}'></div>`;
function drawGlow(el) {
  const points = JSON.parse(el.dataset.gc || "[]"), W = el.clientWidth, H = el.clientHeight, axis = el.dataset.axis === "1";
  if (!W || !H || points.length < 2) return;
  const id = `g${++uid}`, bottom = axis ? 20 : 0, ph = H - bottom, max = Math.max(...points.map(p => p.v), 0.0001) * 1.12, min = Math.min(0, ...points.map(p => p.v));
  const pts = points.map((p, i) => [i / (points.length - 1) * W, ph - ((p.v - min) / (max - min || 1)) * (ph - 4)]);
  const d = catmull(pts), n = points.length, ticks = axis ? [0, 1, 2, 3].map(k => Math.round(k * (n - 1) / 3.6)) : [];
  el._pts = pts; el._points = points;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs>
    <linearGradient id="${id}s" gradientUnits="userSpaceOnUse" x1="0" x2="${W}" y1="0" y2="0"><stop offset="0" stop-color="#2E8BFF"/><stop offset="1" stop-color="#00F19F"/></linearGradient>
    <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00F19F" stop-opacity=".28"/><stop offset=".55" stop-color="#2E8BFF" stop-opacity=".06"/><stop offset="1" stop-color="#2E8BFF" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map(k => `<line x1="${pts[k][0]}" x2="${pts[k][0]}" y1="0" y2="${ph}" stroke="rgba(255,255,255,.08)" stroke-width=".5" stroke-dasharray="2 4"/>`).join("")}
    <line x1="0" x2="${W}" y1="${ph}" y2="${ph}" stroke="rgba(255,255,255,.08)" stroke-width=".5" stroke-dasharray="2 4"/>
    <path d="${d}L${W},${ph}L0,${ph}Z" fill="url(#${id}f)" opacity="0" style="animation:mmFadeIn .7s ease-out .2s forwards"/>
    <path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="animation:mmDraw 1s ease-out forwards"/>
    ${ticks.map(k => `<text x="${pts[k][0]}" y="${H - 4}" font-size="10" fill="rgba(255,255,255,.34)" font-family="Helvetica Neue,Helvetica,Arial,sans-serif" text-anchor="${k === 0 ? "start" : "middle"}">${esc(points[k].label)}</text>`).join("")}
    <g class="sel" style="display:none"><line y1="0" y2="${ph}" stroke="rgba(255,255,255,.35)" stroke-dasharray="2 3"/><circle r="11" fill="#00F19F" opacity=".35"/><circle r="4.5" fill="#fff"/></g></svg>`;
}
function bindGlow(el) {
  if (el._bound) return;
  el._bound = true;
  let tip;
  const move = e => {
    const r = el.getBoundingClientRect(), pts = el._pts, ps = el._points;
    if (!pts) return;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((e.clientX - r.left) / r.width * (pts.length - 1))));
    const sel = el.querySelector(".sel");
    if (!sel) return;
    sel.style.display = "";
    sel.querySelector("line").setAttribute("x1", pts[i][0]); sel.querySelector("line").setAttribute("x2", pts[i][0]);
    sel.querySelectorAll("circle").forEach(c => { c.setAttribute("cx", pts[i][0]); c.setAttribute("cy", pts[i][1]); });
    tip ??= Object.assign(document.createElement("div"), { className: "gc-tip" });
    if (!tip.isConnected) el.append(tip);
    tip.textContent = `${ps[i].label} · ${ps[i].text ?? ps[i].v}`;
    tip.style.left = `${Math.max(60, Math.min(r.width - 60, pts[i][0]))}px`;
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerdown", move);
  el.addEventListener("pointerleave", () => { el.querySelector(".sel")?.style.setProperty("display", "none"); tip?.remove(); });
}

// ── Montage : dessine ce qui dépend de la taille réelle, et redessine au redimensionnement ─
const painters = [[".vline", drawVLine], [".neon", drawNeon], [".gc", drawGlow], ["canvas.dots", c => paintDots(c)]];
const ro = new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (target._w === target.clientWidth) continue;
    target._w = target.clientWidth;
    painters.find(([sel]) => target.matches(sel))?.[1](target);
  }
});
export function hydrate(root = document) {
  for (const [sel, paint] of painters) root.querySelectorAll(sel).forEach(el => { paint(el); el._w = el.clientWidth; ro.observe(el); });
  root.querySelectorAll(".gc").forEach(bindGlow);
}

// ── Anneau (RateTile) ───────────────────────────────────────────────────────────────────
export function ringSvg(frac, color = "var(--accent)", size = 42, lw = 5) {
  const r = (size - lw) / 2, c = 2 * Math.PI * r, f = Math.min(Math.max(frac, 0), 1);
  return `<svg class="ring" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="${lw}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-linecap="round" stroke-dasharray="${(f * c).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
}

// ── Badges des ventes (MMBadge.swift) ───────────────────────────────────────────────────
const C = { purple: "184,140,255", blue: "115,148,255", green: "51,217,128", teal: "77,204,217", orange: "255,158,64", red: "255,97,97", grey: "255,255,255" };
export function eventBadge(e) {
  const m = {
    NON_RENEWING_PURCHASE: ["ONE TIME", "purple", 1], TRIAL_STARTED: ["TRIAL", "teal", 1], TRIAL_CONVERTED: ["CONVERSION", "green"], RENEWAL: ["RENEWAL", "green", 1],
    UNCANCELLATION: ["REACTIVATED", "green"], BILLING_RECOVERED: ["RECOVERED", "green"], PRODUCT_CHANGE: ["PLAN CHANGE", "blue"], CANCELLATION: ["CANCELLED", "orange"],
    BILLING_ISSUE: ["BILLING ISSUE", "orange"], PAUSED: ["PAUSED", "grey"], EXPIRATION: ["EXPIRED", "grey"], REFUND: ["REFUND", "red"], REVOKED: ["REFUND", "red"], GRANT: ["PROMO", "purple", 1],
  };
  if (e.type === "INITIAL_PURCHASE") return e.isTrial ? { label: "TRIAL", color: C.teal, free: true } : { label: "NEW SUB", color: C.blue, free: true };
  const [label, color, free] = m[e.type] ?? [String(e.type ?? "").replace(/_/g, " "), "grey"];
  return { label, color: C[color], free: Boolean(free), grey: color === "grey" };
}
export const tbadge = (b, on = .16) => `<span class="tbadge" style="color:rgba(${b.color},${b.grey ? .6 : 1});background:rgba(${b.color},${b.grey ? .1 : on})">${esc(b.label)}</span>`;
const STORE_LABEL = { app_store: "App Store", play_store: "Google Play", stripe: "Stripe", promotional: "Promo", web: "Web", mac_app_store: "Mac App Store", amazon: "Amazon" };
export const storeLabel = s => s ? STORE_LABEL[s] ?? String(s).replace(/_/g, " ") : null;
export const isRevenueEvent = e => (e.priceMicros ?? 0) > 0 && !["TRIAL_STARTED", "CANCELLATION", "EXPIRATION", "BILLING_ISSUE", "PAUSED", "REFUND", "REVOKED", "PRODUCT_CHANGE"].includes(e.type);

// ── Divers ──────────────────────────────────────────────────────────────────────────────
export const stars = v => { const n = Math.round(v); return `<span class="stars">${[1, 2, 3, 4, 5].map(i => `<span style="opacity:${i <= n ? 1 : .25}">${ic("star", 11)}</span>`).join("")}</span>`; };
export const skeleton = (n = 4, h = 100) => Array.from({ length: n }, () => `<div class="skeleton" style="height:${h}px"></div>`).join("");
export function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}
