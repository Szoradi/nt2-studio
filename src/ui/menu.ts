/**
 * The menu bar. A title opens the list under it; while one list is open the pointer or the arrow
 * keys move to the others. The entries are ordinary buttons with their own click handlers: all
 * that happens here is showing and hiding the lists.
 */
export function wireMenus(bar: HTMLElement) {
  const menus = [...bar.querySelectorAll<HTMLElement>('.menu')];
  const titleOf = (m: HTMLElement) => m.querySelector<HTMLElement>('.menu-title')!;
  const itemsOf = (m: HTMLElement) => [...m.querySelectorAll<HTMLButtonElement>('.menu-pop button:not(:disabled)')];
  const opened = () => menus.find(m => m.classList.contains('open')) ?? null;

  function show(m: HTMLElement | null) {
    for (const x of menus) {
      x.classList.toggle('open', x === m);
      titleOf(x).setAttribute('aria-expanded', String(x === m));
    }
  }
  function close() {
    if (!opened()) return;
    show(null);
    // The keyboard goes back to the editor, not to a button left in focus
    if (bar.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  for (const m of menus) {
    const title = titleOf(m);
    title.addEventListener('click', () => { if (opened() === m) close(); else show(m); });
    title.addEventListener('pointerenter', () => { if (opened() && opened() !== m) { show(m); title.focus(); } });
    m.querySelector('.menu-pop')!.addEventListener('click', e => {
      const item = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!item) return;
      close();
      // An entry that stands for a button elsewhere on the page
      if (item.dataset.click) document.getElementById(item.dataset.click)?.click();
    });
  }
  document.addEventListener('pointerdown', e => {
    if (!(e.target as HTMLElement).closest?.('.menu')) close();
  }, true);
  window.addEventListener('blur', close);

  // While a list is open the keys belong to it, not to the editor under it
  document.addEventListener('keydown', e => {
    const m = opened();
    if (!m) return;
    e.stopPropagation();
    const items = itemsOf(m);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = (d: number) => items[(at + d + items.length) % items.length]?.focus();
    const side = (d: number) => {
      const next = menus[(menus.indexOf(m) + d + menus.length) % menus.length];
      show(next);
      itemsOf(next)[0]?.focus();
    };
    switch (e.key) {
      case 'Escape': close(); break;
      case 'ArrowDown': step(at < 0 ? 1 - items.length : 1); break;
      case 'ArrowUp': step(at < 0 ? 0 : -1); break;
      case 'ArrowRight': side(1); break;
      case 'ArrowLeft': side(-1); break;
      case 'Home': items[0]?.focus(); break;
      case 'End': items[items.length - 1]?.focus(); break;
      case 'Enter': case ' ': case 'Tab': return; // the button in focus takes these itself
      default: break;
    }
    e.preventDefault();
  }, true);
}
