"use strict";
(() => {
  const config = window.AGUIA_SUPABASE_CONFIG || {};
  const baseUrl = typeof config.url === "string" ? config.url.replace(/\/$/, "") : "";
  const publishableKey = typeof config.publishableKey === "string" ? config.publishableKey : "";
  const isConfigured = Boolean(baseUrl && publishableKey);
  const cartStorageKey = "aguia-repair-cart-v1";
  const storeWhatsApp = "5527998784657";
  let quoteCredentials = null;
  let catalogById = new Map();
  let cartQuantities = loadCart();

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);

  const setMessage = (element, message, isError = false) => {
    if (!element) return;
    element.classList.toggle("lookup-error", isError);
    element.textContent = message;
  };

  function loadCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(cartStorageKey) || "[]");
      if (!Array.isArray(saved)) return new Map();
      return new Map(saved.filter(row => row && typeof row.id === "string" && Number.isInteger(row.quantity) && row.quantity > 0 && row.quantity <= 99)
        .map(row => [row.id, row.quantity]));
    } catch { return new Map(); }
  }

  function saveCart() {
    try {
      localStorage.setItem(cartStorageKey, JSON.stringify(Array.from(cartQuantities, ([id, quantity]) => ({ id, quantity }))));
    } catch { /* The cart still works for this page view if storage is unavailable. */ }
  }

  function formatMoney(value) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
  }

  function renderCart() {
    const cartItemsElement = document.querySelector("#cart-items");
    const cartCount = document.querySelector("#cart-count");
    const cartTotal = document.querySelector("#cart-total");
    const checkout = document.querySelector("#checkout-whatsapp");
    if (!cartItemsElement || !cartCount || !cartTotal || !checkout) return;

    const entries = Array.from(cartQuantities, ([id, quantity]) => ({ item: catalogById.get(id), quantity }))
      .filter(entry => entry.item);
    const totalQuantity = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    const hasUnpricedItems = entries.some(({ item }) => item.price === null || item.price === "");
    const subtotal = entries.reduce((sum, { item, quantity }) => sum + (item.price === null || item.price === "" ? 0 : Number(item.price) * quantity), 0);
    cartCount.textContent = `${totalQuantity} ${totalQuantity === 1 ? "item" : "itens"}`;
    cartTotal.textContent = hasUnpricedItems ? `Subtotal informado: ${formatMoney(subtotal)} · há preço a confirmar` : `Total: ${formatMoney(subtotal)}`;
    checkout.disabled = entries.length === 0;

    if (!entries.length) {
      cartItemsElement.innerHTML = '<p class="cart-empty">Seu carrinho está vazio.</p>';
      return;
    }
    cartItemsElement.innerHTML = entries.map(({ item, quantity }) => {
      const priceText = item.price === null || item.price === ""
        ? "Preço a confirmar"
        : `${quantity} × ${formatMoney(Number(item.price))} = ${formatMoney(Number(item.price) * quantity)}`;
      return `<div class="cart-row"><div><div class="cart-item-title">${escapeHtml(item.name)}</div><p class="cart-item-price">${priceText}</p></div><div class="cart-controls"><button type="button" data-cart-action="decrease" data-cart-id="${escapeHtml(item.id)}" aria-label="Diminuir ${escapeHtml(item.name)}">−</button><span>${quantity}</span><button type="button" data-cart-action="increase" data-cart-id="${escapeHtml(item.id)}" aria-label="Aumentar ${escapeHtml(item.name)}">+</button><button class="cart-remove" type="button" data-cart-action="remove" data-cart-id="${escapeHtml(item.id)}" aria-label="Remover ${escapeHtml(item.name)}">Remover</button></div></div>`;
    }).join("");
  }

  function setupCart() {
    const grid = document.querySelector("#catalog-grid");
    const cartItemsElement = document.querySelector("#cart-items");
    const checkout = document.querySelector("#checkout-whatsapp");
    grid?.addEventListener("click", event => {
      const button = event.target.closest("[data-cart-add]");
      if (!button) return;
      const id = button.dataset.cartAdd;
      if (!catalogById.has(id)) return;
      cartQuantities.set(id, Math.min(99, (cartQuantities.get(id) || 0) + 1));
      saveCart();
      renderCart();
    });
    cartItemsElement?.addEventListener("click", event => {
      const button = event.target.closest("[data-cart-action]");
      if (!button) return;
      const id = button.dataset.cartId;
      const quantity = cartQuantities.get(id) || 0;
      if (button.dataset.cartAction === "remove" || (button.dataset.cartAction === "decrease" && quantity <= 1)) cartQuantities.delete(id);
      else if (button.dataset.cartAction === "decrease") cartQuantities.set(id, quantity - 1);
      else if (button.dataset.cartAction === "increase") cartQuantities.set(id, Math.min(99, quantity + 1));
      saveCart();
      renderCart();
    });
    checkout?.addEventListener("click", () => {
      const entries = Array.from(cartQuantities, ([id, quantity]) => ({ item: catalogById.get(id), quantity }))
        .filter(entry => entry.item);
      if (!entries.length) return;
      const hasUnpricedItems = entries.some(({ item }) => item.price === null || item.price === "");
      const subtotal = entries.reduce((sum, { item, quantity }) => sum + (item.price === null || item.price === "" ? 0 : Number(item.price) * quantity), 0);
      const lines = ["Olá! Quero pedir pelo site da Águia Repair:", "", ...entries.map(({ item, quantity }) => {
        const lineTotal = item.price === null || item.price === "" ? "preço a confirmar" : formatMoney(Number(item.price) * quantity);
        return `• ${item.name} — ${quantity} un. — ${lineTotal}`;
      }), "", hasUnpricedItems ? `Subtotal dos itens com preço informado: ${formatMoney(subtotal)}. Há preço(s) a confirmar.` : `Total dos produtos: ${formatMoney(subtotal)}.`, "Por favor, confirme disponibilidade e combine a entrega/retirada."];
      window.location.href = `https://wa.me/${storeWhatsApp}?text=${encodeURIComponent(lines.join("\n"))}`;
    });
    renderCart();
  }

  async function loadCatalog() {
    const grid = document.querySelector("#catalog-grid");
    if (!grid || !isConfigured) return;
    try {
      const query = new URLSearchParams({
        select: "id,name,description,price,image_url",
        is_published: "eq.true",
        order: "position.asc,name.asc"
      });
      const response = await fetch(`${baseUrl}/rest/v1/catalog_items?${query}`, {
        headers: { apikey: publishableKey, Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("catalog_unavailable");
      const items = await response.json();
      if (!items.length) {
        catalogById = new Map();
        renderCart();
        grid.innerHTML = '<p class="catalog-empty">Ainda não há produtos publicados. <a href="https://wa.me/5527998784657?text=Ol%C3%A1%2C%20quero%20saber%20quais%20produtos%20est%C3%A3o%20dispon%C3%ADveis." target="_blank" rel="noopener noreferrer">Pergunte à equipe pelo WhatsApp ↗</a></p>';
        return;
      }
      catalogById = new Map(items.map(item => [String(item.id), item]));
      cartQuantities = new Map(Array.from(cartQuantities).filter(([id]) => catalogById.has(id)));
      saveCart();
      grid.innerHTML = items.map(item => {
        const image = item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "";
        const price = item.price === null ? '<p class="catalog-price">Consulte o preço</p>' : `<p class="catalog-price">${formatMoney(Number(item.price))}</p>`;
        return `<article class="catalog-card">${image}<div class="catalog-card-body"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description)}</p>${price}<button class="cart-add-button" type="button" data-cart-add="${escapeHtml(item.id)}" aria-label="Adicionar ${escapeHtml(item.name)} ao carrinho">Adicionar ao carrinho</button></div></article>`;
      }).join("");
      renderCart();
    } catch {
      grid.innerHTML = '<p class="catalog-empty">O catálogo está temporariamente indisponível. <a href="https://wa.me/5527998784657" target="_blank" rel="noopener noreferrer">Fale com a equipe ↗</a></p>';
    }
  }

  function formatDate(value) {
    if (!value) return "Não informado";
    const date = new Date(String(value).includes("T") ? value : `${value}T00:00:00`);
    return Number.isNaN(date.valueOf()) ? "Não informado" : new Intl.DateTimeFormat("pt-BR").format(date);
  }

  function renderLookup(resultElement, payload, type) {
    if (!resultElement) return;
    resultElement.classList.remove("lookup-error");
    if (type === "order") {
      const events = Array.isArray(payload.timeline) ? payload.timeline : [];
      const quote = payload.quote;
      const quoteLabels = { sent: "Aguardando sua aprovação", approved: "Aprovado", rejected: "Recusado" };
      const quoteMarkup = quote ? `<section class="public-quote"><h4>Orçamento</h4><p><strong>Valor:</strong> ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(quote.total))}</p><p>${escapeHtml(quote.summary)}</p><p><strong>Situação:</strong> ${escapeHtml(quoteLabels[quote.status] || "Em análise")}</p>${quote.status === "sent" ? '<div class="quote-actions"><button type="button" data-quote-decision="approved">Aprovar orçamento</button><button type="button" data-quote-decision="rejected">Recusar orçamento</button></div>' : ""}</section>` : "";
      const deviceDetails = payload.deviceDetails ? `<p><strong>Cor / armazenamento:</strong> ${escapeHtml(payload.deviceDetails)}</p>` : "";
      resultElement.innerHTML = `<h3>OS ${escapeHtml(payload.orderNumber)}</h3><p><strong>Status:</strong> ${escapeHtml(payload.statusLabel)}</p><p><strong>Aparelho:</strong> ${escapeHtml(payload.deviceLabel)}</p>${deviceDetails}${quoteMarkup}${events.length ? `<ol>${events.map(event => `<li>${escapeHtml(event.label)} · ${escapeHtml(formatDate(event.date))}</li>`).join("")}</ol>` : ""}`;
      return;
    }
    const reference = payload.warrantyNumber ? `Garantia ${payload.warrantyNumber}` : `Garantia da OS ${payload.orderNumber}`;
    const item = payload.itemDescription ? `<p><strong>Produto/serviço:</strong> ${escapeHtml(payload.itemDescription)}</p>` : "";
    resultElement.innerHTML = `<h3>${escapeHtml(reference)}</h3><p><strong>Situação:</strong> ${escapeHtml(payload.statusLabel)}</p>${item}<p><strong>Cobertura:</strong> ${escapeHtml(payload.coverageSummary)}</p><p><strong>Validade:</strong> ${escapeHtml(formatDate(payload.startsOn))} até ${escapeHtml(formatDate(payload.expiresOn))}</p>`;
  }

  function setupLookup(formId, resultId, type) {
    const form = document.getElementById(formId);
    const result = document.getElementById(resultId);
    if (!form || !result) return;
    form.addEventListener("submit", async event => {
      event.preventDefault();
      quoteCredentials = null;
      result.classList.remove("lookup-error");
      if (!isConfigured) {
        setMessage(result, "A consulta online está sendo conectada. Enquanto isso, fale com a equipe pelo WhatsApp.");
        form.reset();
        return;
      }
      const submit = form.querySelector("button[type=submit]");
      const fields = new FormData(form);
      const orderNumber = String(fields.get("orderNumber") || "").trim().toUpperCase();
      const whatsappLast4 = String(fields.get("whatsappLast4") || "").replace(/\D/g, "");
      if (submit) { submit.disabled = true; submit.textContent = "Consultando…"; }
      setMessage(result, "");
      try {
        const response = await fetch(`${baseUrl}/functions/v1/public-order-lookup`, {
          method: "POST",
          headers: { apikey: publishableKey, "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ type, orderNumber, whatsappLast4 })
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 429) throw new Error("Muitas tentativas. Aguarde alguns minutos e tente novamente.");
        if (!response.ok) throw new Error("Confira o número da OS ou garantia e os 4 últimos dígitos do WhatsApp cadastrado.");
        if (type === "order" && payload.quote?.status === "sent") quoteCredentials = { orderNumber, whatsappLast4 };
        renderLookup(result, payload, type);
      } catch (error) {
        setMessage(result, `${error.message || "Não foi possível consultar agora."} Se precisar, fale com a equipe pelo WhatsApp.`, true);
      } finally {
        form.reset();
        if (submit) { submit.disabled = false; submit.innerHTML = type === "order" ? 'Consultar OS <span aria-hidden="true">↗</span>' : 'Consultar garantia <span aria-hidden="true">↗</span>'; }
      }
    });
  }

  document.querySelector("#order-result")?.addEventListener("click", async event => {
    const button = event.target.closest("[data-quote-decision]");
    if (!button || !quoteCredentials) return;
    const decision = button.dataset.quoteDecision;
    if (decision === "rejected" && !window.confirm("Deseja recusar este orçamento? A assistência entrará em contato.")) return;
    const buttons = Array.from(document.querySelectorAll("#order-result [data-quote-decision]"));
    buttons.forEach(item => { item.disabled = true; });
    try {
      const response = await fetch(`${baseUrl}/functions/v1/public-quote-decision`, {
        method: "POST",
        headers: { apikey: publishableKey, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ ...quoteCredentials, decision })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error("Muitas tentativas. Aguarde alguns minutos e tente novamente.");
      if (!response.ok) throw new Error("Não foi possível registrar a decisão. Consulte novamente ou fale com a equipe.");
      quoteCredentials = null;
      const result = document.querySelector("#order-result");
      result.innerHTML = `<h3>OS ${escapeHtml(payload.orderNumber)}</h3><p><strong>Status:</strong> ${escapeHtml(payload.statusLabel)}</p><p>${escapeHtml(payload.message)}</p>`;
    } catch (error) {
      const result = document.querySelector("#order-result");
      setMessage(result, error.message || "Não foi possível registrar a decisão.", true);
      buttons.forEach(item => { item.disabled = false; });
    }
  });

  loadCatalog();
  setupCart();
  setupLookup("order-lookup-form", "order-result", "order");
  setupLookup("warranty-lookup-form", "warranty-result", "warranty");
})();
