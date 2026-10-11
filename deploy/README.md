# deploy

The engine's enclave deployment on a Phala CVM (Intel TDX) and the release record the verifiers pin.

| File | What |
|---|---|
| `docker-compose.template.yml` | The CVM's compose. `{{NAME}}` = a literal filled at render time (part of the compose hash); `${NAME}` = an allowed env the operator sets encrypted at runtime (not part of the hash) |
| `app-compose.template.json` | dstack's app-compose wrapper: `allowed_envs` (= `engine/src/enclave.ts` `ALLOWED_ENVS`), KMS and gateway settings, the fields Phala Cloud adds when it provisions (`features`, `tproxy_enabled`, `local_key_provider_enabled`) and DNA's no-op `pre_launch_script`; no `key_provider` / `key_provider_id` (a dstack-0.5.8 guest refuses the MRCONFIGID v3 they bring) |
| `compose.params.example.json` | The render inputs: commit, the two images + digests, the compose literals (the Sequencer's repository and bot among them) |
| `release.json` | What verifiers pin: image digest, compose hash, DstackApp, measurements, log signer. `kmsAuth` is Phala's public KmsAuth contract on Ethereum. Mirrored at `web/app/proof/release.json` |

## Release flow

1. Tag a commit; `.github/workflows/image.yml` builds the engine image and the page check's image twice each and
   records the matching digests (`engine-image-digest.json`, `pagecheck-image-digest.json`). The compose runs three
   containers: the engine; `pagecheck` (game pages in Chromium, on an internal network only the engine shares); and
   `forge` (the engine's own image running the gates' forge and anvil with no network at all, through a shared volume).
   Only the engine has an environment and the dstack socket.
2. `node engine/scripts/compose.ts <params.json>` renders `deploy/app-compose.json` (exactly the bytes whose sha256 is
   the compose hash) and updates `release.json`. It refuses unfilled literals, an image not pinned by digest,
   `allowed_envs` that differ from the engine's, and any pre-launch script but ours: left out, Phala Cloud would put in
   its own (a registry login, a root password, SSH keys from the unmeasured user config). With Phala's fields in the
   template, the hash is the one Phala computes; check that it equals Phala's before the allow-list step.
3. Allow-list. The DstackApp's owner is an OpenZeppelin `TimelockController` with `minDelay` 1 h (3600 s): proposer
   and canceller the Safe, executor anyone, admin role renounced.
   - First release: the compose hash is allowed when the DstackApp is created, in one transaction on Phala's KmsAuth:
     `deployAndRegisterApp(address initialOwner, bool disableUpgrades, bool requireTcbUpToDate, bool allowAnyDevice,
     bytes32 initialDeviceId, bytes32 initialComposeHash)` (selector `0x9cb9c31f`) with the timelock as
     `initialOwner`, `disableUpgrades = true`, `requireTcbUpToDate = false` (the verifiers accept `UpToDate` and
     `SWHardeningNeeded`), `allowAnyDevice = false`, the first machine's device id and the compose hash. It deploys a
     proxy initialised by `DstackApp.initialize(address,bool,bool,bool,bytes32,bytes32)` (`0x9ed28193`) with the same
     six values, which emits `ComposeHashAdded` and `DeviceAdded`; no other account ever owns the app. (The older
     five-argument overload, `0x8618169d`, is the same call with `requireTcbUpToDate = false`.)
   - Every later change: the Safe proposes `addComposeHash(new)` + `removeComposeHash(old)` as one timelock batch; it
     takes effect after 1 h, in public. Exactly one hash is allowed at a time.
   - Machines: `addDevice` / `removeDevice` go through the same 1 h timelock (a device cannot change the code).
4. Deploy the CVM with that compose; the operator sets the allowed envs encrypted to the CVM, including the signers'
   Telegram group and user ids (`TELEGRAM_GROUP_ID`, `TELEGRAM_ALLOWED_USER_IDS`): they are private, so they are never
   compose literals and never appear in `app-compose.json` or `release.json` (the publish scan refuses them there).
   `GITHUB_TOKEN` is the Sequencer's fine-grained personal access token (the project account): this repository only;
   Contents read/write, Pull requests read/write, Commit statuses read/write, Actions read, Metadata read; nothing else;
   at most one year (the engine warns 14 days before it expires).
5. First deploy, before anything runs: check the containers are isolated as the compose says.
   - `docker inspect -f '{{.HostConfig.NetworkMode}}' <forge container>` prints `none`.
   - `docker inspect -f '{{json .NetworkSettings.Networks}}' <pagecheck container>` lists only the `checks` network,
     and that network is internal (`docker network inspect -f '{{.Internal}}' <project>_checks` prints `true`).
   - Each runs as its own uid (`docker exec <container> id -u`: engine 1000, forge 1001, pagecheck 1002): a process
     limit counts every thread of a uid across containers, so Chromium's threads can't fail the gates' forge. forge
     keeps the engine's group (1000) to share the work volume.
   - Neither container has an environment beyond the image's (`docker inspect -f '{{.Config.Env}}'`) or a dstack
     socket mount (`docker inspect -f '{{json .Mounts}}'`).

Nothing here deploys by itself. Changing the Dockerfile, a media file or any compose literal changes the image digest
or the compose hash and therefore needs a new allow-list entry.

## Media in the image

The image carries post media from `engine/media/` (the fact-layer font, the logo, the fallback plates, the logo video).
The large binaries (the logo video, the plates, the studio's style references) are not source files: they are
release assets pinned by sha256 in `engine/media/release.sha256`, fetched and verified before a build or a test run:

```bash
engine/scripts/fetch-media.sh        # downloads missing files, verifies every hash; npm test runs it first
```

`MEDIA_BASE_URL` (default: the `media-v1` release of the public repository `contractdna/dna-contracts`) is where the
assets live; an asset is named by its path under `engine/media/` with `/` replaced by `_` (`plates/placeholder-01.jpg`
→ `plates_placeholder-01.jpg`).
A new media set is a new release tag, a new pin list and a new image digest. The binaries are gitignored (they are not
source): where media is kept in git, a new file needs `git add -f`; in the public repository it goes to the release.

The image digest commits to the exact bytes, so a rebuilt image only matches when every file matches its hash.

## Publish checklist

- [ ] Create the release `media-v1` on the public repository with the 31 assets of `engine/media/release.sha256`
  (named path with `/` → `_`) **before enabling CI**: `npm test`, the e2e and enclave jobs and `image.yml` fetch them.
