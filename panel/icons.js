// Inline SVG icons (stroke style, currentColor) so they follow Orca's theme.

const P = {
  branch: '<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="5.5" r="1.6"/><path d="M5 5.6v4.8M11 7.1c0 2.4-2 3-6 3.3"/>',
  current: '<path d="M2.5 3.5h7l4 4.5-4 4.5h-7z" fill="currentColor" fill-opacity=".25"/><circle cx="6" cy="8" r="1.2" fill="currentColor"/>',
  commit: '<circle cx="8" cy="8" r="2.4"/><path d="M1.5 8h4.1M10.4 8h4.1"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.4" cy="5.4" r="1" fill="currentColor"/>',
  folder: '<path d="M1.8 4.2c0-.6.4-1 1-1h3.3l1.4 1.5h5.7c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"/>',
  remote: '<path d="M4.5 12.5h7a3 3 0 0 0 .5-5.96A4 4 0 0 0 4.3 6.1 3.2 3.2 0 0 0 4.5 12.5z"/>',
  star: '<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"/>',
  'star-filled': '<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z" fill="currentColor"/>',
  'chevron-right': '<path d="M6 3.5L10.5 8 6 12.5"/>',
  'chevron-down': '<path d="M3.5 6L8 10.5 12.5 6"/>',
  back: '<path d="M10 3.5L5.5 8 10 12.5"/>',
  'arrow-down': '<path d="M8 2.5v11M3.8 9.3L8 13.5l4.2-4.2"/>',
  'arrow-up': '<path d="M8 13.5v-11M3.8 6.7L8 2.5l4.2 4.2"/>',
  fetch: '<path d="M8 2v8.5M4.5 7l3.5 3.5L11.5 7"/><path d="M2.5 11v2.5h11V11"/>',
  update: '<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5"/><path d="M3 13.5h10"/>',
  push: '<path d="M8 13.5V5M4.5 8.5L8 5l3.5 3.5"/><path d="M3 2.5h10"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6"/>',
  menu: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9"/>'
}

export function icon(name, size = 14) {
  const span = document.createElement('span')
  span.style.display = 'inline-flex'
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`
  return span
}

// The search field's magnifier.
document.querySelector('.search-icon')?.append(icon('search', 13))
