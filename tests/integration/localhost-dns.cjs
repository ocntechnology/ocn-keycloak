// Resolve every *.localhost name to the loopback address inside Node.
//
// Browsers (Chromium, Firefox) already resolve *.localhost to 127.0.0.1 (RFC 6761), but
// macOS's resolver does not, so Node and the products' servers would fail with ENOTFOUND
// when they call http://auth.civicos.localhost:8180 or http://docs.civicos.localhost:3120.
// Loaded with NODE_OPTIONS="--require <this file>" by civicos-local's scripts. Local only.
"use strict";
const dns = require("node:dns");

const isLocal = (host) => typeof host === "string" && /(^|\.)localhost\.?$/i.test(host) && host.toLowerCase() !== "localhost";

function answer(options) {
  const family = typeof options === "number" ? options : options && options.family;
  const v6 = family === 6;
  const address = v6 ? "::1" : "127.0.0.1";
  if (options && typeof options === "object" && options.all) return [{ address, family: v6 ? 6 : 4 }];
  return { address, family: v6 ? 6 : 4 };
}

const original = dns.lookup;
function lookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  if (!isLocal(hostname)) return original.call(dns, hostname, options, callback);
  const a = answer(options);
  process.nextTick(() => (Array.isArray(a) ? callback(null, a) : callback(null, a.address, a.family)));
  return {};
}
dns.lookup = lookup;

const originalPromise = dns.promises.lookup;
dns.promises.lookup = async function (hostname, options) {
  if (!isLocal(hostname)) return originalPromise.call(dns.promises, hostname, options);
  return answer(options || {});
};
