FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
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
