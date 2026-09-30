import { corsHeaders, json, serviceClient, hmacHex, sha256, normalizeCode } from "../_shared/common.ts";

const labels: Record<string, string> = {
  received: "Recebido",
  diagnosis: "Em diagnóstico",
  quote_sent: "Orçamento enviado",
  awaiting_approval: "Aguardando sua aprovação",
  in_repair: "Em reparo",
  waiting_part: "Aguardando peça",
  testing: "Em testes",
  ready: "Pronto para retirada",
  delivered: "Entregue",
  cancelled: "Cancelado"
};

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const origin = req.headers.get("origin") ?? "";
  if (origin && !["https://aguiarepair.com.br", "https://www.aguiarepair.com.br", "http://localhost:5500", "http://127.0.0.1:5500"].includes(origin)) {
    return json(req, { error: "origin_not_allowed" }, 403);
  }
  const rateSalt = Deno.env.get("LOOKUP_RATE_LIMIT_SALT") ?? "";
  if (!rateSalt) return json(req, { error: "temporarily_unavailable" }, 503);
  if (Number(req.headers.get("content-length") ?? "0") > 4096) return json(req, { error: "request_too_large" }, 413);

  let input: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(req, { error: "invalid_request" }, 400);
    input = parsed as Record<string, unknown>;
  } catch { return json(req, { error: "invalid_request" }, 400); }
  const type = input.type === "warranty" ? "warranty" : input.type === "order" ? "order" : "";
  const orderNumber = String(input.orderNumber ?? "").trim().toUpperCase();
  const accessCode = normalizeCode(input.accessCode);

  const forwarded = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rateKey = await hmacHex(rateSalt, forwarded);
  const client = serviceClient();
  const { data: allowed, error: rateError } = await client.rpc("consume_public_lookup", { key_digest: rateKey });
  if (rateError || allowed !== true) return json(req, { error: "rate_limited" }, 429);

  if (!type || !/^AR-[0-9]{6,10}$/.test(orderNumber) || accessCode.length !== 16) {
    return json(req, { error: "not_found" }, 404);
  }

  try {
    const { data: order, error } = await client.from("work_orders")
      .select("id,order_number,brand,model,color,storage_capacity,status,public_tracking_hash")
      .eq("order_number", orderNumber)
      .maybeSingle();
    const suppliedHash = await sha256(accessCode);
    if (error || !order || !constantTimeEqual(suppliedHash, order.public_tracking_hash)) {
      return json(req, { error: "not_found" }, 404);
    }

    if (type === "order") {
      const { data: eventRows } = await client.from("work_order_events")
        .select("public_summary,created_at")
        .eq("work_order_id", order.id)
        .not("public_summary", "is", null)
        .order("created_at", { ascending: false })
        .limit(8);
      const timeline = (eventRows ?? []).reverse().map(event => ({
        label: event.public_summary,
        date: event.created_at
      }));
      const { data: quote } = await client.from("quotes")
        .select("total,summary,status")
        .eq("work_order_id", order.id)
        .in("status", ["sent", "approved", "rejected"])
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      return json(req, {
        orderNumber: order.order_number,
        statusLabel: labels[order.status] ?? "Em andamento",
        deviceLabel: [order.brand, order.model].filter(Boolean).join(" "),
        deviceDetails: [order.color, order.storage_capacity].filter(Boolean).join(" · "),
        timeline,
        quote: quote ? {
          total: quote.total,
          summary: quote.summary,
          status: quote.status
        } : null
      });
    }

    const { data: warranty, error: warrantyError } = await client.from("warranties")
      .select("coverage_summary,starts_on,expires_on,status")
      .eq("work_order_id", order.id)
      .maybeSingle();
    if (warrantyError || !warranty) return json(req, { error: "not_found" }, 404);
    const expired = warranty.status === "expired" || warranty.expires_on < new Date().toISOString().slice(0, 10);
    return json(req, {
      orderNumber: order.order_number,
      statusLabel: expired ? "Prazo encerrado" : warranty.status === "void" ? "Cancelada" : "Ativa",
      coverageSummary: warranty.coverage_summary,
      startsOn: warranty.starts_on,
      expiresOn: warranty.expires_on
    });
  } catch {
    return json(req, { error: "temporarily_unavailable" }, 503);
  }
});
