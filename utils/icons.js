// A small hand-drawn icon set, replacing emoji as UI chrome (nav, stat
// tiles, section headers, module cards, alerts) throughout the app.
//
// Emoji stays where it is content rather than chrome — a category's icon
// (categories.icon in the schema), an account type's icon, a goal's icon.
// Those are a deliberate, common pattern in consumer finance apps for quick
// colourful tagging of user data, not the thing that made this app's own
// chrome read as generated: a stat card, a nav item, or a module tile using
// an emoji is reaching for whatever's on the keyboard instead of drawing
// something, and it looks like it every time.
//
// One consistent hand: 24x24, no fill except where a shape wants a solid
// centre (a dot, a filled dot in a target), 1.6 stroke, round caps and
// joins — the same treatment as the icons already drawn for the landing
// page, so the whole app reads as one hand rather than the landing page
// being the one place somebody drew something.

const ICONS = {
  money: '<path d="M4 8h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z"/><path d="M4 8l2.5-4h11L20 8"/><circle cx="12" cy="12.5" r="2.4"/>',
  moneyOut: '<path d="M12 4v13"/><path d="M7 13l5 5 5-5"/><path d="M5 21h14"/>',
  moneyIn: '<path d="M12 20V7"/><path d="M7 11l5-5 5 5"/><path d="M5 3h14"/>',
  trendingUp: '<path d="M4 17l6-6 4 4 6-8"/><path d="M15 6h5v5"/>',
  trendingDown: '<path d="M4 7l6 6 4-4 6 8"/><path d="M15 18h5v-5"/>',
  barChart: '<path d="M3 20.5h18"/><path d="M6 20.5v-7M12 20.5V6M18 20.5v-4.5"/>',
  receipt: '<path d="M6 2.5h12v18.3l-2.4-1.4-1.9 1.4-1.9-1.4-1.9 1.4-1.9-1.4-1.9 1.4-2.1-1.4V2.5Z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  bell: '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4.2 1.4 5.7 2 6.3H4.5c.6-.6 2-2.1 2-6.3Z"/><path d="M10.3 19a1.9 1.9 0 0 0 3.4 0"/>',
  target: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.3l2.5 2.5 5-5.2"/>',
  alertTriangle: '<path d="M12 4.2 21 19.5H3L12 4.2Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  alertCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16"/><path d="M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.3 2"/>',
  bank: '<path d="M4 9.5 12 4l8 5.5"/><path d="M5 9.5v9.5M9.3 9.5v9.5M14.7 9.5v9.5M19 9.5v9.5"/><path d="M4 19h16"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="12" rx="2"/><path d="M3.5 10.5h17"/><circle cx="16.5" cy="14" r="1" fill="currentColor" stroke="none"/>',
  card: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.3h18"/><path d="M6.5 15h4"/>',
  phone: '<rect x="7.5" y="3" width="9" height="18" rx="2"/><path d="M11 18h2"/>',
  storefront: '<path d="M4 9l1-5h14l1 5"/><path d="M4 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/><path d="M5 9.3V20h14V9.3"/><path d="M10 20v-6h4v6"/>',
  factory: '<path d="M4 20V9l5 3.5V9l5 3.5V9l6 4v7Z"/><path d="M4 20h16"/><path d="M8 14v6M13 14v6"/>',
  box: '<path d="M3.5 8 12 4l8.5 4-8.5 4-8.5-4Z"/><path d="M3.5 8v9L12 21l8.5-4V8"/><path d="M12 12v9"/>',
  truck: '<rect x="2.5" y="8" width="11" height="8.5" rx="1"/><path d="M13.5 11h4l3 3v2.5h-7Z"/><circle cx="7" cy="18.3" r="1.5"/><circle cx="16.5" cy="18.3" r="1.5"/>',
  arrowUpBox: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M12 16V9M9 12l3-3 3 3"/>',
  arrowDownBox: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M12 8v7M9 12l3 3 3-3"/>',
  users: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19.5c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><path d="M16 8.3a3 3 0 0 1 0 5.9"/><path d="M18.5 14.4c2 .5 3 2.2 3 5.1"/>',
  chat: '<path d="M4 5.5h16v10.5H9.5L5 20v-4H4Z"/><path d="M8 9.5h8M8 12.5h5"/>',
  document: '<path d="M7 2.5h7l4 4v14.5H7Z"/><path d="M14 2.5v4h4"/><path d="M9.5 12h5M9.5 15.3h5"/>',
  folder: '<path d="M3.5 6.5h6l2 2.5h9v10.5h-17Z"/>',
  scale: '<path d="M12 3.5v17"/><path d="M5 20.5h14"/><path d="M12 6.5 5.5 9.5l3 6.5h7l3-6.5Z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.3M12 18.2v2.3M20.5 12h-2.3M5.8 12H3.5M17.8 6.2l-1.6 1.6M7.8 16.2l-1.6 1.6M17.8 17.8l-1.6-1.6M7.8 7.8 6.2 6.2"/>',
  briefcase: '<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M8.5 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/><path d="M3 12.5h18"/>',
  tag: '<path d="M12.5 3.5h6.5v6.5L10 19 3.5 12.5Z"/><circle cx="16" cy="8" r="1" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M4.5 12a7.5 7.5 0 0 1 12.6-5.5M19.5 12a7.5 7.5 0 0 1-12.6 5.5"/><path d="M17.5 3.5v3.5H14M6.5 20.5V17H10"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 6.5 12 13l8.5-6.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M19.5 19.5l-4.3-4.3"/>',
  edit: '<path d="M14.5 4.5 19 9l-10 10H4.5v-4.5Z"/><path d="M12.5 6.5 17 11"/>',
  star: '<path d="M12 3.5l2.7 5.7 6.2.7-4.6 4.3 1.2 6.2L12 17.3l-5.5 3.1 1.2-6.2-4.6-4.3 6.2-.7Z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.4 3.8 5.4 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.4-3.8-8.5S9.5 5.9 12 3.5Z"/>',
  seedling: '<path d="M12 20v-8"/><path d="M12 12C12 8 9 6 5 6c0 4 3 6 7 6Z"/><path d="M12 12c0-3 2-5 6-5 0 3.5-2.5 5-6 5Z"/>',
  building: '<rect x="5" y="3.5" width="14" height="17" rx="1"/><path d="M8.5 7h1.5M14 7h1.5M8.5 11h1.5M14 11h1.5M8.5 15h1.5M14 15h1.5"/><path d="M10 20.5v-4h4v4"/>',
  layers: '<path d="M12 3.5 20.5 8 12 12.5 3.5 8Z"/><path d="M3.5 12 12 16.5 20.5 12"/><path d="M3.5 16 12 20.5 20.5 16"/>',
  bolt: '<path d="M13 3 5 13.5h6L11 21l8-10.5h-6Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  droplet: '<path d="M12 3.5c3 3.8 6 7.7 6 11a6 6 0 0 1-12 0c0-3.3 3-7.2 6-11Z"/>',
  send: '<path d="M4 12 20 4l-6.5 16-3-6.5L4 12Z"/>',
  scissors: '<circle cx="6" cy="6.5" r="2.3"/><circle cx="6" cy="17.5" r="2.3"/><path d="M20 5 7.7 11M20 19 7.7 13"/>',
  bulb: '<path d="M9 18.5h6"/><path d="M9.5 21h5"/><path d="M12 3.5a6 6 0 0 0-3.5 10.9c.8.6 1.5 1.5 1.5 2.6h4c0-1.1.7-2 1.5-2.6A6 6 0 0 0 12 3.5Z"/>',
  play: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l6 3.5-6 3.5Z" fill="currentColor" stroke="none"/>',
  pause: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5v7M14 8.5v7"/>',
  swap: '<path d="M4 8h13M13.5 4.5 17 8l-3.5 3.5"/><path d="M20 16H7M10.5 12.5 7 16l3.5 3.5"/>',
  wave: '<path d="M3 15c1.5-3 3.5-3 5 0s3.5 3 5 0 3.5-3 5 0 2.5 2 3 2"/>',
  trophy: '<path d="M7 4.5h10v5a5 5 0 0 1-10 0Z"/><path d="M7 6H4.5A2.5 2.5 0 0 0 7 10.5M17 6h2.5A2.5 2.5 0 0 1 17 10.5"/><path d="M12 14.5V18"/><path d="M8.5 20.5h7"/>',
  calculator: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8 6.5h8"/><path d="M8.2 11h.01M12 11h.01M15.8 11h.01M8.2 14.6h.01M12 14.6h.01M15.8 14.6h.01M8.2 18.2h.01M12 18.2h.01M15.8 18.2h.01"/>',
  megaphone: '<path d="M3 10.5v3l4 1v-5Z"/><path d="M7 9.2v6.6l9 3V6.2Z"/><path d="M16 8.5a4 4 0 0 1 0 7"/><path d="M8.5 16.5 10 21"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 13 4.5a3.5 3.5 0 0 1 5 5l-2 2"/><path d="M13 17.5l-2 2a3.5 3.5 0 0 1-5-5l2-2"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 9.3V20h12V9.3"/><path d="M10 20v-6h4v6"/>'
};

export function icon(name, className = "") {
  const body = ICONS[name];
  if (!body) {
    throw new Error(`Unknown icon "${name}" — add it to utils/icons.js or fix the caller.`);
  }
  const cls = className ? ` class="icon ${className}"` : ' class="icon"';
  return `<svg${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
