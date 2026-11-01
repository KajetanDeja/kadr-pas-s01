import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { seed } from "../prisma/seed";
import { base, second, db, headers, input, reset, request, reserve, buy, waitUntil, ownerCount, success, refused } from "./helpers";

beforeEach(reset);
after(()=>db.$disconnect());

test("A1: nieistniejący seans zwraca 404, API nie ujawnia PII, odpowiedzi no-store", async () => {
  const missing = await request("/api/events/nie-ma-takiego");
  assert.equal(missing.status,404); assert.equal(missing.data.error.code,"EVENT_NOT_FOUND");
  const list = await request("/api/events"); success(list); assert.equal(list.data.length,3);
  assert.equal((await db.eventSeat.count()),240);
  for (const event of list.data) {
    const result = await request(`/api/events/${event.id}`); success(result);
    assert.equal(result.response.headers.get("cache-control"),"no-store, max-age=0");
    assert.deepEqual(result.data.takenSeats,[]);
  }
});
test("A2: sam odczyt zwalnia wygasły fotel natychmiast, bez kasowania historii", async () => {
  const r = await reserve(); success(r);
  assert.ok((await request("/api/events/orbita")).data.takenSeats.includes("F7"));
  await waitUntil(r.data.expiresAt);
  assert.ok(!(await request("/api/events/orbita")).data.takenSeats.includes("F7"));
  const [readTime]=await db.$queryRaw<{now:Date}[]>`SELECT clock_timestamp() AS now`;
  assert.ok(readTime.now.getTime()-new Date(r.data.expiresAt).getTime()<=15000,"A2: odczyt ma zwolnić fotel w ciągu 15 s po expiresAt");
  assert.equal(await db.reservation.count(),1);
  assert.equal((await db.eventSeat.findUniqueOrThrow({where:{eventId_seatId:{eventId:"orbita",seatId:"F7"}}})).currentReservationId,r.data.reservationId);
});
test("B1: ponowienia kolejno i równocześnie w dwóch instancjach zwracają jedno ID", async () => {
  const a = await reserve(); success(a);
  const b = await reserve({...input(),customerName:" Aleksandra  ",email:"OLA@EXAMPLE.COM"},undefined,second); success(b);
  assert.deepEqual(a.data,b.data);
  const simultaneous = await Promise.all(Array.from({length:8},(_,i)=>reserve(input(),undefined,i%2?base:second)));
  for (const r of simultaneous) { success(r); assert.deepEqual(r.data,a.data); }
  assert.equal(await db.reservation.count(),1); assert.equal(await ownerCount(),1);
  // Osobno testujemy pierwsze równoczesne utworzenie, bez wcześniejszej rezerwacji.
  const fresh = await Promise.all(Array.from({length:8},(_,i)=>reserve(input("F8"),undefined,i%2?base:second)));
  for (const r of fresh) { success(r); assert.deepEqual(r.data,fresh[0].data); }
  assert.equal(await db.reservation.count(),2);
  assert.equal(await db.reservation.count({where:{eventId:"orbita",seatId:"F8"}}),1);
  assert.equal(await ownerCount("orbita","F8"),1);
  const view = await request(`/api/reservations/${a.data.reservationId}`);
  assert.equal(view.data.customerName,undefined); assert.equal(view.data.email,undefined);
});
test("B2: 20 różnych klientów równocześnie, dokładnie jeden właściciel i brak 5xx", async () => {
  const results = await Promise.all(Array.from({length:20},(_,i)=>reserve(input("F7",`client${i}@example.com`),`192.0.2.${i+1}`,i%2?base:second)));
  assert.equal(results.filter(r=>r.status>=200&&r.status<300).length,1);
  assert.equal(results.filter(r=>r.status===409).length,19);
  assert.equal(await db.reservation.count(),1); assert.equal(await ownerCount(),1);
});
test("B3: walidacja pól, JSON, typów i rozmiaru nie zapisuje błędnych rezerwacji", async () => {
  const cases: unknown[] = [
    {...input(),eventId:"nie-ma"},{...input(),seatId:"Z99"},{...input(),customerName:"  "},
    {...input(),email:""},{...input(),email:"not-email"},{...input(),eventId:12},
    {...input(),seatId:null},{...input(),customerName:{}},null,[],{...input(),unexpected:true},
    {...input(),customerName:"x".repeat(161)}
  ];
  for (const bad of cases) refused(await request("/api/reservations",bad));
  for (const body of ["{bad", " ", "x".repeat(5000)]) {
    const response = await fetch(base+"/api/reservations",{method:"POST",headers:headers(),body});
    assert.ok([400,413].includes(response.status));
  }
  const plain = await fetch(base+"/api/reservations",{method:"POST",headers:{...headers(),"Content-Type":"text/plain"},body:"abc"});
  assert.equal(plain.status,415); assert.equal(await db.reservation.count(),0);
});
test("B4: po wygaśnięciu inny klient rezerwuje ten sam fotel, historia zostaje", async () => {
  const a = await reserve(); success(a); await waitUntil(a.data.expiresAt);
  const b = await reserve(input("F7","second@example.com")); success(b);
  const [reservedTime]=await db.$queryRaw<{now:Date}[]>`SELECT clock_timestamp() AS now`;
  assert.ok(reservedTime.now.getTime()-new Date(a.data.expiresAt).getTime()<=15000,"B4: ponowna rezerwacja ma się udać w ciągu 15 s po expiresAt");
  assert.notEqual(a.data.reservationId,b.data.reservationId);
  assert.equal(await db.reservation.count(),2); assert.equal(await ownerCount(),1);
  refused(await buy(a.data.reservationId));
});
test("B5: 100 prób w 10 s, współdzielony limit 20, Retry-After i niezależna sieć", async () => {
  const started = performance.now();
  const requests = Array.from({length:100},(_,i)=>{
    const seat = `${"ABCDEFGH"[Math.floor((i%80)/10)]}${i%10+1}`;
    return reserve(input(seat,`burst${i}@example.com`,i<80?"orbita":"po-drugiej-stronie"),"198.51.100.1",i%2?base:second);
  });
  const other = reserve(input("H10","other@example.com","ostatnie-swiatlo"),"198.51.100.2",second);
  const results = await Promise.all(requests);
  success(await other);
  assert.ok(performance.now()-started<10000,"100 żądań musi zmieścić się w 10 sekundach");
  assert.equal(results.filter(r=>r.status===201).length,20);
  assert.equal(results.filter(r=>r.status===429).length,80);
  for (const r of results.filter(r=>r.status===429)) {
    const retry = Number(r.response.headers.get("retry-after")); assert.ok(Number.isInteger(retry)&&retry>=1&&retry<=10);
  }
  assert.equal(await db.reservation.count(),21);
});
test("C1: zakupy kolejno i równocześnie tworzą jeden bilet i ten sam kod", async () => {
  const r=await reserve(); success(r);
  const results=await Promise.all(Array.from({length:8},(_,i)=>buy(r.data.reservationId,i%2?base:second)));
  for(const result of results) { success(result); assert.deepEqual(result.data,results[0].data); }
  assert.deepEqual((await buy(r.data.reservationId)).data,results[0].data);
  assert.equal(await db.ticket.count(),1); assert.equal(await ownerCount(),1);
});
test("C2: pięć wyścigów przy expiresAt, zakup kontra nowa rezerwacja, bez 5xx", async () => {
  for (const [i,offset] of [-50,0,50,-20,20].entries()) {
    const seat=`E${i+1}`;
    const r=await reserve(input(seat,`x${i}@example.com`),`203.0.113.${i+1}`); success(r);
    await waitUntil(r.data.expiresAt,offset);
    const results=await Promise.all([buy(r.data.reservationId),reserve(input(seat,`y${i}@example.com`),`203.0.113.${i+20}`,second)]);
    for(const result of results) assert.ok(result.status<500,JSON.stringify(result.data));
    const [purchaseResult, reservationResult]=results;
    assert.ok([200,410].includes(purchaseResult.status),JSON.stringify(purchaseResult.data));
    assert.ok([201,409].includes(reservationResult.status),JSON.stringify(reservationResult.data));
    assert.ok(!(purchaseResult.status===200 && reservationResult.status===201),"Zakup X i rezerwacja Y nie mogą wygrać jednocześnie");
    assert.ok(await ownerCount("orbita",seat)<=1);
    assert.ok(await db.ticket.count({where:{eventId:"orbita",seatId:seat}})<=1);
    const owner=await db.eventSeat.findUniqueOrThrow({where:{eventId_seatId:{eventId:"orbita",seatId:seat}}});
    if(purchaseResult.status===200) {
      assert.equal(owner.currentReservationId,r.data.reservationId);
      assert.equal(await db.ticket.count({where:{reservationId:r.data.reservationId}}),1);
    }
    if(reservationResult.status===201) assert.equal(owner.currentReservationId,reservationResult.data.reservationId);
  }
});
test("C3: nieistniejący UUID oraz abc odrzucone bez biletu", async () => {
  assert.equal((await buy(randomUUID())).status,404);
  assert.equal((await buy("abc")).status,400);
  assert.equal(await db.ticket.count(),0);
});
test("C4: wygasła odmówiona, kupiona pozostaje zajęta i idempotentna po TTL", async () => {
  const expired=await reserve(input("F7")); success(expired);
  const valid=await reserve(input("F8")); success(valid);
  const bought=await buy(valid.data.reservationId); success(bought);
  await waitUntil(valid.data.expiresAt);
  assert.equal((await buy(expired.data.reservationId)).status,410);
  assert.deepEqual((await buy(valid.data.reservationId,second)).data,bought.data);
  const map=await request("/api/events/orbita");
  assert.ok(map.data.takenSeats.includes("F8")); assert.ok(!map.data.takenSeats.includes("F7"));
  assert.equal((await reserve(input("F8","other@example.com"))).status,409);
  assert.equal(await db.ticket.count(),1);
});
test("Blokada: zakup rozpoczęty przed terminem, ale czekający na blokadę, wygasa", async () => {
  const r=await reserve(); success(r);
  let pending: ReturnType<typeof buy> | undefined;
  await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT * FROM "EventSeat" WHERE "eventId"='orbita' AND "seatId"='F7' FOR UPDATE`;
    pending=buy(r.data.reservationId);
    await waitUntil(r.data.expiresAt,100);
  },{timeout:10000});
  assert.equal((await pending!).status,410); assert.equal(await db.ticket.count(),0);
});
test("Seanse w tej samej sali mają osobną zajętość; seed nie usuwa historii", async () => {
  const a=await reserve();success(a);success(await buy(a.data.reservationId));
  success(await reserve(input("F7","other@example.com","ostatnie-swiatlo")));
  await seed(db);await seed(db);
  assert.equal(await db.eventSeat.count(),240);assert.equal(await db.reservation.count(),2);assert.equal(await db.ticket.count(),1);
});
test("Limiter czyści stare wpisy, odrzuca fałszywe proxy i nie ufa XFF", async () => {
  await db.rateLimit.create({data:{key:"stale",attempts:1,expiresAt:new Date(Date.now()-120000)}});
  success(await reserve()); assert.equal(await db.rateLimit.count({where:{key:"stale"}}),0);
  const response=await fetch(base+"/api/reservations",{method:"POST",headers:{"Content-Type":"application/json","X-Forwarded-For":"8.8.8.8"},body:JSON.stringify(input("A1"))});
  assert.equal(response.status,403);
});
test("Baza wymusza jeden bilet, unikalny kod i zgodność właściciela z fotelem", async () => {
  const r=await reserve();success(r);success(await buy(r.data.reservationId));
  const ticket=await db.ticket.findFirstOrThrow();
  await assert.rejects(()=>db.ticket.create({data:{...ticket,id:randomUUID(),code:"different-code"}}));
  const other=await reserve(input("F8"));success(other);
  await assert.rejects(()=>db.ticket.create({data:{...ticket,id:randomUUID(),reservationId:other.data.reservationId,seatId:"F8"}}));
  await assert.rejects(()=>db.$transaction(async tx=>{
    // Najpierw zwalniamy unikalny wskaźnik w wycofywanej transakcji, aby
    // odrzucenie sprawdzało złożony FK, a nie tylko UNIQUE właściciela.
    await tx.eventSeat.update({where:{eventId_seatId:{eventId:"orbita",seatId:"F7"}},data:{currentReservationId:null}});
    await tx.eventSeat.update({where:{eventId_seatId:{eventId:"orbita",seatId:"A1"}},data:{currentReservationId:r.data.reservationId}});
  }));
  assert.equal(await db.ticket.count(),1);
});
