import { icon } from './icons.js';

export function actionButton(label, glyph) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'message-action';
  button.setAttribute('aria-label',label); button.dataset.tooltip = label; button.append(icon(glyph)); return button;
}

export function copyButton(source, copy, {label = '复制回答', compact = true} = {}) {
  const button = actionButton(label,'copy'); button.classList.add('copy-action');
  if(!compact) {button.classList.add('code-copy');button.append(document.createTextNode('复制代码'));button.title = label;delete button.dataset.tooltip;}
  let pending = false, timer;
  function appearance(done) {
    button.replaceChildren(icon(done ? 'check' : 'copy'));
    if(!compact) button.append(document.createTextNode(done ? '已复制' : '复制代码'));
    button.classList.toggle('copied',done); button.setAttribute('aria-label',done ? '已复制' : label);
    if(compact) button.dataset.tooltip = done ? '已复制' : label; else button.title = done ? '已复制' : label;
  }
  button.performCopy = async text => {
    if(pending) return; pending = true; clearTimeout(timer); button.setAttribute('aria-busy','true');
    try {
      const ok = await copy(text);
      if(ok === false || ok === undefined) {appearance(false);return;}
      appearance(true);
      const feedback = document.getElementById('copy-feedback'); if(feedback) feedback.textContent = `${label}：已复制`;
      timer = setTimeout(() => {appearance(false);if(feedback) feedback.textContent = '';},2000);
    } finally {pending = false;button.removeAttribute('aria-busy');}
  };
  button.onclick = () => button.performCopy(source()); return button;
}

let menuNumber = 0;
export function moreMenu(button, items) {
  const menu = document.createElement('div'); menu.className = 'message-menu'; menu.id = `message-menu-${++menuNumber}`;
  menu.setAttribute('popover','auto'); menu.setAttribute('role','menu'); menu.setAttribute('aria-label','回答操作');
  button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-controls',menu.id);button.setAttribute('aria-expanded','false');
  const options = items.map(({label,glyph,action}) => {
    const option = document.createElement('button'); option.type = 'button';option.setAttribute('role','menuitem');option.tabIndex = -1;
    option.append(icon(glyph),document.createTextNode(label)); option.onclick = () => {menu.hidePopover();button.focus({preventScroll:true});action();}; menu.append(option);return option;
  });
  function open() {
    menu.showPopover(); const rect = button.getBoundingClientRect(), height = menu.offsetHeight, width = menu.offsetWidth;
    menu.style.left = `${Math.max(8,Math.min(innerWidth-width-8,rect.left))}px`;
    menu.style.top = `${Math.max(8,rect.bottom+height+8 < innerHeight ? rect.bottom+6 : rect.top-height-6)}px`;
    options[0]?.focus();
  }
  button.onclick = () => menu.matches(':popover-open') ? menu.hidePopover() : open();
  button.onkeydown = event => {if(event.key === 'ArrowDown') {event.preventDefault();open();}};
  menu.addEventListener('toggle',() => button.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
  menu.onkeydown = event => {
    const index = options.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {event.preventDefault();options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length-1 : (index+(event.key === 'ArrowDown' ? 1 : -1)+options.length)%options.length]?.focus();}
    if(event.key === 'Escape' || event.key === 'Tab') {if(event.key === 'Escape') event.preventDefault();menu.hidePopover();button.focus({preventScroll:true});}
  };
  return menu;
}

export function messagePlainText(content) {
  const clone = content.cloneNode(true);
  clone.querySelectorAll('.code-heading,button').forEach(node => node.remove());
  // Preserve line and table boundaries without copying toolbar labels.
  clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  clone.querySelectorAll('p,h1,h2,h3,h4,h5,h6,pre,li,blockquote,tr').forEach(node => node.append('\n'));
  clone.querySelectorAll('th,td').forEach(node => node.append('\t'));
  return clone.textContent.replace(/\t\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
