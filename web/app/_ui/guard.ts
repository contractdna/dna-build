// The wallet guard of the play origin. The root layout inlines `guardScript(cfg)` as the first script of <head> (with
// the request's CSP nonce), so it runs before any Next chunk or game module. Game pages are code an AI wrote: the
// guard is what stands between that code and the visitor's wallet.
//  - It takes the injected provider(s) into a closure and redefines window.ethereum as a guarded provider
//    (non-configurable, non-writable). Known aliases and anything else on window that looks like a wallet provider are
//    redefined as undefined. EIP-6963 announcements are caught (capturing listener, first) and never reach game code;
//    a request for providers is answered with the guarded one only. If any of this can't be done (a wallet defined its
//    property non-configurable first), the guard fails closed: it refuses every request and says so.
//  - The guarded provider answers only reads (chain id, accounts, block number, receipts, eth_call / eth_getCode to the
//    game or the factory) and one write: eth_sendTransaction to the game's address, value 0, with one of the game's
//    selectors, after checking chain 1, factory.isGame(game) and the kill flag.
//  - Kill: it polls /api/kill/<slug> (same origin) every 60 s and before every send. A pulled game ({killed: true})
//    stays pulled on this page; a check that can't be read pauses the game until the next clean {killed: false}. Either
//    way it refuses everything meanwhile and tells the page ("dna:killed", then "dna:resumed" after a pause).
//  - It uses only primordials captured at load (Reflect.apply, defineProperty, freeze, the event methods, JSON, fetch,
//    setInterval, CustomEvent), so a game that patches them later changes nothing. Everything it hands out is frozen.
// `guard` must stay self-contained (no imports, no outer references): it is serialized with Function#toString.
export type GuardConfig = { slug: string; address: string; factory: string; selectors: string[]; chainId: string; killUrl: string };
/** isGame(address) */
export const IS_GAME = "0xc626c52e";
/** Window properties wallets are known to use besides `ethereum` (others are found by shape). */
export const ALIASES = ["rabby", "coinbaseWalletExtension", "trustwallet", "okxwallet", "web3"];

