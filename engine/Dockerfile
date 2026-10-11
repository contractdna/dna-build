# DNA engine image for the Phala CVM (a TDX confidential VM). The compose file pins it by digest (image@sha256:…), and
# .github/workflows/image.yml builds it twice from one commit and checks both digests match: reproducible with the
# BuildKit version it pins (v0.33.1; image-digest.json records it). Reproducible on purpose: base images by digest,
# `npm ci` from the lockfile, the compiler by sha256, no clock in the layers (SOURCE_DATE_EPOCH + rewrite-timestamp in
# the workflow). anvil (Foundry) is the simulator's fork node; forge, solc and the game kit are the Sequencer's gates.
# Build context: the repository root (`docker buildx build -f engine/Dockerfile .`); engine/Dockerfile.dockerignore
# keeps it to the engine and the game kit.
# The one ENV beyond the base images' is SEQ_SOLC (the enclave's env lockdown, src/enclave.ts, accepts exactly this
# value); every other knob is a code default.
FROM ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7 AS foundry

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
# CA certificates: forge's HTTP client refuses to start with none loaded, even for the gates' loopback fork (G9).
# ca-certificates 20250419~deb12u1 (bookworm-security) from the same snapshot.debian.org date as the page check's
# Chromium (apt checks every package against that snapshot's signed indexes), the package's own sha256 checked here.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260926T000000Z bookworm main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260926T000000Z bookworm-updates main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260926T000000Z bookworm-security main' \
    > /etc/apt/sources.list.d/snapshot.list \
  && apt-get -o Acquire::Retries=5 update \
  && mkdir /tmp/deb && cd /tmp/deb \
  && apt-get -o Acquire::Retries=5 download ca-certificates=20250419~deb12u1 \
  && echo "62b08a77d985d4253894b1f69aebda5925034ca4e294add364167fad8cb64a44  ca-certificates_20250419~deb12u1_all.deb" | sha256sum -c - \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ./ca-certificates_20250419~deb12u1_all.deb \
  && cd / && rm -rf /tmp/deb /etc/apt/sources.list.d/snapshot.list /var/lib/apt/lists/* /var/cache/apt/* /var/log/* \
    /var/cache/ldconfig/aux-cache /var/cache/debconf/*-old /var/lib/dpkg/*-old \
  && test -s /etc/ssl/certs/ca-certificates.crt
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
# solc 0.8.26+commit.8a97fa7a, linux-amd64 (binaries.soliditylang.org/linux-amd64/list.json): the same pin as the
# Sequencer's workflows, so a game's bytes (and so its address) are the same in CI and here
ADD --checksum=sha256:d5f23436f443edb85d8e76906d12f0a86ce0490e7663a9e608efeb7a93f149ef --chmod=755 https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.26+commit.8a97fa7a /usr/local/bin/solc
ENV SEQ_SOLC=/usr/local/bin/solc
WORKDIR /app
COPY engine/package.json engine/package-lock.json ./
# npm's cache, its timestamped logs and Node's module compile cache (V8 code, differs per build) stay out of the layer
RUN NODE_DISABLE_COMPILE_CACHE=1 npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --cache /tmp/npm \
  && rm -rf /tmp/npm /tmp/node-compile-cache /root/.npm
COPY engine/src ./src
COPY engine/migrations ./migrations
COPY engine/modules ./modules
COPY engine/deployments ./deployments
# the public model registry, the brain's context (its sha256 is in every brain decision record), the tryout sets
COPY engine/models.json ./
COPY engine/brain ./brain
COPY engine/tryout ./tryout
# post media: the fact-layer font, the logo, the fallback plates, the logo MP4; attested with the image
COPY engine/media ./media
# the game kit the Sequencer gates with (src/sequencer.ts SEQ.kit): the games profile, the kit's sources, the conformance
# suite and forge-std (the submodule at contracts/foundry.lock's revision). A game's pull request can change none of it.
COPY contracts/games/foundry.toml ./contracts/games/foundry.toml
COPY contracts/src/games/GameKit.sol contracts/src/games/IGames.sol contracts/src/games/GameFactory.sol contracts/src/games/GameFunder.sol ./contracts/src/games/
COPY contracts/test/games/GameKitConformance.sol ./contracts/test/games/
# and the module kit: the modules profile, the policy interfaces, the module conformance suite
COPY contracts/modules/foundry.toml ./contracts/modules/foundry.toml
COPY contracts/src/interfaces/IPolicies.sol ./contracts/src/interfaces/
COPY contracts/test/modules/ModuleConformance.sol ./contracts/test/modules/
COPY contracts/lib/forge-std/src ./contracts/lib/forge-std/src
# the CVM's encrypted data disk is mounted at /data/dna (the boot check's head file); /work is the volume the engine
# shares with the forge container (the gates' workspaces and jobs); both owned by the runtime user. The forge container
# runs as `forge` (uid 1001, the node group 1000: the compose's `user`): a uid of its own, so its process limit
# (src/limited.ts LIMITS.nproc) counts only its own threads; the group, so it shares /work (src/limited.ts sets the
# umask both sides write with).
RUN mkdir -p /data/dna /work && chown node:node /data/dna /work \
  && echo 'forge:x:1001:1000::/tmp:/usr/sbin/nologin' >> /etc/passwd
USER node
EXPOSE 8080
CMD ["node", "src/engine.ts"]
