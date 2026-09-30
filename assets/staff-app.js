"use strict";
(() => {
  const config = window.AGUIA_SUPABASE_CONFIG || {};
  const baseUrl = typeof config.url === "string" ? config.url.replace(/\/$/, "") : "";
  const publishableKey = typeof config.publishableKey === "string" ? config.publishableKey : "";
  const configured = Boolean(baseUrl && publishableKey);
  const rememberedSessionKey = "aguiarp.staff.refresh.v1";
  const inviteAccessToken = (() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (fragment.get("type") !== "invite" || !fragment.has("access_token")) return "";
    const token = fragment.get("access_token") || "";
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return token;
  })();
  let session = null;
  let staff = null;
  let refreshTimer = 0;
  const statusLabels = {
    received: "Recebido", diagnosis: "Diagnóstico", quote_sent: "Orçamento enviado",
    awaiting_approval: "Aguardando aprovação", in_repair: "Em reparo",
    waiting_part: "Aguardando peça", testing: "Testes", ready: "Pronto",
    delivered: "Entregue", cancelled: "Cancelado"
  };
  const roleLabels = { admin: "Administrador", technician: "Técnico", employee: "Funcionário" };
  const statusPublicNotes = {
    received: "Aparelho recebido pela assistência.",
    diagnosis: "Aparelho em diagnóstico.",
    quote_sent: "Orçamento enviado.",
    awaiting_approval: "Aguardando aprovação do orçamento.",
    in_repair: "Reparo em andamento.",
    waiting_part: "Aguardando a chegada de uma peça.",
    testing: "Aparelho em testes.",
    ready: "Aparelho pronto para retirada.",
    delivered: "Aparelho entregue.",
    cancelled: "Atendimento cancelado."
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const dateText = value => value
    ? new Intl.DateTimeFormat("pt-BR").format(new Date(String(value).includes("T") ? value : value + "T00:00:00"))
    : "—";
  const money = value => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));

  function message(id, text, isError = false) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = text;
    element.classList.toggle("is-error", isError);
  }

  async function authRequest(path, body, token) {
    const response = await fetch(baseUrl + path, {
      method: body ? "POST" : "GET",
      headers: {
        apikey: publishableKey,
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.msg || data.message || "Não foi possível autenticar.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function saveRememberedSession(remember) {
    try {
      if (remember && session?.refresh_token) {
        window.localStorage.setItem(rememberedSessionKey, session.refresh_token);
      } else {
        window.localStorage.removeItem(rememberedSessionKey);
      }
      return true;
    } catch {
      return false;
    }
  }

  function syncRememberedRefreshToken() {
    try {
      if (window.localStorage.getItem(rememberedSessionKey) && session?.refresh_token) {
        window.localStorage.setItem(rememberedSessionKey, session.refresh_token);
      }
    } catch { /* The active session can continue even if browser storage is unavailable. */ }
  }

  async function restoreRememberedSession() {
    if (!configured || inviteAccessToken) return;
    let refreshToken = "";
    try { refreshToken = window.localStorage.getItem(rememberedSessionKey) || ""; }
    catch { return; }
    if (!refreshToken) return;

    message("staff-login-message", "Restaurando seu acesso...");
    try {
      session = await authRequest("/auth/v1/token?grant_type=refresh_token", { refresh_token: refreshToken });
      if (!session.access_token || !session.user?.id) throw new Error("A sessão salva não é válida.");
      syncRememberedRefreshToken();
      const profiles = await getRows("staff_profiles", {
        select: "user_id,display_name,role,active",
        user_id: "eq." + session.user.id,
        limit: "1"
      });
      if (!profiles[0]?.active) {
        clearSession(true);
        showLogin("Esta conta não tem acesso ativo à gestão. Peça ajuda à administração.", true);
        return;
      }
      staff = profiles[0];
      syncRememberedRefreshToken();
      armRefresh();
      showDashboard();
    } catch (error) {
      window.clearTimeout(refreshTimer);
      session = null;
      staff = null;
      if (error.status === 400 || error.status === 401) clearSession(true);
      showLogin(error.status === 400 || error.status === 401
        ? "Sua sessão expirou. Entre novamente para manter o acesso neste dispositivo."
        : "Não foi possível restaurar a sessão agora. Entre novamente ou tente mais tarde.", true);
    }
  }

  function armRefresh() {
    window.clearTimeout(refreshTimer);
    if (!session?.refresh_token || !session?.expires_in) return;
    const wait = Math.max(30000, (Number(session.expires_in) - 60) * 1000);
    refreshTimer = window.setTimeout(async () => {
      try {
        session = await authRequest("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token });
        syncRememberedRefreshToken();
        armRefresh();
      } catch (error) {
        clearSession(error.status === 400 || error.status === 401);
        showLogin(error.status === 400 || error.status === 401
          ? "Sua sessão expirou. Entre novamente."
          : "Não foi possível renovar a sessão. Tente entrar novamente.", true);
      }
    }, wait);
  }

  function clearSession(forgetRemembered = false) {
    window.clearTimeout(refreshTimer);
    session = null;
    staff = null;
    if (forgetRemembered) {
      try { window.localStorage.removeItem(rememberedSessionKey); } catch { /* Ignore unavailable storage. */ }
    }
  }

  function showLogin(text = "", error = false) {
    $("#staff-login-panel").hidden = false;
    $("#staff-dashboard").hidden = true;
    message("staff-login-message", text, error);
  }

  function showInviteSetup() {
    $("#staff-login-panel").hidden = false;
    $("#staff-dashboard").hidden = true;
    $("#staff-login-form").hidden = true;
    $("#staff-invite-form").hidden = false;
  }

  function showDashboard() {
    $("#staff-login-panel").hidden = true;
    $("#staff-dashboard").hidden = false;
    $("#staff-greeting").textContent = "Olá, " + staff.display_name;
    $("#staff-role").textContent = roleLabels[staff.role] || "Equipe";
    $$("[data-admin-only]").forEach(button => { button.hidden = staff.role !== "admin"; });
    const allowed = staff.role === "admin"
      ? ["overview", "orders", "customers", "catalog", "inventory", "warranties", "finance", "team"]
      : staff.role === "technician"
        ? ["overview", "orders", "customers", "warranties"]
        : ["overview", "orders", "customers", "catalog", "inventory", "warranties"];
    $$("[data-screen-target]").forEach(button => { button.hidden = !allowed.includes(button.dataset.screenTarget); });
    const customerForm = $("#customer-form");
    if (customerForm) customerForm.hidden = staff.role === "technician";
    const warrantyForm = $("#warranty-form");
    if (warrantyForm) warrantyForm.hidden = staff.role === "technician";
    activateScreen("overview");
  }

  async function login(email, password, remember) {
    const data = await authRequest("/auth/v1/token?grant_type=password", { email, password });
    if (!data.access_token || !data.user?.id) throw new Error("Conta ou senha inválida.");
    session = data;
    armRefresh();
    const profiles = await getRows("staff_profiles", {
      select: "user_id,display_name,role,active",
      user_id: "eq." + data.user.id,
      limit: "1"
    });
    if (!profiles[0]?.active) {
      clearSession(true);
      throw new Error("Esta conta não tem acesso ativo à gestão. Peça ajuda à administração.");
    }
    staff = profiles[0];
    const saved = saveRememberedSession(remember);
    showDashboard();
    if (!saved) message("staff-global-message", "Não foi possível salvar a sessão neste navegador. Você precisará entrar novamente ao voltar.", true);
  }

  async function logout() {
    const token = session?.access_token;
    try {
      if (token && configured) await authRequest("/auth/v1/logout", {}, token);
    } catch { /* The local session is cleared even if the remote endpoint is unavailable. */ }
    clearSession(true);
    $("#staff-login-form").reset();
    showLogin("Você saiu da área da equipe.");
  }

  async function api(path, options = {}) {
    if (!configured) throw new Error("Conexão com o banco ainda não foi configurada.");
    const headers = {
      apikey: publishableKey,
      Accept: "application/json",
      ...(session?.access_token ? { Authorization: "Bearer " + session.access_token } : {}),
      ...(options.headers || {}),
      ...(options.body ? { "Content-Type": "application/json", Prefer: options.prefer || "return=representation" } : {})
    };
    const response = await fetch(baseUrl + path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const error = new Error(data?.message || data?.hint || data?.details || "A operação foi recusada pelo servidor.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function endpoint(table, params) {
    const query = new URLSearchParams(params);
    return "/rest/v1/" + table + "?" + query.toString();
  }

  function getRows(table, params) {
    return api(endpoint(table, params));
  }

  async function functionCall(name, body) {
    if (!session?.access_token) throw new Error("Entre novamente para continuar.");
    return api("/functions/v1/" + name, {
      method: "POST",
      body,
      headers: { Authorization: "Bearer " + session.access_token }
    });
  }

  function activateScreen(name) {
    $$("[data-screen]").forEach(section => { section.hidden = section.dataset.screen !== name; });
    $$("[data-screen-target]").forEach(button => button.classList.toggle("is-active", button.dataset.screenTarget === name));
    void loadScreen(name);
  }

  function table(headers, rows, emptyText) {
    if (!rows.length) return '<p class="staff-empty">' + esc(emptyText) + "</p>";
    return '<table class="staff-table"><thead><tr>' + headers.map(header => "<th>" + esc(header) + "</th>").join("") +
      "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";
  }

  function orderRow(order, withAction) {
    const customer = order.customers?.name || "—";
    const phone = String(order.customers?.whatsapp || "").replace(/\D/g, "");
    const whatsappNumber = phone ? (phone.startsWith("55") ? phone : "55" + phone) : "";
    const statusCell = withAction
      ? '<select data-order-status data-order-id="' + esc(order.id) + '" aria-label="Alterar status da OS ' + esc(order.order_number) + '">' +
        Object.entries(statusLabels).map(([key, label]) => '<option value="' + key + '"' + (key === order.status ? " selected" : "") + ">" + esc(label) + "</option>").join("") + "</select>"
      : esc(statusLabels[order.status] || order.status);
    const notifyCell = withAction && whatsappNumber
      ? '<a class="staff-notify-link" href="https://wa.me/' + esc(whatsappNumber) + '?text=' + encodeURIComponent(
          "Olá, " + customer + "! Aqui é da Águia Repair. A situação da sua OS " + order.order_number + " (" + [order.brand, order.model].filter(Boolean).join(" ") +
          ") foi atualizada para: " + (statusLabels[order.status] || order.status) + ". " + (statusPublicNotes[order.status] || "") +
          " Você pode acompanhar pelo site aguiarepair.com.br, em Acompanhar OS, usando o número e o código do comprovante."
        ) + '" target="_blank" rel="noopener noreferrer">Avisar no WhatsApp ↗</a>'
      : "—";
    return "<tr><td><strong>" + esc(order.order_number) + "</strong></td><td>" + esc(customer) +
      "</td><td>" + esc([order.brand, order.model].filter(Boolean).join(" ")) + "</td><td>" + statusCell +
      "</td><td>" + esc(dateText(order.received_at)) + "</td><td>" + notifyCell + "</td></tr>";
  }

  async function loadOrders(target) {
    const rows = await getRows("work_orders", {
      select: "id,order_number,status,brand,model,received_at,customers(name,whatsapp)",
      order: "received_at.desc",
      limit: "100"
    });
    const html = table(["OS", "Cliente", "Aparelho", "Status", "Entrada", "Aviso ao cliente"], rows.map(row => orderRow(row, true)), "Nenhuma ordem de serviço cadastrada.");
    target.innerHTML = html;
  }

  async function onOrderStatusChange(event) {
    const select = event.target.closest("[data-order-status]");
    if (!select || !session) return;
    const nextStatus = select.value;
    select.disabled = true;
    try {
      await api("/rest/v1/rpc/change_work_order_status", {
        method: "POST",
        body: {
          order_id: select.dataset.orderId,
          next_status: nextStatus,
          public_note: statusPublicNotes[nextStatus],
          internal_note: null
        }
      });
      await loadDashboardData();
    } catch (error) {
      message("staff-global-message", error.message, true);
      await loadOrders($("#orders-table"));
    }
  }

  async function loadOverview() {
    const orders = await getRows("work_orders", {
      select: "id,order_number,status,brand,model,received_at,customers(name)",
      order: "received_at.desc",
      limit: "100"
    });
    $("#metric-open").textContent = String(orders.filter(item => !["delivered", "cancelled"].includes(item.status)).length);
    $("#metric-approval").textContent = String(orders.filter(item => ["quote_sent", "awaiting_approval"].includes(item.status)).length);
    if (staff.role === "technician") {
      $("#metric-products").textContent = "—";
    } else {
      const products = await getRows("catalog_items", { select: "id", is_published: "eq.true", limit: "1000" });
      $("#metric-products").textContent = String(products.length);
    }
    $("#overview-orders").innerHTML = table(["OS", "Cliente", "Aparelho", "Status", "Entrada"],
      orders.slice(0, 8).map(row => orderRow(row, false)), "Ainda não há ordens.");
  }

  async function loadCustomers() {
    const rows = await getRows("customers", { select: "id,name,whatsapp,email,created_at", order: "created_at.desc", limit: "200" });
    $("#customers-table").innerHTML = table(["Nome", "WhatsApp", "E-mail", "Cadastro"],
      rows.map(row => "<tr><td>" + esc(row.name) + "</td><td>" + esc(row.whatsapp) + "</td><td>" + esc(row.email || "—") + "</td><td>" + esc(dateText(row.created_at)) + "</td></tr>"),
      "Nenhum cliente cadastrado.");
  }

  async function loadCatalog() {
    const rows = await getRows("catalog_items", { select: "id,name,description,price,is_published,position", order: "position.asc,name.asc", limit: "300" });
    $("#catalog-table").innerHTML = table(["Produto", "Preço", "Visibilidade", "Ação"], rows.map(row =>
      "<tr><td><strong>" + esc(row.name) + "</strong><br>" + esc(row.description) + "</td><td>" + (row.price === null ? "Consultar" : esc(money(row.price))) +
      "</td><td>" + (row.is_published ? "Publicado" : "Rascunho") + '</td><td><button class="staff-small-action" type="button" data-toggle-product="' +
      esc(row.id) + '" data-published="' + String(row.is_published) + '">' + (row.is_published ? "Retirar do site" : "Publicar") + "</button></td></tr>"
    ), "Nenhum produto cadastrado.");
  }

  async function loadInventory() {
    const rows = await getRows("inventory_items", { select: "id,sku,name,quantity,minimum_quantity,unit_cost", order: "name.asc", limit: "300" });
    $("#inventory-table").innerHTML = table(["Código", "Item", "Quantidade", "Mínimo", "Custo"],
      rows.map(row => "<tr><td>" + esc(row.sku || "—") + "</td><td>" + esc(row.name) + "</td><td>" + esc(row.quantity) +
        (Number(row.quantity) <= Number(row.minimum_quantity) ? " · Repor" : "") + "</td><td>" + esc(row.minimum_quantity) + "</td><td>" + esc(money(row.unit_cost)) + "</td></tr>"),
      "Nenhum item cadastrado no estoque.");
  }

  async function loadWarranties() {
    const rows = await getRows("warranties", {
      select: "id,work_order_id,coverage_summary,starts_on,expires_on,status,work_orders(order_number)",
      order: "expires_on.desc",
      limit: "300"
    });
    $("#warranties-table").innerHTML = table(["OS", "Cobertura", "Início", "Validade", "Situação"],
      rows.map(row => "<tr><td>" + esc(row.work_orders?.order_number || row.work_order_id.slice(0, 8)) + "</td><td>" + esc(row.coverage_summary) +
        "</td><td>" + esc(dateText(row.starts_on)) + "</td><td>" + esc(dateText(row.expires_on)) + "</td><td>" + esc(row.status) + "</td></tr>"),
      "Nenhuma garantia registrada.");
  }

  async function loadFinance() {
    const rows = await getRows("financial_entries", { select: "entry_type,amount,description,occurred_on", order: "occurred_on.desc", limit: "300" });
    $("#finance-table").innerHTML = table(["Tipo", "Valor", "Descrição", "Data"],
      rows.map(row => "<tr><td>" + (row.entry_type === "income" ? "Entrada" : "Saída") + "</td><td>" + esc(money(row.amount)) +
        "</td><td>" + esc(row.description) + "</td><td>" + esc(dateText(row.occurred_on)) + "</td></tr>"),
      "Nenhum lançamento registrado.");
  }

  async function loadTeam() {
    const rows = await getRows("staff_profiles", { select: "display_name,role,active,created_at", order: "created_at.asc", limit: "200" });
    $("#team-table").innerHTML = table(["Nome", "Função", "Acesso", "Desde"],
      rows.map(row => "<tr><td>" + esc(row.display_name) + "</td><td>" + esc(roleLabels[row.role] || row.role) + "</td><td>" +
        (row.active ? "Ativo" : "Desativado") + "</td><td>" + esc(dateText(row.created_at)) + "</td></tr>"),
      "Nenhum perfil de equipe encontrado.");
  }

  async function loadScreen(name) {
    try {
      if (name === "overview") await loadOverview();
      if (name === "orders") await loadOrders($("#orders-table"));
      if (name === "customers") await loadCustomers();
      if (name === "catalog") await loadCatalog();
      if (name === "inventory") await loadInventory();
      if (name === "warranties") await loadWarranties();
      if (name === "finance") await loadFinance();
      if (name === "team") await loadTeam();
    } catch (error) {
      const section = $('[data-screen="' + name + '"]');
      const area = section?.querySelector(".staff-table-wrap");
      if (area) area.innerHTML = '<p class="staff-empty">' + esc(error.message) + "</p>";
    }
  }

  async function loadDashboardData() {
    await loadOverview();
    const active = $(".staff-screen:not([hidden])")?.dataset.screen;
    if (active && active !== "overview") await loadScreen(active);
  }

  async function submitNewOrder(form) {
    const data = new FormData(form);
    const photos = data.getAll("photos").filter(file => file instanceof File && file.size > 0);
    if (photos.length > 6) throw new Error("Anexe no máximo 6 fotos por OS.");
    const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (photos.some(file => !allowedMime.has(file.type) || file.size > 10485760)) {
      throw new Error("Use imagens JPG, PNG ou WebP de até 10 MB cada.");
    }
    let deviceSecret = String(data.get("accessSecret") || "");
    const response = await functionCall("create-work-order", {
      customer: {
        name: data.get("customerName"),
        whatsapp: data.get("customerWhatsapp")
      },
      device: {
        brand: data.get("brand"),
        model: data.get("model"),
        color: data.get("color"),
        platform: data.get("platform"),
        lockType: data.get("lockType"),
        accessSecret: deviceSecret
      },
      entry: {
        reportedIssue: data.get("reportedIssue"),
        physicalCondition: data.get("physicalCondition"),
        accessories: String(data.get("accessories") || "").split(",").map(value => value.trim()).filter(Boolean),
        internalNotes: data.get("internalNotes")
      }
    });
    deviceSecret = "";
    data.set("accessSecret", "");
    form.reset();
    const result = $("#new-order-result");
    result.hidden = false;
    result.innerHTML = "<strong>OS criada: " + esc(response.orderNumber) + "</strong><br>Código para entregar ao cliente: <code>" +
      esc(response.accessCode) + "</code><br>" + esc(response.message);
    let uploaded = 0;
    for (let index = 0; index < photos.length; index++) {
      const file = photos[index];
      const extension = file.type === "image/jpeg" ? "jpg" : file.type === "image/png" ? "png" : "webp";
      const fileName = crypto.randomUUID() + "." + extension;
      const objectPath = response.orderId + "/" + fileName;
      const upload = await fetch(baseUrl + "/storage/v1/object/work-order-photos/" + objectPath, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          Authorization: "Bearer " + session.access_token,
          "Content-Type": file.type,
          "x-upsert": "false"
        },
        body: file,
        cache: "no-store"
      });
      if (!upload.ok) throw new Error("A OS foi criada, mas uma foto não foi enviada. Avise a equipe antes de fechar esta tela.");
      try {
        await api("/rest/v1/work_order_attachments", { method: "POST", body: {
          work_order_id: response.orderId,
          object_path: objectPath,
          original_name: "Anexo-" + String(index + 1).padStart(2, "0") + "." + extension,
          mime_type: file.type,
          byte_size: file.size,
          uploaded_by: staff.user_id
        }});
      } catch (error) {
        await fetch(baseUrl + "/storage/v1/object/work-order-photos/" + objectPath, {
          method: "DELETE",
          headers: { apikey: publishableKey, Authorization: "Bearer " + session.access_token },
          cache: "no-store"
        }).catch(() => {});
        throw error;
      }
      uploaded++;
    }
    if (uploaded) result.innerHTML += "<br>Fotos privadas salvas: " + String(uploaded) + ".";
    await loadDashboardData();
  }

  function setupForm(id, handler, messageId) {
    const form = document.getElementById(id);
    if (!form) return;
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      message(messageId, "");
      try { await handler(form); }
      catch (error) { message(messageId, error.message, true); }
      finally { if (submit) submit.disabled = false; }
    });
  }

  function setupForms() {
    setupForm("new-order-form", submitNewOrder, "new-order-message");

    setupForm("customer-form", async form => {
      const data = new FormData(form);
      const name = String(data.get("name") || "").trim();
      const whatsapp = String(data.get("whatsapp") || "").trim();
      const email = String(data.get("email") || "").trim().toLowerCase() || null;
      if (name.length < 1 || whatsapp.length < 8 || whatsapp.length > 24) {
        throw new Error("Informe o nome e um WhatsApp válido com DDD.");
      }
      const duplicate = await getRows("customers", { select: "id", whatsapp: "eq." + whatsapp, limit: "1" });
      if (duplicate[0]) throw new Error("Já existe um cliente cadastrado com esse WhatsApp.");
      await api("/rest/v1/customers", { method: "POST", body: { name, whatsapp, email } });
      form.reset();
      message("customer-message", "Cliente cadastrado.");
      await loadCustomers();
    }, "customer-message");

    setupForm("quote-form", async form => {
      const data = new FormData(form);
      const orderNumber = String(data.get("orderNumber") || "").trim().toUpperCase();
      const total = Number(data.get("total"));
      const summary = String(data.get("summary") || "").trim();
      if (!/^AR-[0-9]{6,10}$/.test(orderNumber) || !Number.isFinite(total) || total < 0 || !summary) {
        throw new Error("Confira o número da OS, o valor e a descrição do orçamento.");
      }
      const rows = await api("/rest/v1/rpc/send_work_order_quote", {
        method: "POST",
        body: { p_order_number: orderNumber, p_total: total, p_summary: summary }
      });
      if (!rows?.[0]) throw new Error("Não foi possível enviar este orçamento.");
      form.reset();
      message("quote-message", "Orçamento enviado para a OS " + rows[0].order_number + ". O cliente pode aprovar sem criar conta, usando o código da OS.");
      await loadDashboardData();
    }, "quote-message");

    setupForm("catalog-form", async form => {
      const data = new FormData(form);
      const image = String(data.get("imageUrl") || "").trim();
      if (image && new URL(image).protocol !== "https:") throw new Error("A imagem precisa usar HTTPS.");
      await api("/rest/v1/catalog_items", { method: "POST", body: {
        name: String(data.get("name")).trim(),
        description: String(data.get("description") || "").trim(),
        price: data.get("price") ? Number(data.get("price")) : null,
        image_url: image || null,
        is_published: data.get("isPublished") === "on",
        created_by: staff.user_id
      }});
      form.reset();
      message("catalog-message", "Produto salvo.");
      await loadCatalog();
    }, "catalog-message");

    setupForm("inventory-form", async form => {
      const data = new FormData(form);
      const result = await api("/rest/v1/inventory_items", { method: "POST", body: {
        name: String(data.get("name")).trim(),
        sku: String(data.get("sku") || "").trim() || null,
        quantity: Number(data.get("quantity")),
        minimum_quantity: Number(data.get("minimumQuantity")),
        unit_cost: Number(data.get("unitCost"))
      }});
      if (result?.[0]?.id && Number(data.get("quantity")) > 0) {
        await api("/rest/v1/stock_movements", { method: "POST", body: {
          inventory_item_id: result[0].id,
          quantity_delta: Number(data.get("quantity")),
          reason: "Saldo inicial",
          actor_id: staff.user_id
        }});
      }
      form.reset();
      message("inventory-message", "Item salvo no estoque.");
      await loadInventory();
    }, "inventory-message");

    setupForm("warranty-form", async form => {
      const data = new FormData(form);
      const orderNumber = String(data.get("orderNumber")).trim().toUpperCase();
      const orders = await getRows("work_orders", { select: "id", order_number: "eq." + orderNumber, limit: "1" });
      if (!orders[0]) throw new Error("OS não encontrada ou sem permissão para acessá-la.");
      await api("/rest/v1/warranties", { method: "POST", body: {
        work_order_id: orders[0].id,
        coverage_summary: String(data.get("coverageSummary")).trim(),
        starts_on: data.get("startsOn"),
        expires_on: data.get("expiresOn"),
        status: "active",
        created_by: staff.user_id
      }});
      form.reset();
      message("warranty-message", "Garantia registrada. O cliente poderá consultá-la com o código da OS.");
      await loadWarranties();
    }, "warranty-message");

    setupForm("finance-form", async form => {
      const data = new FormData(form);
      await api("/rest/v1/financial_entries", { method: "POST", body: {
        entry_type: data.get("entryType"),
        amount: Number(data.get("amount")),
        description: String(data.get("description")).trim(),
        occurred_on: data.get("occurredOn"),
        created_by: staff.user_id
      }});
      form.reset();
      message("finance-message", "Lançamento registrado.");
      await loadFinance();
    }, "finance-message");

    setupForm("invite-form", async form => {
      const data = new FormData(form);
      await functionCall("invite-staff", {
        displayName: String(data.get("displayName")).trim(),
        email: String(data.get("email")).trim(),
        role: data.get("role")
      });
      form.reset();
      message("invite-message", "Convite enviado. O funcionário receberá um link para definir a senha.");
      await loadTeam();
    }, "invite-message");
  }

  $("#staff-login-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = form.querySelector("button[type=submit]");
    if (!configured) {
      message("staff-login-message", "O banco ainda não está conectado. A configuração será ativada depois que o projeto Supabase estiver ligado.", true);
      return;
    }
    button.disabled = true;
    message("staff-login-message", "Conectando...");
    try {
      await login(String(data.get("email")).trim(), String(data.get("password")), data.get("remember") === "on");
    } catch (error) {
      clearSession(true);
      showLogin(error.message || "Não foi possível entrar.", true);
    } finally {
      button.disabled = false;
      const password = form.elements.namedItem("password");
      if (password) password.value = "";
    }
  });

  $("#staff-invite-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") || "");
    const confirmation = String(data.get("passwordConfirmation") || "");
    const button = form.querySelector('button[type="submit"]');
    if (!inviteAccessToken || !configured) {
      message("staff-invite-message", "O convite não está disponível. Peça à administração que envie outro.", true);
      return;
    }
    if (password.length < 12 || password !== confirmation) {
      message("staff-invite-message", password !== confirmation ? "As senhas não são iguais." : "Use uma senha com pelo menos 12 caracteres.", true);
      return;
    }
    button.disabled = true;
    message("staff-invite-message", "Ativando sua conta...");
    try {
      const response = await fetch(baseUrl + "/auth/v1/user", {
        method: "PUT",
        headers: {
          apikey: publishableKey,
          Authorization: "Bearer " + inviteAccessToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password }),
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Não foi possível ativar a conta. O convite pode ter expirado; peça outro à administração.");
      form.reset();
      form.hidden = true;
      $("#staff-login-form").hidden = false;
      message("staff-login-message", "Acesso ativado. Entre com seu e-mail e a nova senha.");
    } catch (error) {
      message("staff-invite-message", error.message || "Não foi possível ativar a conta.", true);
    } finally {
      button.disabled = false;
    }
  });

  $("#staff-logout")?.addEventListener("click", () => { void logout(); });
  $("#orders-table")?.addEventListener("change", onOrderStatusChange);
  $$("[data-screen-target]").forEach(button => button.addEventListener("click", () => activateScreen(button.dataset.screenTarget)));
  $$("[data-open-new-order]").forEach(button => button.addEventListener("click", () => {
    activateScreen("orders");
    $("#new-order-details").open = true;
    $("#new-order-details").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#new-order-form").elements.namedItem("customerName").focus({ preventScroll: true });
  }));

  $("#catalog-table")?.addEventListener("click", async event => {
    const button = event.target.closest("[data-toggle-product]");
    if (!button) return;
    button.disabled = true;
    try {
      await api("/rest/v1/catalog_items?id=eq." + encodeURIComponent(button.dataset.toggleProduct), {
        method: "PATCH", body: { is_published: button.dataset.published !== "true" }
      });
      await loadCatalog();
      await loadOverview();
    } catch (error) { message("catalog-message", error.message, true); }
    finally { button.disabled = false; }
  });

  setupForms();
  if (inviteAccessToken) {
    if (configured) showInviteSetup();
    else showLogin("Banco ainda não conectado.", true);
  } else if (!configured) {
    showLogin("Banco ainda não conectado.", true);
  } else {
    void restoreRememberedSession();
  }
})();
