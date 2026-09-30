import { bearerToken, corsHeaders, json, userClient, SUPABASE_URL, PUBLISHABLE_KEY } from "../_shared/common.ts";

const statuses = new Set(["received", "diagnosis", "quote_sent", "awaiting_approval", "in_repair", "waiting_part", "testing", "ready", "delivered", "cancelled"]);

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const token = bearerToken(req);
  if (!token) return json(req, { error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(req, { error: "invalid_request" }, 400);
    body = parsed as Record<string, unknown>;
  } catch { return json(req, { error: "invalid_request" }, 400); }
  const orderId = String(body.orderId ?? "");
  const status = String(body.status ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || !statuses.has(status)) return json(req, { error: "invalid_fields" }, 400);
  try {
    const client = userClient(token);
    const { data, error } = await client.rpc("change_work_order_status", {
      order_id: orderId,
      next_status: status,
      public_note: String(body.publicNote ?? "").slice(0, 500),
      internal_note: String(body.internalNote ?? "").slice(0, 2000)
    });
    if (error || !data) return json(req, { error: "status_update_rejected" }, 403);
    return json(req, { orderNumber: data.order_number, status: data.status });
  } catch {
    return json(req, { error: "temporarily_unavailable" }, 503);
  }
});
