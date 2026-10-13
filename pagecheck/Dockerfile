# The page check (pagecheck/: G15) for the Phala CVM, beside the engine in the same compose (deploy/: an internal network
# only the engine shares, no environment, no dstack socket, read-only but /tmp). It builds and runs pages an AI wrote, so
# it holds nothing worth taking. Reproducible like the engine's image (.github/workflows/image.yml builds it twice and
# compares digests): base images by digest; Debian's Chromium from a fixed snapshot.debian.org date (apt checks every
# package against that snapshot's signed indexes) with the chromium package's own sha256 checked here; npm ci from the
# lockfiles; no clock in the layers. Playwright drives this Chromium; it downloads no browser.
# Build context: the repository root (`docker buildx build -f pagecheck/Dockerfile .`); pagecheck/Dockerfile.dockerignore
# keeps it to web/ (the app the check builds) and pagecheck/.
FROM ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7 AS foundry

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
# Chromium 154.0.8037.57-1~deb12u1 (bookworm-security), as the archive was on 2026-09-26. dbus writes a random machine
# id when installed: it ships empty, as in systemd images (a fresh one per boot), so the layer is the same every build.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260926T000000Z bookworm main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260926T000000Z bookworm-updates main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260926T000000Z bookworm-security main' \
    > /etc/apt/sources.list.d/snapshot.list \
  && apt-get -o Acquire::Retries=5 update \
  && mkdir /tmp/deb && cd /tmp/deb \
  && apt-get -o Acquire::Retries=5 download chromium=154.0.8037.57-1~deb12u1 \
  && echo "ae8b1623e059d6a5469d0cc738e8923310ba17f8649fa2f7eef9ce5f78b5b016  chromium_154.0.8037.57-1~deb12u1_amd64.deb" | sha256sum -c - \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ./chromium_154.0.8037.57-1~deb12u1_amd64.deb \
  && cd / && rm -rf /tmp/deb /etc/apt/sources.list.d/snapshot.list /var/lib/apt/lists/* /var/cache/apt/* /var/log/* \
    /var/cache/ldconfig/aux-cache /var/cache/fontconfig /var/cache/debconf/*-old /var/lib/dpkg/*-old /var/lib/dbus/machine-id \
  && : > /etc/machine-id \
  && /usr/bin/chromium --version
# anvil loads the engine's state dump (it never forks: there is no network to fork)
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
WORKDIR /app
# the web app the check builds a copy of for each check (dev dependencies too: the build type-checks)
COPY web/package.json web/package-lock.json ./web/
RUN cd web && NODE_DISABLE_COMPILE_CACHE=1 npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier --cache /tmp/npm \
  && rm -rf /tmp/npm /tmp/node-compile-cache /root/.npm
# Next's swc and sharp's native binaries load from here, on the image's read-only filesystem: a check's copy of the web
# app lives on /tmp, a noexec tmpfs, and leaves them out (pagecheck/src/site.ts), so Node walks up from it to these
RUN mkdir /node_modules && ln -s /app/web/node_modules/@next /node_modules/@next && ln -s /app/web/node_modules/@img /node_modules/@img
COPY web ./web
COPY pagecheck/package.json pagecheck/package-lock.json ./pagecheck/
RUN cd pagecheck && NODE_DISABLE_COMPILE_CACHE=1 npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --cache /tmp/npm \
  && rm -rf /tmp/npm /tmp/node-compile-cache /root/.npm
COPY pagecheck/src ./pagecheck/src
# its own uid (not the engine's 1000 or the forge container's 1001): a process limit counts every thread of a uid
# across containers, and Chromium's threads must not count against the gates' forge
RUN echo 'pagecheck:x:1002:1002::/tmp:/usr/sbin/nologin' >> /etc/passwd && echo 'pagecheck:x:1002:' >> /etc/group
USER 1002:1002
EXPOSE 8090
CMD ["node", "pagecheck/src/server.ts"]
