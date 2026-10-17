(() => {
  'use strict';
  function setupPanels(selector) {
    const buttons = [...document.querySelectorAll(selector)];
    if (!buttons.length) return;
    const attr = buttons[0].hasAttribute('data-aftercare') ? 'aftercare' : 'shopMode';
    const choose = id => {
      if (!buttons.some(button => button.dataset[attr] === id)) return;
      buttons.forEach(button => {
        const selected = button.dataset[attr] === id;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(button.dataset[attr]);
        if (panel) panel.hidden = !selected;
      });
    };
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => choose(button.dataset[attr]));
      button.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
        else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault(); buttons[next].click(); buttons[next].focus();
      });
    });
    const applyHash = () => choose(location.hash.slice(1));
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href*="#"]');
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname) choose(url.hash.slice(1));
    }, true);
    window.addEventListener('hashchange', applyHash);
    applyHash();
  }
  setupPanels('[data-aftercare]'); setupPanels('[data-shop-mode]');
  document.querySelector('#catalog-grid')?.addEventListener('click', event => {
    if (event.target.closest('[data-cart-add]')) {
      const cart = document.querySelector('#repairCartDetails'); if (cart) cart.open = true;
    }
  });
  function closeMenus() {
    document.querySelectorAll('.repair-menu[open]').forEach(menu => { menu.open = false; });
    document.querySelector('#mobileMenuToggle')?.setAttribute('aria-expanded', 'false');
    document.querySelector('#mainNavigation')?.classList.remove('mobile-open');
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.repair-menu, #mainNavigation, #mobileMenuToggle')) closeMenus();
    if (event.target.closest('.repair-menu nav a')) closeMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const open = document.querySelector('.repair-menu[open] summary, #mobileMenuToggle[aria-expanded="true"]');
      if (open) { closeMenus(); open.focus(); }
    }
  });
  document.addEventListener('aguia:catalog', event => {
    const count = (event.detail?.products || []).filter(p => p.active && p.fulfillment === 'ready' && Number(p.stock) > 0 && p.image_url).length;
    const label = document.querySelector('#readyModeCount'); if (label) label.textContent = count ? '(' + count + ')' : '';
  });
})();
