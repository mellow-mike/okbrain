FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
RUN bun build --compile --outfile /okbrain-worker src/core/coding/project-worker.ts

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /okbrain-worker /usr/local/bin/okbrain-worker
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/okbrain-worker"]
