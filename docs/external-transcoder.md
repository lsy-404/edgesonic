# External transcoder deployment

The optional external transcoder accepts audio from the EdgeSonic Worker and returns a streamed transcoded response. It is not a general-purpose public API.

Set a high-entropy `SHARED_KEY` in both the Worker secret `external_transcoder_key` and the container environment. Every endpoint, including `GET /health`, requires it in `X-EdgeSonic-Container-Key`; the Worker supplies the header for normal transcode and health calls.

The image listens on `HOST` and `PORT` (defaults: `0.0.0.0:8080`) because the Worker must be able to reach the selected external endpoint. Docker `EXPOSE 8080` documents this container port only; it does not publish it. Choose one of these deployment-specific controls:

- Keep the service on a private network and expose it only through an authenticated ingress reachable by the Worker.
- If a public HTTPS endpoint is necessary, restrict ingress with the platform firewall, rate limits, and the shared-key check. Do not publish a raw host port without those controls.
- Set `HOST=127.0.0.1` only when a local reverse proxy terminates and forwards the Worker traffic on the same host or network namespace.

Do not configure an unauthenticated platform health probe against `/health`. Use an authenticated probe, a platform-native process check, or an internal proxy health check that attaches the shared key.
