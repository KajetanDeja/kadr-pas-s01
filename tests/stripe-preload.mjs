// Włączane wyłącznie przez runner przez --import, nigdy przez env aplikacji.
globalThis.kadrStripeTransport = { host: "127.0.0.1", port: 3103, protocol: "http" };
const originalFetch = globalThis.fetch;
globalThis.kadrServiceFetch = (input, options) => {
  const url = new URL(input);
  const service = url.hostname === "api.resend.com" ? "resend" : "voucherify";
  return originalFetch(`http://127.0.0.1:3104/${service}${url.pathname}${url.search}`, options);
};
