import { corsHeaders, json, serviceClient, hmacHex, sha256, normalizeCode } from "../_shared/common.ts";

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const allowedOrigins = ["https://aguiarepair.com.br", "https://www.aguiarepair.com.br", "http://localhost:5500", "http://127.0.0.1:5500"];
  const origin = req.headers.get("origin") ?? "";
  if (origin && !allowedOrigins.includes(origin)) return json(req, { error: "origin_not_allowed" }, 403);
  if (Number(req.headers.get("content-length") ?? "0") > 4096) return json(req, { error: "request_too_large" }, 413);
  const rateSalt = Deno.env.get("LOOKUP_RATE_LIMIT_SALT") ?? "";
  if (!rateSalt) return json(req, { error: "temporarily_unavailable" }, 503);

  let input: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(req, { error: "invalid_request" }, 400);
    input = parsed as Record<string, unknown>;
  } catch {
    return json(req, { error: "invalid_request" }, 400);
  }
  const orderNumber = String(input.orderNumber ?? "").trim().toUpperCase();
  const accessCode = normalizeCode(input.accessCode);
  const decision = input.decision === "approved" || input.decision === "rejected" ? input.decision : "";
  if (!/^AR-[0-9]{6,10}$/.test(orderNumber) || accessCode.length !== 16 || !decision) {
    return json(req, { error: "not_found" }, 404);
  }

  try {
    const forwarded = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const rateKey = await hmacHex(rateSalt, forwarded);
    const client = serviceClient();
    const { data: allowed, error: rateError } = await client.rpc("consume_public_lookup", { key_digest: rateKey });
    if (rateError || allowed !== true) return json(req, { error: "rate_limited" }, 429);

    const { data: order, error: orderError } = await client.from("work_orders")
      .select("id,order_number,public_tracking_hash")
      .eq("order_number", orderNumber)
      .maybeSingle();
    const suppliedHash = await sha256(accessCode);
    if (orderError || !order || !constantTimeEqual(suppliedHash, order.public_tracking_hash)) {
      return json(req, { error: "not_found" }, 404);
    }
    const { data, error } = await client.rpc("decide_public_quote", {
      p_work_order_id: order.id,
      p_decision: decision
    });
    if (error || !data?.[0]) return json(req, { error: "quote_unavailable" }, 409);
    const result = data[0];
    return json(req, {
      orderNumber: result.order_number,
      quoteStatus: result.quote_status,
      statusLabel: result.work_order_status === "in_repair" ? "Em reparo" : "Em diagnóstico",
      message: result.quote_status === "approved" ? "Orçamento aprovado. A equipe continuará o atendimento." : "Orçamento recusado. A equipe entrará em contato."
    });
  } catch {
    return json(req, { error: "temporarily_unavailable" }, 503);
  }
});
