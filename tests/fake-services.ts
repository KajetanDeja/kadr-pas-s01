import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export async function startFakeServices() {
  type Card = { code: string; campaign_id: string; active: boolean; loyalty_card: { balance: number }; email: string };
  const cards: Card[] = [], transactions: { source_id: string; member: string; details: { balance: { points: number } } }[] = [];
  const emails = new Map<string, { id: string; body: Record<string, unknown> }>();
  let calls = 0;
  let control: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1:3104");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const send = (data: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url.pathname === "/__reset") { cards.length = transactions.length = 0; emails.clear(); calls = 0; control = {}; send({}); return; }
    if (url.pathname === "/__state") { send({ cards, transactions, emails: [...emails.values()], calls }); return; }
    if (url.pathname === "/__control") {
      Object.assign(control, body);
      if (body.email && typeof body.balance === "number") { const card = cards.find(c => c.email === body.email); if (card) card.loyalty_card.balance = body.balance; }
      send({}); return;
    }
    if (url.pathname.startsWith("/resend/")) {
      if (req.headers.authorization !== "Bearer re_automated") { send({}, 401); return; }
      if (control.failMail) { send({}, 503); return; }
      if (url.pathname === "/resend/emails" && req.method === "POST") {
        const key = String(req.headers["idempotency-key"]);
        let email = emails.get(key);
        if (!email) { email = { id: randomUUID(), body }; emails.set(key, email); }
        if (control.dropMail) { control.dropMail = false; req.socket.destroy(); return; }
        send({ id: email.id }); return;
      }
      send({}, 404); return;
    }
    if (req.headers["x-app-id"] !== "test_app" || req.headers["x-app-token"] !== "test_secret") { send({}, 401); return; }
    calls++;
    if (control.unavailable) { send({}, 503); return; }
    if (control.rateLimited) { send({ key: "rate_limit_exceeded" }, 429); return; }
    const path = url.pathname.replace(/^\/voucherify\/v1\//, "").split("/").map(decodeURIComponent);
    if (path[0] === "loyalties" && path[1] === "camp_test" && path[2] === "members") {
      if (req.method === "GET") { send({ vouchers: cards.filter(c => c.email === url.searchParams.get("customer")) }); return; }
      const card = { code: `card_${randomUUID()}`, campaign_id: "camp_test", active: true, loyalty_card: { balance: 0 }, email: body.customer.source_id };
      cards.push(card);
      if (control.dropMember) { control.dropMember = false; req.socket.destroy(); return; }
      send(card); return;
    }
    if (path[0] === "loyalties" && path[1] === "members") {
      const card = cards.find(c => c.code === path[2]);
      if (!card) { send({}, 404); return; }
      if (path[3] === "transactions") { send({ data: transactions.filter(t => t.member === card.code), has_more: false }); return; }
      if (path[3] === "balance" && req.method === "POST") {
        if (card.loyalty_card.balance + body.points < 0) { send({ key: "insufficient_balance" }, 400); return; }
        // Deliberately NOT idempotent: tracking source_id does not deduplicate.
        card.loyalty_card.balance += body.points;
        transactions.push({ member: card.code, source_id: body.source_id, details: { balance: { points: body.points } } });
        if (body.points < 0 && control.delayDebitMs) await new Promise(resolve => setTimeout(resolve, Number(control.delayDebitMs)));
        if (control.dropBalance) { control.dropBalance = false; req.socket.destroy(); return; }
        send({ balance: card.loyalty_card.balance, points: body.points }); return;
      }
      send(card); return;
    }
    send({}, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(3104, "127.0.0.1", resolve); });
  return server;
}
