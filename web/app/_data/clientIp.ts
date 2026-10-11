// The visitor's IP for the SSE per-IP cap. Railway's edge sets X-Real-IP to the TCP peer it saw: the visitor, or a
// Cloudflare edge when Cloudflare proxies genomedna.xyz. A CDN header (SSE_IP_HEADER = cf-connecting-ip) is trusted ONLY
// when that peer is inside Cloudflare's published ranges. Anyone reaching the origin directly (the *.up.railway.app
// domain, or Railway's edge with Host: genomedna.xyz) can send any cf-connecting-ip they like, so without that check
// the header would let them dodge the per-IP cap.
import { BlockList, isIP } from "node:net";

// https://www.cloudflare.com/ips-v4 + /ips-v6, fetched 2026-10-06. Cloudflare rarely changes these and announces it
// in advance. Refresh by hand (curl both URLs, paste); no CI job checks them. If a new range is missing here, those
// visitors are counted by their Cloudflare edge IP (they hit the per-IP cap sooner). A spoofed header is never trusted.
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
const cf = new BlockList();
for (const r of CLOUDFLARE) {
  const [net, bits] = r.split("/");
  cf.addSubnet(net, Number(bits), isIP(net) === 6 ? "ipv6" : "ipv4");
}

export function isCloudflare(ip: string): boolean {
  const a = ip.replace(/^::ffff:/i, ""); // IPv4-mapped IPv6
  const v = isIP(a);
  return v !== 0 && cf.check(a, v === 6 ? "ipv6" : "ipv4");
}

/** `ipHeader` (e.g. cf-connecting-ip) if the peer (x-real-ip) is a Cloudflare edge; else x-real-ip; else the LAST
 *  X-Forwarded-For hop (the one our proxy appended; earlier entries are client-supplied); else "local". */
export function clientIp(h: Headers, ipHeader?: string): string {
  const peer = h.get("x-real-ip")?.trim();
  if (ipHeader && peer && isCloudflare(peer)) {
    const v = h.get(ipHeader)?.trim();
    if (v) return v;
  }
  return peer || h.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
}
