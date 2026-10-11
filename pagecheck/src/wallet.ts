// What the check installs in EVERY frame and popup before any page script (an init script): a mock EIP-1193 wallet at
// window.ethereum (configurable, as wallets inject it, so the page's guard takes it over), decoys at the other names
// wallets use, and the run's fixed randomness. Every wallet request goes to the harness with its JS stack, the frame's
// URL and whether that frame has a working guard; any touch of a decoy is reported the same way.
// `mock` must stay self-contained (no imports, no outer references): it is serialized with Function#toString.

/** The names wallets use besides `ethereum` (the guard's ALIASES; a test keeps the two lists equal). */
export const DECOYS = ["rabby", "coinbaseWalletExtension", "trustwallet", "okxwallet", "web3"];
/** A wallet-shaped object under a name no list knows: the guard must find it by shape and hide it. */
export const LOOKALIKE = "freshWalletProvider";

/** `locked`: a wallet that defines window.ethereum non-configurable before any page script (the guard must fail closed). */
export type MockConfig = { binding: string; random: number; decoys: string[]; lookalike: string; locked?: boolean };
export type Report =
  | { kind: "request"; method: string; params: unknown; stack: string; frame: string; top: boolean; guarded: boolean }
  | { kind: "decoy"; name: string; method?: string; stack: string; frame: string; top: boolean }
  | { kind: "webrtc"; name: string; frame: string };

export function mock(cfg: MockConfig, w: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const bind = w[cfg.binding];
  try { delete w[cfg.binding]; } catch (_e) { /* stays: harmless */ }
  const call = (r: unknown) => bind(r);
  const frame = () => String(w.location && w.location.href);
  const top = () => { try { return w === w.top; } catch (_e) { return false; } };
  const stack = () => String(new Error("x").stack || "");

  // WebRTC: peer connections reach the network around the route and the policy: using one is a violation
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
    if (!(name in w)) continue;
    const no = function () { call({ kind: "webrtc", name, frame: frame() }); throw new Error("refused"); };
    try { Object.defineProperty(w, name, { value: no, configurable: true, writable: true }); } catch (_e) { /* left as is */ }
  }

  // randomness: one fixed value for the whole run (the harness repeats the run at several values)
  const R = cfg.random;
  w.Math.random = () => R;
  const byte = Math.min(255, Math.floor(R * 256));
  if (w.crypto) {
    w.crypto.getRandomValues = (a: any) => { new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(byte); return a; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    w.crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000";
  }

  const provider = (decoy: string | null) => ({
    request: async (args: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      // taken here, first: [0] is this function, [1] its caller (the guard's raw(), when it came through the guard)
      const at = String(new Error("x").stack || "");
      const method = args && typeof args.method === "string" ? args.method : "";
      if (decoy !== null) {
        call({ kind: "decoy", name: decoy, method, stack: at, frame: frame(), top: top() });
        throw Object.assign(new Error("refused"), { code: 4100 });
      }
      const g = w.__dnaGuard;
      const out = await call({ kind: "request", method, params: args && args.params, stack: at, frame: frame(), top: top(), guarded: !!(g && g.ok === true) });
      if (out && out.error) throw Object.assign(new Error(String(out.error.message)), { code: out.error.code });
      return out ? out.result : null;
    },
    on: () => {},
    removeListener: () => {},
  });
  const raw = provider(null);
  Object.defineProperty(w, "ethereum", { value: raw, configurable: !cfg.locked, writable: !cfg.locked, enumerable: true });
  // EIP-6963, as wallets do it: announce on load and on every request for providers
  const info = Object.freeze({ uuid: "00000000-0000-4000-8000-0000000000aa", name: "Wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "test.wallet" });
  const announce = () => w.dispatchEvent(new w.CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider: raw }) }));
  w.addEventListener("eip6963:requestProvider", announce);
  announce();
  for (let i = 0; i < cfg.decoys.length; i++) {
    const name = cfg.decoys[i];
    const p = provider(name);
    Object.defineProperty(w, name, {
      configurable: true, enumerable: true,
      get: () => { call({ kind: "decoy", name, stack: stack(), frame: frame(), top: top() }); return p; },
    });
  }
  // found only by shape: a plain property (reading it is no touch; using it is)
  Object.defineProperty(w, cfg.lookalike, { value: provider(cfg.lookalike), configurable: true, writable: true, enumerable: true });
}

/** The init script for one run. */
export const mockScript = (cfg: MockConfig) => `(${mock.toString()})(${JSON.stringify(cfg)}, window);`;
