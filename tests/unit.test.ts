import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/server/config";
import { clientKey, isVercelDeployment } from "../src/server/rate-limit";
import { fingerprint, reservationInput } from "../src/server/validation";

const env = { DATABASE_URL: "postgresql://test:test@localhost:5432/test" };
test("Konfiguracja: domyślnie 900 s, szkolnie 120 s, niepoprawne wartości odrzucone", () => {
  assert.equal(parseConfig(env).RESERVATION_TTL_SECONDS, 900);
  assert.equal(parseConfig({...env, RESERVATION_TTL_SECONDS: "120"}).RESERVATION_TTL_SECONDS, 120);
  for (const ttl of ["0", "-1", "abc", "1.5", "", "86401"]) assert.throws(()=>parseConfig({...env, RESERVATION_TTL_SECONDS: ttl}));
  assert.throws(()=>parseConfig({DATABASE_URL:"https://example.com"}));
  assert.throws(()=>parseConfig({...env,TRUSTED_PROXY_SECRET:"short"}));
});
test("Prisma Postgres: opcjonalny pooler TCP, bez ujawniania błędnego URL-a w komunikacie", () => {
  const pooled="postgres://test:test@pooled.example.com:5432/postgres?sslmode=require";
  assert.equal(parseConfig({...env,DATABASE_URL_POOLED:pooled}).DATABASE_URL_POOLED,pooled);
  assert.equal(parseConfig(env).DATABASE_URL_POOLED,undefined);
  for(const badUrl of ["https://example.com","prisma+postgres://host/?api_key=test-secret"]) {
    assert.throws(()=>parseConfig({...env,DATABASE_URL_POOLED:badUrl}),error=>error instanceof Error && error.message.includes("DATABASE_URL_POOLED") && !error.message.includes(badUrl));
  }
});
test("Identyczność: normalizacja imienia i e-maila, różni klienci mają różne skróty", () => {
  const a = reservationInput.parse({eventId:"orbita",seatId:"F7",customerName:"  Anna   Maria  ",email:" ANNA@EXAMPLE.COM "});
  const b = reservationInput.parse({...a,customerName:"Anna Maria",email:"anna@example.com"});
  assert.equal(fingerprint(a),fingerprint(b));
  assert.notEqual(fingerprint(a),fingerprint({...b,email:"other@example.com"}));
  assert.notEqual(fingerprint(a),fingerprint({...b,eventId:"other"}));
});
test("Proxy: brak zaufania do X-Forwarded-For, wymagany sekret i jeden poprawny IP", () => {
  const spoof = new Headers({"x-forwarded-for":"192.0.2.99","x-kadr-client-ip":"192.0.2.99"});
  assert.equal(clientKey(new Headers()),clientKey(spoof));
  const secret = "test-secret-that-has-more-than-32-characters";
  assert.throws(()=>clientKey(spoof,secret));
  const a = new Headers({"x-kadr-proxy-secret":secret,"x-kadr-client-ip":"192.0.2.1"});
  const b = new Headers({"x-kadr-proxy-secret":secret,"x-kadr-client-ip":"192.0.2.2"});
  assert.notEqual(clientKey(a,secret),clientKey(b,secret));
  a.set("x-kadr-client-ip","192.0.2.1, 192.0.2.2"); assert.throws(()=>clientKey(a,secret));
});
test("Vercel: rozpoznanie wyłącznie serwerowego środowiska production lub preview", () => {
  assert.equal(isVercelDeployment({VERCEL:"1",VERCEL_ENV:"production"}),true);
  assert.equal(isVercelDeployment({VERCEL:"1",VERCEL_ENV:"preview"}),true);
  for(const platformEnv of [{},{VERCEL:"1"},{VERCEL_ENV:"production"},{VERCEL:"0",VERCEL_ENV:"production"},{VERCEL:"1",VERCEL_ENV:"development"}]) {
    assert.equal(isVercelDeployment(platformEnv),false);
  }
});
test("Vercel: różne IPv4 i IPv6 mają własne klucze bez sekretu Nginx", () => {
  const key=(ip:string)=>clientKey(new Headers({"x-vercel-forwarded-for":ip}),undefined,true);
  assert.notEqual(key("192.0.2.1"),key("192.0.2.2"));
  assert.notEqual(key("2001:db8::1"),key("2001:db8::2"));
  assert.equal(key("192.0.2.1"),clientKey(new Headers({"x-kadr-proxy-secret":"test-secret-that-has-more-than-32-characters","x-kadr-client-ip":"192.0.2.1"}),"test-secret-that-has-more-than-32-characters"));
});
test("Vercel: XFF i nagłówki KADR nie zmieniają zweryfikowanego adresu", () => {
  const original=new Headers({"x-vercel-forwarded-for":"192.0.2.1"});
  const forged=new Headers(original);
  forged.set("x-forwarded-for","198.51.100.99");
  forged.set("x-real-ip","198.51.100.98");
  forged.set("x-kadr-client-ip","198.51.100.97");
  forged.set("x-kadr-proxy-secret","wrong-secret");
  assert.equal(clientKey(original,undefined,true),clientKey(forged,"test-secret-that-has-more-than-32-characters",true));
});
test("Vercel: brak lub błędny adres odrzucony bez fallbacku do XFF", () => {
  for(const ip of [undefined,"","unknown","192.0.2.1, 192.0.2.2","192.0.2.1:1234"]) {
    const headers=new Headers({"x-forwarded-for":"192.0.2.1"});
    if(ip!==undefined) headers.set("x-vercel-forwarded-for",ip);
    assert.throws(()=>clientKey(headers,undefined,true),{status:400,code:"INVALID_CLIENT_IP"});
  }
});
test("Lokalnie: podszyte nagłówki Vercela nie włączają zaufania do IP", () => {
  const forged=new Headers({"x-vercel-forwarded-for":"192.0.2.1","x-vercel-id":"fake","vercel":"1","vercel_env":"production"});
  assert.equal(clientKey(forged),clientKey(new Headers()));
  assert.throws(()=>clientKey(forged,"test-secret-that-has-more-than-32-characters"),{status:403,code:"PROXY_REQUIRED"});
});
