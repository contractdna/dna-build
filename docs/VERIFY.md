# Verify

Everything below runs on your machine with public data. Requirements: Node 24, `npm ci` in `engine/`, an Ethereum RPC
you trust, and Docker with BuildKit for the image rebuild.

## 1. The contracts

```bash
cd contracts && forge build
```

Compare the deployed runtime bytecode (`cast code <address> --rpc-url $RPC`) with `out/<Contract>.sol/<Contract>.json`
`deployedBytecode` (immutables differ; their positions are in `immutableReferences`). Build settings are fixed in
`foundry.toml` (solc 0.8.26, optimizer 800 runs, `bytecode_hash = "none"`), and the dependencies are pinned submodules.

## 2. The images

```bash
export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)   # the release commit's time
git submodule update --init contracts/lib/forge-std   # the game kit's test library, in the engine image
for n in engine pagecheck; do
  docker buildx build . -f $n/Dockerfile --platform linux/amd64 --no-cache --provenance=false --sbom=false \
    --build-arg SOURCE_DATE_EPOCH --output "type=oci,dest=$n.tar,rewrite-timestamp=true"
  mkdir oci-$n && tar -xf $n.tar -C oci-$n && jq -r '.manifests[0].digest' oci-$n/index.json
done
```

Use the BuildKit version pinned in `.github/workflows/image.yml`. The digests must equal `imageDigest` and
`pagecheckDigest` in `deploy/release.json`, which the compose file pins (`image@sha256:…`). Before building from a source export, fetch the
media files the image carries (see [deploy/README.md](../deploy/README.md)).

## 3. The enclave, its keys and its records

```bash
cd engine
node scripts/verify.ts --attestation <attestationUrl from deploy/release.json> --rpc <your node> --log https://genomedna.xyz
```

It checks, printing PASS/FAIL per line:

1. a fresh nonce is in the TDX quote's report data, bound to the log head and the agent, anchor and log-signer addresses;
2. the quote verifies against Intel's PCS collateral (TCB status printed);
3. MRTD and RTMR0–2 equal the measurements in `deploy/release.json`; the event log replays to RTMR3; its compose hash is
   the released one. The compose file, parsed as YAML (merge keys resolved, duplicate keys an error), has exactly the
   services `engine`, `pagecheck` and `forge`: engine and forge on `image@imageDigest`, pagecheck on
   `pagecheckImage@pagecheckDigest` (from `deploy/release.json`), no `build` or `extends` in any service, and no top-level
   key beyond `services`, `volumes` and `networks`. Its
   `pre_launch_script` is DNA's no-op (`PRE_LAUNCH_SCRIPT` in `engine/src/proof.ts`, byte for byte), never Phala
   Cloud's default one (a registry login, a random root password, SSH keys from the unmeasured `user_config`) and never
   missing; no `init_script` or `bash_script`; keys from the KMS (`kms_enabled`, `local_key_provider_enabled` false, no
   `key_provider` other than "kms"); `allowed_envs` = the released ones. Words that set up SSH fail too, as a tripwire.
   Phala Cloud adds `features` ["kms", "tproxy-net"], `tproxy_enabled` and `local_key_provider_enabled` when it
   provisions the app; they are in `deploy/app-compose.template.json` and inside the hash like every other field.
   There is no `key_provider_id`: with it, Phala's VMM writes an MRCONFIGID v3 that the dstack-0.5.8 guest refuses at
   boot, so the hash is the same on every KMS. The KMS is named by the quote's `key-provider` event instead: it must
   carry `kmsKeyProvider` from `deploy/release.json` (the Ethereum KMS's CA public key). The guest agent sends runtime
   events without their digests; the verifiers compute each from its payload before replaying RTMR3;
4. on-chain: the DstackApp allows that compose hash; its owner is a timelock whose `getMinDelay()` is at least 3600 s
   (1 h; anything shorter fails); the timelock's full `RoleGranted` / `RoleRevoked` history leaves the Safe as the only
   proposer and canceller, execution open to anyone and no admin but the timelock itself (the RPC must serve an
   address-filtered `eth_getLogs` from block 0); an upgrade simulated from the owner reverts with "Upgrades are
   permanently disabled"; and `registry.agent()` / `anchorKey()` are the attested keys;
5. the last anchored log heads are enclave-chain records signed by the log key, and each queued op's calldata equals the
   public mapper re-run on its record.

Not checked: reproducing the dstack OS image itself, and that a provider's model wrote a given text (no provider signs
its responses).

## 4. The log

Each record's hash is `sha256(prev ‖ sha256(utf8 body))`; enclave records also carry `esig`, the log key's EIP-191
signature over `sha256("dna/log/v1" ‖ ehash ‖ sha256(canonical [kind, ref]))`. `registry.anchor(head, uri)` puts a head on
chain with a link to its record. With database access, `node scripts/verify-log.ts` recomputes the whole chain and
checks every anchored root.

## 5. A jackpot draw

```bash
node scripts/verify-draw.ts --window <n> --rpc <url1>,<url2> [--signer <log signer>]
```

Rebuilds the posted ticket list from the full DNA Transfer history and, once drawn, the winners from the VRF word. The
site's `/play/draw/<n>` runs the same checks in the browser.
