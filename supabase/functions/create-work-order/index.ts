import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearerToken, corsHeaders, encryptDeviceSecret, isValidCpf, json, normalizeCpf, randomAccessCode, sha256, SUPABASE_URL, PUBLISHABLE_KEY } from "../_shared/common.ts";

const optional = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

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
  const order = {
    brand: optional(body.device?.brand, 80),
    model: optional(body.device?.model, 120),
    color: optional(body.device?.color, 80),
    storageCapacity: optional(body.device?.storageCapacity, 40),
    platform: optional(body.device?.platform, 16),
    lockType: optional(body.device?.lockType, 16),
    reportedIssue: optional(body.entry?.reportedIssue, 4000),
    physicalCondition: optional(body.entry?.physicalCondition, 3000),
    accessories: Array.isArray(body.entry?.accessories) ? body.entry.accessories.map((x: unknown) => optional(x, 100)).filter(Boolean).slice(0, 20) : [],
    internalNotes: optional(body.entry?.internalNotes, 3000)
  };
  const accessSecret = optional(body.device?.accessSecret, 200);
  if ((customer.id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customer.id)) || !isValidCpf(body.customer?.cpf) ||
      customer.name.length < 2 || customer.whatsapp.length < 8 || order.brand.length < 1 ||
      order.model.length < 1 || order.reportedIssue.length < 3 ||
      !["android", "iphone", "other", ""].includes(order.platform) ||
      !["none", "pin", "password", "pattern", "other", ""].includes(order.lockType)) {
    return json(req, { error: "invalid_fields" }, 400);
  }

  const userClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: "Bearer " + token } }
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return json(req, { error: "unauthorized" }, 401);
  const { data: profile, error: profileError } = await userClient.from("staff_profiles")
    .select("role,active").eq("user_id", authData.user.id).maybeSingle();
  if (profileError || !profile?.active || !["admin", "employee", "technician"].includes(profile.role)) {
    return json(req, { error: "forbidden" }, 403);
  }

  try {
    const accessCode = randomAccessCode();
    const trackingHash = await sha256(accessCode);
    const encrypted = accessSecret ? await encryptDeviceSecret(accessSecret) : null;
    const { data, error } = await userClient.rpc("create_work_order_atomic", {
      customer_data: customer,
      order_data: order,
      tracking_hash: trackingHash,
      secret_ciphertext: encrypted?.ciphertext ?? null,
      secret_iv: encrypted?.iv ?? null
    });
    if (error || !data?.[0]) {
      const code = error?.code ?? "unknown";
      const message = code === "42501"
        ? "Esta conta não tem permissão para criar ordens de serviço. Peça à administração para revisar o acesso da equipe."
        : code === "P0002"
          ? "O cliente selecionado não foi encontrado. Atualize a lista de clientes e tente novamente."
          : code === "23505" && error?.message?.includes("customers_cpf_unique_idx")
            ? "Este CPF já está cadastrado para outro cliente. Confira o CPF ou selecione o cadastro correto."
            : code === "23505"
              ? "Já existe um registro com esses dados. Confira o cadastro do cliente e tente novamente."
              : code === "23514" || code.startsWith("22")
                ? "Um dos dados informados não passou pela validação do banco. Revise os campos obrigatórios."
                : `O banco recusou a criação da OS (código ${code}).`;
      return json(req, { error: "could_not_create_order", message }, code === "42501" ? 403 : 400);
    }
    return json(req, {
      orderId: data[0].id,
      orderNumber: data[0].order_number,
      accessCode,
      message: "Anote o código e entregue ao cliente. Ele não poderá ser recuperado depois."
    }, 201);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const message = reason === "device_secret_encryption_not_configured"
      ? "A configuração de segurança do aparelho está incompleta no servidor. Avise a administração."
      : reason === "device_secret_encryption_key_must_be_32_bytes"
        ? "A configuração de segurança do aparelho está inválida no servidor. Avise a administração."
        : reason === "server_configuration_missing"
          ? "A configuração do Supabase está incompleta. Avise a administração."
          : "O Supabase encontrou uma falha interna ao criar a OS. Tente novamente e, se persistir, avise a administração.";
    return json(req, { error: "server_configuration_or_database_error", message }, 503);
  }
});
