FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/controller ./cmd/controller \
 && CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/collector  ./cmd/collector

FROM gcr.io/distroless/static
COPY --from=build /out/controller /controller
COPY --from=build /out/collector  /collector
EXPOSE 8080
ENTRYPOINT ["/controller"]
