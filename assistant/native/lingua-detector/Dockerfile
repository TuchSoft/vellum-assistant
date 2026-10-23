# Build the lingua napi addon for linux/arm64.
#   docker build --platform linux/arm64 -t ws27-lingua -f assistant/native/lingua-detector/Dockerfile assistant/native/lingua-detector
# The output is copied out with `docker create` + `docker cp` (see build.sh).
FROM rust:1.97-slim-bookworm AS build

WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src

RUN --mount=type=cache,target=/usr/local/cargo/registry,id=cargo-registry \
    --mount=type=cache,target=/build/target,id=lingua-target \
    cargo build --release --locked \
    && cp target/release/liblingua_detector.so /tmp/lingua_detector.node

FROM scratch
COPY --from=build /tmp/lingua_detector.node /lingua_detector.node
CMD ["/lingua_detector.node"]