export function guard(cfg: GuardConfig & { isGame: string; aliases: string[] }, w: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const R = Reflect.apply;
  const DP = Object.defineProperty;
  const FZ = Object.freeze;
  const NAMES = Object.getOwnPropertyNames;
  const stopImm = w.Event.prototype.stopImmediatePropagation;
  const addL = w.EventTarget.prototype.addEventListener;
  const disp = w.EventTarget.prototype.dispatchEvent;
  const JS = JSON.stringify;
  const JP = JSON.parse;
  const lower = String.prototype.toLowerCase;
  const slice = String.prototype.slice;
  const has = Array.prototype.includes;
  const push = Array.prototype.push;
  const fetchF = w.fetch;
  const jsonOf = w.Response.prototype.json;
  const setI = w.setInterval;
  const CE = w.CustomEvent;
  const P = Promise;
  const lc = (s: unknown) => (typeof s === "string" ? R(lower, s, []) : "");
  const E = Error;
  const err = (code: number, message: string) => { const e: any = new E(message); e.code = code; return FZ(e); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  // every refusal is also written to the console ("[dna-guard] refused <method>: <why>"): the enclave's page check
  // reads it, so an attempt the guard stopped still counts against the page
  const con = w.console;
  const warn = con && con.warn;
  const no = (code: number, message: string, method: string) => {
    try { if (warn) R(warn, con, ["[dna-guard] refused " + method + ": " + message]); } catch (_e) { /* no console */ }
    return err(code, message);
  };
  const refuse = (code: number, message: string, method: string) => P.reject(no(code, message, method));
  // killed: the game was pulled (sticky: never undone on this page); unreachable: the status couldn't be read (lifted by
  // the next clean answer)
  const state = { raw: null as any, killed: false, unreachable: false, why: "", failed: "", announcing: false }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const providers: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const isProvider = (v: any) => !!v && typeof v === "object" && typeof v.request === "function"; // eslint-disable-line @typescript-eslint/no-explicit-any

  const tell = (type: string, why: string, pulled: boolean) => {
    state.why = why;
    try { R(disp, w, [new CE(type, { detail: FZ({ why, pulled }) })]); } catch (_e) { /* nothing to tell */ }
  };
  // async/await, never .then: awaiting a native promise doesn't go through a (patchable) Promise.prototype.then
  const checkKill = async () => {
    let j: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      const r: any = await R(fetchF, w, [cfg.killUrl, FZ({ cache: "no-store", credentials: "omit" })]); // eslint-disable-line @typescript-eslint/no-explicit-any
      j = r && r.ok ? await R(jsonOf, r, []) : null;
    } catch (_e) { j = null; }
    if (j && j.killed === true) {
      if (!state.killed) { state.killed = true; tell("dna:killed", j.why ? String(j.why) : "this game was pulled", true); }
    } else if (j && j.killed === false) {
      if (state.unreachable && !state.killed) { state.unreachable = false; tell("dna:resumed", "", false); }
    } else if (!state.unreachable && !state.killed) {
      state.unreachable = true;
      tell("dna:killed", "the game's status can't be checked right now; it comes back once it can", false);
    }
    return state.killed || state.unreachable;
  };

  const raw = (method: string, params: unknown[]) => {
    const p = state.raw;
    if (!p) return P.reject(err(4900, "no wallet"));
    return R(p.request, p, [FZ({ method, params })]);
  };
  const to = (x: any) => lc(x && x.to); // eslint-disable-line @typescript-eslint/no-explicit-any
  const game = lc(cfg.address);
  const factory = lc(cfg.factory);
  const pad = (a: string) => "000000000000000000000000" + R(slice, a, [2]);

  const request = (args: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const method = args && typeof args.method === "string" ? args.method : "";
    const params = args && args.params ? JP(JS(args.params)) : [];
    if (state.failed) return refuse(4100, state.failed, method);
    if (state.killed || state.unreachable) return refuse(4100, "this game is paused", method);
    if (R(has, ["eth_chainId", "eth_accounts", "eth_requestAccounts", "eth_blockNumber", "eth_getTransactionReceipt"], [method])) return raw(method, params);
    if (method === "eth_call") {
      const t = to(params[0]);
      if (t !== game && t !== factory) return refuse(4100, "eth_call only to the game or the factory", method);
      return raw(method, [FZ({ to: params[0].to, data: String(params[0].data || "0x") }), params[1] || "latest"]);
    }
    if (method === "eth_getCode") {
      const a = lc(params[0]);
      if (a !== game && a !== factory) return refuse(4100, "eth_getCode only of the game or the factory", method);
      return raw(method, [params[0], params[1] || "latest"]);
    }
    if (method === "eth_sendTransaction") {
      const tx = params[0] || {};
      const keys = NAMES(tx);
      for (let i = 0; i < keys.length; i++) if (!R(has, ["from", "to", "data", "value", "gas"], [keys[i]])) return refuse(4100, "unexpected field " + keys[i], method);
      if (to(tx) !== game) return refuse(4100, "transactions go only to this game", method);
      if (tx.value !== undefined && !/^0x0*$/.test(String(tx.value)) && Number(tx.value) !== 0) return refuse(4100, "games take no deposits", method);
      const data = lc(tx.data);
      if (!R(has, cfg.selectors, [R(slice, data, [0, 10])])) return refuse(4100, "not one of this game's functions", method);
      const send = FZ(tx.gas ? { from: tx.from, to: cfg.address, data, value: "0x0", gas: tx.gas } : { from: tx.from, to: cfg.address, data, value: "0x0" });
      return (async () => {
        if (await checkKill()) throw no(4100, "this game is paused", method);
        if (lc(await raw("eth_chainId", [])) !== lc(cfg.chainId)) throw no(4901, "switch your wallet to Ethereum mainnet", method);
        const r = await raw("eth_call", [FZ({ to: cfg.factory, data: cfg.isGame + pad(game) }), "latest"]);
        if (typeof r !== "string" || !/^0x0{63}1$/.test(r)) throw no(4100, "not a DNA game", method);
        if (state.killed || state.unreachable || state.failed) throw no(4100, "this game is paused", method);
        return raw("eth_sendTransaction", [send]);
      })();
    }
    return refuse(4200, "not allowed on this page: " + method, method);
  };
  const listeners = (name: string) => (event: string, fn: unknown) => {
    const p = state.raw;
    if (p && typeof p[name] === "function" && (event === "accountsChanged" || event === "chainChanged")) R(p[name], p, [event, fn]);
  };
  const guarded = FZ({ isDNAGuard: true, request: FZ(request), on: FZ(listeners("on")), removeListener: FZ(listeners("removeListener")), providers: FZ([] as unknown[]) });
  const info = FZ({ uuid: "6f7d3c2a-0d1e-4b6a-9b1d-5c3e8a2f4b70", name: "Your wallet (through this page's guard)", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "xyz.dna.guard" });

  // EIP-6963: every announcement is caught before anything else sees it; a request gets the guarded provider only
  R(addL, w, ["eip6963:announceProvider", (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (state.announcing) return;
    R(stopImm, e, []);
    const p = e && e.detail && e.detail.provider;
    if (isProvider(p)) { R(push, providers, [p]); if (!state.raw) state.raw = p; }
  }, true]);
  R(addL, w, ["eip6963:requestProvider", (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    R(stopImm, e, []);
    state.announcing = true;
    try { R(disp, w, [new CE("eip6963:announceProvider", { detail: FZ({ info, provider: guarded }) })]); } finally { state.announcing = false; }
  }, true]);

  try {
    if (isProvider(w.ethereum)) state.raw = w.ethereum;
    const names = NAMES(w);
    const hide: string[] = [];
    for (let i = 0; i < cfg.aliases.length; i++) R(push, hide, [cfg.aliases[i]]);
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (n === "ethereum" || R(has, hide, [n])) continue;
      let v: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      let win = false;
      try { v = w[n]; win = v === w; } catch (_e) { continue; }
      // window, self, globalThis, frames, top, parent: the window itself, not a wallet (its .ethereum is taken over below).
      // Identity only: a planted object can claim any shape, but it can never be the window.
      if (win) continue;
      if (v && typeof v === "object" && (isProvider(v) || isProvider(v.ethereum) || isProvider(v.provider))) R(push, hide, [n]);
    }
    DP(w, "ethereum", { value: guarded, configurable: false, writable: false, enumerable: true });
    for (let i = 0; i < hide.length; i++) DP(w, hide[i], { value: undefined, configurable: false, writable: false });
    // `stop`: the pull or pause in force now (null when none), for a page that mounts after the event went out
    DP(w, "__dnaGuard", { value: FZ({ ok: true, get stop() { return state.killed || state.unreachable ? FZ({ why: state.why, pulled: state.killed }) : null; } }), configurable: false, writable: false });
  } catch (_e) {
    state.failed = "this page can't use your wallet safely: use another browser or wallet";
    try { DP(w, "__dnaGuard", { value: FZ({ ok: false, why: state.failed }), configurable: false, writable: false }); } catch (_e2) { /* nothing more to do */ }
  }
  R(setI, w, [() => { checkKill(); }, 60_000]);
  checkKill();
}

/** May a game's code run in this window? Only behind a working guard (GameRoot asks before mounting the game). */
export function guardReady(w: unknown) {
  const x = w as { __dnaGuard?: { ok?: unknown }; ethereum?: { isDNAGuard?: unknown } } | undefined;
  return x?.__dnaGuard?.ok === true && x?.ethereum?.isDNAGuard === true;
}

/** The pull or pause the guard has in force right now (null when none, or without a guard). */
export function guardStop(w: unknown): { why: string; pulled: boolean } | null {
  const s = (w as { __dnaGuard?: { stop?: { why?: unknown; pulled?: unknown } | null } } | undefined)?.__dnaGuard?.stop;
  return s ? { why: String(s.why ?? ""), pulled: s.pulled === true } : null;
}

/** The inline script: the guard, serialized, with this game's config. */
export function guardScript(cfg: GuardConfig) {
  return `(${guard.toString()})(${JSON.stringify({ ...cfg, isGame: IS_GAME, aliases: ALIASES }).replace(/</g, "\\u003c")}, window);`;
}
