// Shared local geometry keeps icons consistent without fonts or network assets.
const paths = {
  code: ['m8 7-5 5 5 5', 'm16 7 5 5-5 5', 'm14 4-4 16'],
  command: ['M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7'],
  plus: ['M12 5v14', 'M5 12h14'],
  folder: ['M3 7V5h6l2 2h10v13H3Z'],
  search: ['M15 15l5 5'],
  archive: ['M3 4h18v4H3Z', 'M5 8v12h14V8', 'M10 12h4'],
  restore: ['M4 10a8 8 0 1 1 1 8', 'M4 4v6h6'],
  edit: ['m15 4 5 5-11 11H4v-5Z', 'm12 7 5 5'],
  pin: ['m8 3 8 0-1 7 4 4H5l4-4Z', 'M12 14v7'],
  trash: ['M4 6h16', 'M9 6V3h6v3', 'm6 6 1 15h10l1-15', 'M10 10v7', 'M14 10v7'],
  'panel-left': ['M3 4h18v16H3Z', 'M9 4v16'],
  'panel-right': ['M3 4h18v16H3Z', 'M15 4v16'],
  settings: ['M4 7h16', 'M4 17h16', 'M8 4v6', 'M16 14v6'],
  moon: ['M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z'],
  sun: ['M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'm5 5 1 1', 'm18 18 1 1', 'm5 19 1-1', 'm18 6 1-1'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  send: ['M12 19V5', 'm6 11 6-6 6 6'],
  stop: ['M6 6h12v12H6Z'],
  file: ['M5 3h9l5 5v13H5Z', 'M14 3v6h5'],
  terminal: ['m4 6 6 6-6 6', 'M13 18h7'],
  up: ['m6 12 6-6 6 6', 'M12 6v14'],
  down: ['m6 12 6 6 6-6', 'M12 4v14'],
  refresh: ['M20 10a8 8 0 0 0-14-4', 'M4 14a8 8 0 0 0 14 4', 'M20 4v6h-6', 'M4 20v-6h6'],
  copy: ['M9 8h11v13H9Z', 'M15 8V3H4v13h5'],
  check: ['m5 12 4 4L19 6'],
  branch: ['M7 3v18', 'M7 14c0-5 10-3 10-8V3', 'm14 6 3-3 3 3'],
  more: [],
  select: ['M4 8V4h4', 'M16 4h4v4', 'M20 16v4h-4', 'M8 20H4v-4', 'M8 10h8', 'M8 14h8'],
  quote: ['M4 5h7v8H7l-3 6v-6Z', 'M14 5h7v8h-4l-3 6v-6Z'],
  chevron: ['m9 5 7 7-7 7'],
};
export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'ui-icon', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  for (const d of paths[name] || paths.file) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  if (name === 'search' || name === 'sun') { const circle = document.createElementNS(ns, 'circle'); circle.setAttribute('cx', name === 'sun' ? '12' : '10'); circle.setAttribute('cy', name === 'sun' ? '12' : '10'); circle.setAttribute('r', name === 'sun' ? '4' : '6'); svg.prepend(circle); }
  if(name === 'more') for(const x of [5,12,19]) {const circle = document.createElementNS(ns,'circle');circle.setAttribute('cx',String(x));circle.setAttribute('cy','12');circle.setAttribute('r','1.4');circle.setAttribute('fill','currentColor');circle.setAttribute('stroke','none');svg.append(circle);}
  return svg;
}
export function hydrateIcons() { for (const placeholder of document.querySelectorAll('[data-icon]')) placeholder.replaceWith(icon(placeholder.dataset.icon)); }
