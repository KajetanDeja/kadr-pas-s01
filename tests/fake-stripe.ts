import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export async function startFakeStripe() {
  const sessions = new Map<string, Record<string, unknown>>();
  const refunds = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, Record<string, unknown>>();
  let dropCheckout = false, failRefund = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1:3103");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const form = new URLSearchParams(body);
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/__reset") { sessions.clear(); refunds.clear(); keys.clear(); dropCheckout = failRefund = false; send({}); return; }
    if (url.pathname === "/__state") { send({ sessions: [...sessions.values()], refunds: [...refunds.values()] }); return; }
    if (url.pathname === "/__control") {
      const control = JSON.parse(body);
      dropCheckout = control.dropCheckout ?? dropCheckout; failRefund = control.failRefund ?? failRefund;
      if (control.expire) { const s = sessions.get(control.expire); if (s) { s.status = "expired"; s.url = null; } }
      if (control.refundId && control.refundStatus) { const r = refunds.get(control.refundId); if (r) r.status = control.refundStatus; }
      send({}); return;
    }
    const key = `${req.method}:${url.pathname}:${req.headers["idempotency-key"] ?? ""}`;
    if (req.method === "POST" && req.headers["idempotency-key"] && keys.has(key)) { send(keys.get(key)); return; }
    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const id = `cs_test_${randomUUID().replaceAll("-", "")}`;
      const session = {
        id, object: "checkout.session", livemode: false, mode: form.get("mode"),
        client_reference_id: form.get("client_reference_id"), metadata: { attemptId: form.get("metadata[attemptId]") },
        amount_total: Number(form.get("line_items[0][price_data][unit_amount]")), currency: form.get("line_items[0][price_data][currency]"),
        status: "open", payment_status: "unpaid", payment_intent: null,
        url: `https://checkout.stripe.com/c/pay/${id}`, success_url: form.get("success_url"), cancel_url: form.get("cancel_url"),
        payment_method_types: [form.get("allowed_payment_method_types[0]")],
        adaptive_pricing: { enabled: form.get("adaptive_pricing[enabled]") === "true" }
      };
      sessions.set(id, session); keys.set(key, session);
      if (dropCheckout) { dropCheckout = false; req.socket.destroy(); return; }
      send(session); return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
      const session = sessions.get(url.pathname.split("/").at(-1)!);
      send(session ?? { error: { message: "Unknown session" } }, session ? 200 : 404); return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/expire")) {
      const session = sessions.get(url.pathname.split("/").at(-2)!);
      if (!session || session.status !== "open") { send({ error: { message: "Cannot expire session" } }, 400); return; }
      session.status = "expired"; session.url = null;
      send(session); return;
    }
    if (url.pathname === "/v1/refunds" && req.method === "GET") {
      send({ object: "list", data: [...refunds.values()].filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false }); return;
    }
    if (url.pathname === "/v1/refunds" && req.method === "POST") {
      if (failRefund) { send({ error: { type: "api_error", message: "Temporary test failure" } }, 503); return; }
      const refund = { id: `re_${randomUUID().replaceAll("-", "")}`, object: "refund", status: "succeeded", payment_intent: form.get("payment_intent"), metadata: { attemptId: form.get("metadata[attemptId]") } };
      refunds.set(refund.id, refund); keys.set(key, refund); send(refund); return;
    }
    if (url.pathname.startsWith("/v1/refunds/") && req.method === "GET") {
      const refund = refunds.get(url.pathname.split("/").at(-1)!); send(refund ?? {}, refund ? 200 : 404); return;
    }
    send({ error: { message: "Unsupported test request" } }, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(3103, "127.0.0.1", resolve); });
  return server;
}
