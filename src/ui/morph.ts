// Update a container to new HTML in place, keeping the elements that are still there. The
// instrument editor is rebuilt on every change, also while a slider is being dragged or a field is
// being typed in, and replacing the element under the pointer would end the drag.

function morphChildren(a: Node, b: Node) {
  const an = Array.from(a.childNodes), bn = Array.from(b.childNodes);
  const same = an.length === bn.length && an.every((n, i) => n.nodeType === bn[i].nodeType && n.nodeName === bn[i].nodeName);
  if (!same) {
    (a as Element).replaceChildren(...bn);
    return;
  }
  an.forEach((n, i) => {
    const m = bn[i];
    if (n.nodeType !== Node.ELEMENT_NODE) {
      if (n.nodeValue !== m.nodeValue) n.nodeValue = m.nodeValue;
      return;
    }
    const x = n as Element, y = m as Element;
    for (const at of Array.from(x.attributes)) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of Array.from(y.attributes)) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    morphChildren(x, y);
    if (x instanceof HTMLInputElement) {
      const yi = y as HTMLInputElement;
      if (x.type === 'checkbox') x.checked = yi.checked;
      // A field being typed in keeps what the user has typed so far
      else if ((x.type === 'range' || x !== document.activeElement) && x.value !== yi.value) x.value = yi.value;
    } else if (x instanceof HTMLSelectElement) x.value = (y as HTMLSelectElement).value;
  });
}

export function morphHtml(el: HTMLElement, html: string) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}
