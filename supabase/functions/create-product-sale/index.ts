import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearerToken, corsHeaders, isValidCpf, json, normalizeCpf, SUPABASE_URL, PUBLISHABLE_KEY } from "../_shared/common.ts";

const optional = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const token = bearerToken(req);
  if (!token || !SUPABASE_URL || !PUBLISHABLE_KEY) return json(req, { error: "unauthorized" }, 401);

  let body: Record<string, any>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(req, { error: "invalid_request" }, 400);
    body = parsed as Record<string, any>;
  } catch { return json(req, { error: "invalid_request" }, 400); }

  const customer = {
    id: optional(body.customer?.id, 36) || null,
    name: optional(body.customer?.name, 160),
    whatsapp: optional(body.customer?.whatsapp, 24),
    email: optional(body.customer?.email, 200) || null,
    cpf: normalizeCpf(body.customer?.cpf)
  };
  const sale = {
    inventoryItemId: optional(body.sale?.inventoryItemId, 36),
    quantity: Number(body.sale?.quantity),
    unitPrice: Number(body.sale?.unitPrice),
    paymentMethod: optional(body.sale?.paymentMethod, 20),
    occurredOn: optional(body.sale?.occurredOn, 10)
  };
  if ((customer.id && !uuidPattern.test(customer.id)) || !isValidCpf(body.customer?.cpf) || (!customer.id && (customer.name.length < 2 || customer.whatsapp.length < 8)) ||
      !uuidPattern.test(sale.inventoryItemId) || !Number.isInteger(sale.quantity) || sale.quantity < 1 ||
      !Number.isFinite(sale.unitPrice) || sale.unitPrice < 0 || sale.unitPrice > 9_999_999_999.99 ||
      !["pix", "cash", "card", "transfer", "other"].includes(sale.paymentMethod) ||
      (sale.occurredOn && !/^\d{4}-\d{2}-\d{2}$/.test(sale.occurredOn))) {
    return json(req, { error: "invalid_fields" }, 400);
  }

  const userClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: "Bearer " + token } }
  });
  const { data, error } = await userClient.rpc("record_product_sale_atomic", {
    customer_data: customer,
    sale_data: sale
  });
  if (error || !data?.[0]) {
    const insufficientStock = error?.message?.includes("insufficient stock");
    return json(req, {
      error: insufficientStock ? "insufficient_stock" : "could_not_record_sale",
      message: insufficientStock ? "Estoque insuficiente para essa quantidade." : "Confira o cliente, o produto e os dados da venda."
    }, insufficientStock ? 409 : 400);
  }
  return json(req, { saleId: data[0].sale_id, total: data[0].total, product: data[0].item_name }, 201);
});
