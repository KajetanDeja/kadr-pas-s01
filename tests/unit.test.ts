import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/server/config";
import { clientKey } from "../src/server/rate-limit";
import { fingerprint, reservationInput } from "../src/server/validation";

const env = { DATABASE_URL: "postgresql://test:test@localhost:5432/test" };
test("Konfiguracja: domyślnie 900 s, szkolnie 120 s, niepoprawne wartości odrzucone", () => {
  assert.equal(parseConfig(env).RESERVATION_TTL_SECONDS, 900);
  assert.equal(parseConfig({...env, RESERVATION_TTL_SECONDS: "120"}).RESERVATION_TTL_SECONDS, 120);
  for (const ttl of ["0", "-1", "abc", "1.5", "", "86401"]) assert.throws(()=>parseConfig({...env, RESERVATION_TTL_SECONDS: ttl}));
  assert.throws(()=>parseConfig({DATABASE_URL:"https://example.com"}));
  assert.throws(()=>parseConfig({...env,TRUSTED_PROXY_SECRET:"short"}));
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
