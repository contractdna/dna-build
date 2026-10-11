// SSE per-IP identity: the CDN header is trusted only from a Cloudflare peer (node --test; Node strips the .ts types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp, isCloudflare } from "../app/_data/clientIp.ts";

const h = (o) => new Headers(o);

test("Cloudflare peer + cf-connecting-ip → the header is the visitor", () => {
  assert.equal(clientIp(h({ "x-real-ip": "172.70.1.2", "cf-connecting-ip": "203.0.113.9" }), "cf-connecting-ip"), "203.0.113.9");
  assert.equal(clientIp(h({ "x-real-ip": "2606:4700:10::1", "cf-connecting-ip": "2001:db8::7" }), "cf-connecting-ip"), "2001:db8::7");
  assert.equal(clientIp(h({ "x-real-ip": "::ffff:104.16.0.1", "cf-connecting-ip": "198.51.100.1" }), "cf-connecting-ip"), "198.51.100.1");
});

test("non-Cloudflare peer + spoofed cf-connecting-ip → x-real-ip", () => {
  assert.equal(clientIp(h({ "x-real-ip": "198.51.100.23", "cf-connecting-ip": "1.1.1.1" }), "cf-connecting-ip"), "198.51.100.23");
  assert.equal(clientIp(h({ "x-real-ip": "2001:db8::1", "cf-connecting-ip": "1.1.1.1" }), "cf-connecting-ip"), "2001:db8::1");
});

test("no CDN header configured, or none sent → x-real-ip, then the last X-Forwarded-For hop, then local", () => {
  assert.equal(clientIp(h({ "x-real-ip": "172.70.1.2", "cf-connecting-ip": "203.0.113.9" })), "172.70.1.2");
  assert.equal(clientIp(h({ "x-real-ip": "172.70.1.2" }), "cf-connecting-ip"), "172.70.1.2");
  assert.equal(clientIp(h({ "x-forwarded-for": "6.6.6.6, 10.0.0.3" })), "10.0.0.3");
  assert.equal(clientIp(h({})), "local");
});

test("range edges", () => {
  assert.ok(isCloudflare("162.159.255.255")); // 162.158.0.0/15
  assert.ok(!isCloudflare("162.160.0.0"));
  assert.ok(!isCloudflare("not-an-ip"));
});
