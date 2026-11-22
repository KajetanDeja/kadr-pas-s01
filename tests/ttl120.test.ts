import { after, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { db, reset, input, reserve, request, success, ownerCount, webhook, completed } from "./helpers";
after(()=>db.$disconnect());
test("TTL 120 s: rzeczywisty upływ dwóch minut, zakup trwały, wygasła rezerwacja wolna", {timeout:150000}, async()=>{
  await reset();
  const expired=await reserve();success(expired);
  const valid=await reserve(input("F8"));success(valid);
  for(const r of [expired,valid]) {
    const record=await db.reservation.findUniqueOrThrow({where:{id:r.data.reservationId}});
    assert.equal(record.expiresAt.getTime()-record.createdAt.getTime(),120000);
  }
  const checkoutPath = `/api/reservations/${valid.data.reservationId}/checkout`;
  const checkout = await request(checkoutPath, {}); success(checkout);
  const { sessions } = await (await fetch("http://127.0.0.1:3103/__state")).json();
  success(await webhook(completed(sessions[0])));
  const ticket = await request(`/api/reservations/${valid.data.reservationId}`); success(ticket);
  assert.equal(ticket.data.status, "paid"); assert.match(ticket.data.code, /^KADR-/);
  for(let i=0;i<4;i++) { await sleep(30500);console.log(`TTL 120 s: upłynęło ${(i+1)*30.5} s rzeczywistego czasu.`); }
  const map=await request("/api/events/orbita");success(map);
  assert.ok(!map.data.takenSeats.includes("F7"));assert.ok(map.data.takenSeats.includes("F8"));
  assert.equal((await request(`/api/reservations/${expired.data.reservationId}/checkout`, {})).status,410);
  assert.equal((await request(checkoutPath, {})).status,409);
  const paid = await request(`/api/reservations/${valid.data.reservationId}`); success(paid);
  assert.equal(paid.data.status, "paid"); assert.equal(paid.data.code, ticket.data.code);
  success(await reserve(input("F7","other@example.com")));
  assert.equal(await ownerCount("orbita","F7"),1);assert.equal(await ownerCount("orbita","F8"),1);
  assert.equal(await db.ticket.count(),1);assert.equal(await db.reservation.count(),3);
});
