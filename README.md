# splatbox

Self-hosted gallery and manager for Gaussian splats (`.ply`, `.sog`, `.spz`, `.splat`, `.ksplat`),
with a WebXR viewer that runs in the Quest 3 browser. One container, one `/data` volume, no external services.

- **Gallery / manage UI** in any browser: create collections, upload, delete, rescan.
- **Viewer + VR mode** (Quest controls: grip to grab, thumbsticks to rotate/move, scale), served by the app itself.
- Per-collection `manifest.json` (browser-sharp manifest v1) at `/files/collections/<id>/manifest.json`.

The viewer is derived from [browser-sharp](https://github.com/michael-mueller-git/browser-sharp) (`quest3` branch), with the Supabase/remote storage replaced by the built-in server.

## Run

```bash
docker run -d -p 8080:8080 -v splatbox-data:/data ghcr.io/isabellas-agent/splatbox:edge
```

Open `http://localhost:8080`, use **Create a collection**, then upload files into it.
WebXR only works on secure origins: terminate TLS at your ingress/proxy (the container serves plain HTTP).
Make sure the proxy allows large request bodies (uploads are streamed) and passes `Range` requests.

## Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `/data` | Collections live in `$DATA_DIR/collections/<id>/{manifest.json,assets/}` |
| `MAX_UPLOAD_GB` | `4` | Max size of one uploaded file |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | unset | Set **both** to require HTTP Basic auth. `/api/health` stays open |
| `BASIC_AUTH_READONLY` | `false` | With auth enabled: viewing (GET/HEAD) stays open, only writes need credentials |

## Development

```bash
cd server && npm ci && npm test           # API tests
cd web && npm ci && npm run build         # builds web/dist
cd server && DATA_DIR=../data WEB_DIR=../web/dist npm start
```

## API

`GET/POST /api/collections`, `PATCH/DELETE /api/collections/:id`,
`PUT /api/collections/:id/assets/:filename` (raw body, `application/octet-stream`),
`DELETE /api/collections/:id/assets` (`{"paths": [...]}`), `POST /api/collections/:id/rescan?apply=1`,
`GET /api/health`.

## License

MIT
