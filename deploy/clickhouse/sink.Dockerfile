# Builds the request-log collector and the deriver from clickhouse-sink at a
# pinned commit plus our reviewed clickhouse-sink.patch, with pinned images.
# Both run outside the proxy; the proxy only loads claudex-tap.
FROM golang:1.26-bookworm@sha256:29f741a2adcfacecf72c6f1f8275fad87a33d4080a459b71dffebf1b324abd8b AS build
ADD https://github.com/api-token/Cli-Proxy-API-Management-Center.git#68c9bb8c701f2ed229e989a07f6d1ef1ec79da7a /src
COPY clickhouse-sink.patch /tmp/
WORKDIR /src
RUN git apply /tmp/clickhouse-sink.patch
WORKDIR /src/plugins/clickhouse-sink
RUN CGO_ENABLED=0 go build -tags collector -trimpath -ldflags="-s -w" -o /out/collector . \
 && cd deriver && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/deriver .

# The debug variant adds busybox, used only to read the password file.
FROM gcr.io/distroless/static-debian12:debug-nonroot@sha256:d5563cc7f2f44313f332e91138cc8c6a158899afeeeab2fce3b0f9ccdb3cf9ee
COPY --from=build /out/collector /out/deriver /
