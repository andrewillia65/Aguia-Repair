import { bearerToken, corsHeaders, decryptDeviceSecret, json, serviceClient, userClient, SUPABASE_URL } from "../_shared/common.ts";

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
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json(req, { error: "invalid_fields" }, 400);
  try {
    const caller = userClient(token);
    const { data: authData, error: authError } = await caller.auth.getUser(token);
    if (authError || !authData.user) return json(req, { error: "unauthorized" }, 401);
    const { data: allowed, error: permissionError } = await caller.rpc("staff_can_read_device_secret", { order_id: orderId });
    if (permissionError || allowed !== true) return json(req, { error: "forbidden" }, 403);

    const admin = serviceClient();
    const { data: row, error } = await admin.from("device_access_secrets")
      .select("ciphertext,iv,expires_at").eq("work_order_id", orderId).maybeSingle();
    if (error || !row) return json(req, { error: "secret_unavailable" }, 404);
    if (new Date(row.expires_at) <= new Date()) {
      await admin.from("device_access_secrets").delete().eq("work_order_id", orderId);
      return json(req, { error: "secret_unavailable" }, 404);
    }
    const { error: auditError } = await admin.from("device_secret_access_logs").insert({ work_order_id: orderId, actor_id: authData.user.id });
    if (auditError) return json(req, { error: "temporarily_unavailable" }, 503);
    const plaintext = await decryptDeviceSecret(row.ciphertext, row.iv);
    return json(req, { secret: plaintext });
  } catch {
    return json(req, { error: "temporarily_unavailable" }, 503);
  }
});
