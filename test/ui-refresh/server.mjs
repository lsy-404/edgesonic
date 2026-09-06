import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dependencyRoot = dirname(await realpath(`${root}node_modules`));
const albums = [
  ["a1", "Night Signals", "Glass Harbour", "#2c5568", "#b3cd9a"],
  ["a2", "Soft Current", "Low Tide", "#ab6549", "#edd6aa"],
  ["a3", "Quiet Geometry", "Open Field", "#6a5a86", "#e7b9aa"],
  ["a4", "Blue Hour", "Glass Harbour", "#163e67", "#9caac2"],
  ["a5", "Parallel Lines", "Static Bloom", "#476a4c", "#d2daa9"],
  ["a6", "After the Rain", "Low Tide", "#756254", "#e9c6a6"],
].map(([id, name, artist, background, foreground], i) => ({
  id,
  name,
  artist,
  artistId: `r${(i % 3) + 1}`,
  coverArt: id,
  songCount: "4",
  year: "2026",
  duration: "240",
  created: "2026-09-05T18:00:00Z",
  background,
  foreground,
}));
const songs = albums.flatMap((album) =>
  Array.from({ length: 4 }, (_, i) => ({
    id: `${album.id}s${i + 1}`,
    title: [
      "First Light",
      "Slow Motion",
      "A Place to Stay",
      "Under the Same Sky",
    ][i],
    artist: album.artist,
    album: album.name,
    albumId: album.id,
    artistId: album.artistId,
    coverArt: album.id,
    duration: "60",
    contentType: "audio/wav",
    suffix: "wav",
    size: "960044",
    isDir: "false",
    created: album.created,
    ...(i === 0 ? { starred: album.created } : {}),
  })),
);
const permissions = Object.fromEntries(
  [
    "manage_files",
    "manage_sources",
    "manage_users",
    "manage_settings",
    "manage_tags",
    "stream",
    "download",
    "create_share",
    "create_playlist",
    "access_subsonic",
  ].map((key) => [key, true]),
);
const events = [];
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );
const attrs = (value) =>
  Object.entries(value)
    .filter(([key]) => !["background", "foreground"].includes(key))
    .map(([key, value]) => `${key}="${escape(value)}"`)
    .join(" ");
const nodes = (tag, values) =>
  values.map((value) => `<${tag} ${attrs(value)} />`).join("");
const xml = (body = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><subsonic-response status="ok" version="1.16.1">${body}</subsonic-response>`;
const playlist = {
  id: "p1",
  name: "Evening listening",
  owner: "preview",
  songCount: "4",
  duration: "240",
  public: "false",
  coverArt: "a1",
  created: "2026-09-01T00:00:00Z",
  changed: "2026-09-06T00:00:00Z",
};
const audio = Buffer.alloc(44 + 60 * 8000 * 2);
audio.write("RIFF");
audio.writeUInt32LE(audio.length - 8, 4);
audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24);
audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write("data", 36);
audio.writeUInt32LE(audio.length - 44, 40);

function send(response, body, type = "application/json", status = 200) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  response.end(
    typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body),
  );
}

const server = await createServer({
  configFile: `${root}web/vite.config.ts`,
  root: `${root}web`,
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    fs: {
      allow: [
        root,
        dependencyRoot,
      ],
    },
  },
  plugins: [
    {
      name: "ui-fixture",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          const bootstrap = `
          const scenario = new URLSearchParams(location.search).get('scenario') || 'normal';
          const role = scenario === 'guest' ? 0 : 3;
          if (scenario === 'login') localStorage.removeItem('edgesonic_logged_in');
          else localStorage.setItem('edgesonic_logged_in', '1');
          localStorage.setItem('edgesonic_user', 'preview');
          localStorage.setItem('edgesonic_level', String(role));
          localStorage.setItem('edgesonic_nickname', 'Preview library');
          localStorage.setItem('edgesonic_lang', new URLSearchParams(location.search).get('lang') || 'zh-CN');
          localStorage.setItem('edgesonic_theme', new URLSearchParams(location.search).get('theme') || 'black');
          localStorage.setItem('edgesonic_perms', JSON.stringify(role ? ${JSON.stringify(permissions)} : {stream:true}));
          localStorage.removeItem('edgesonic_activation');
          localStorage.setItem('participate_work', 'false');
          const report = (kind, message) => fetch('/__fixture/events', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,message,scenario,href:location.href})});
          addEventListener('error', e => report('error', e.message));
          addEventListener('unhandledrejection', e => report('rejection', String(e.reason)));
        `;
          return html.replace(
            '<script type="module"',
            `<script>${bootstrap}</script><script type="module"`,
          );
        },
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url, "http://127.0.0.1:5199");
          const referrer = new URL(request.headers.referer || url.href);
          const scenario = referrer.searchParams.get("scenario") || "normal";
          const endpoint = url.pathname.split("/").pop();
          if (url.pathname === "/__fixture/events") {
            if (request.method === "POST") {
              let body = "";
              for await (const chunk of request) body += chunk;
              events.push(JSON.parse(body));
            }
            return send(response, events);
          }
          if (url.pathname === "/__fixture/mobile") {
            const query = url.search;
            return send(
              response,
              `<!doctype html><meta charset="utf-8"><title>Mobile UI verification</title><style>body{margin:0;background:#202020;display:grid;place-content:center;min-height:100vh}iframe{width:390px;height:844px;max-height:96vh;border:1px solid #777;border-radius:8px}</style><iframe title="EdgeSonic mobile preview" src="/${query}"></iframe>`,
              "text/html",
            );
          }
          if (!/^\/(rest|edgesonic|storage|tag)\//.test(url.pathname))
            return next();
          if (!/getCoverArt|stream/.test(endpoint))
            events.push({
              kind: "request",
              path: url.pathname,
              query: Object.fromEntries(url.searchParams),
              scenario,
            });
          if (url.pathname === "/edgesonic/auth/me")
            return send(response, {
              ok: true,
              level: scenario === "guest" ? 0 : 3,
              nickname: "Preview library",
              permissions:
                scenario === "guest" ? { stream: true } : permissions,
            });
          if (url.pathname === "/edgesonic/messages")
            return send(response, {
              ok: true,
              messages: [],
              officialMessages: [],
            });
          if (url.pathname === "/edgesonic/version")
            return send(response, { ok: true, version: "1.4.0" });
          if (url.pathname === "/edgesonic/features")
            return send(response, { ok: true, features: {} });
          if (url.pathname.startsWith("/edgesonic/auth/"))
            return send(response, {
              ok: true,
              sessions: [],
              guestEnabled: true,
              registrationEnabled: false,
            });
          if (endpoint === "getCoverArt") {
            const album =
              albums.find((item) => item.id === url.searchParams.get("id")) ||
              albums[0];
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480"><rect width="480" height="480" fill="${album.background}"/><circle cx="300" cy="210" r="138" fill="none" stroke="${album.foreground}" stroke-width="1"/><circle cx="300" cy="210" r="105" fill="none" stroke="${album.foreground}" stroke-width="28" opacity=".65"/><path d="M-40 335L460 95M-40 383L500 122" stroke="${album.foreground}" stroke-width="12" opacity=".5"/><text x="28" y="401" fill="${album.foreground}" font-family="sans-serif" font-size="28">${escape(album.name)}</text><text x="29" y="440" fill="${album.foreground}" font-family="sans-serif" font-size="14" letter-spacing="3">${escape(album.artist.toUpperCase())}</text></svg>`;
            return send(response, svg, "image/svg+xml");
          }
          if (endpoint === "stream") {
            const start = Number(
              request.headers.range?.match(/bytes=(\d+)/)?.[1] || 0,
            );
            response.writeHead(206, {
              "Content-Type": "audio/wav",
              "Accept-Ranges": "bytes",
              "Content-Range": `bytes ${start}-${audio.length - 1}/${audio.length}`,
              "Content-Length": audio.length - start,
            });
            return response.end(audio.subarray(start));
          }
          if (endpoint === "getAlbumList2") {
            const type = url.searchParams.get("type");
            if (
              scenario === "error" ||
              (scenario === "partial" && type === "frequent")
            )
              return send(
                response,
                xml().replace('status="ok"', 'status="failed"'),
                "application/xml",
                500,
              );
            const values =
              scenario === "empty"
                ? []
                : type === "frequent"
                  ? [albums[2], albums[0], albums[4]]
                  : type === "recent"
                    ? [albums[1], albums[3]]
                    : albums;
            return send(
              response,
              xml(`<albumList2>${nodes("album", values)}</albumList2>`),
              "application/xml",
            );
          }
          if (endpoint === "getAlbum") {
            const album = albums.find(
              (item) => item.id === url.searchParams.get("id"),
            );
            return send(
              response,
              xml(
                album
                  ? `<album ${attrs(album)}>${nodes(
                      "song",
                      songs.filter((song) => song.albumId === album.id),
                    )}</album>`
                  : "",
              ),
              "application/xml",
            );
          }
          if (endpoint === "getSong")
            return send(
              response,
              xml(
                nodes(
                  "song",
                  songs.filter(
                    (song) => song.id === url.searchParams.get("id"),
                  ),
                ),
              ),
              "application/xml",
            );
          if (endpoint === "getArtists")
            return send(
              response,
              xml(
                `<artists><index name="G">${nodes(
                  "artist",
                  albums
                    .slice(0, 3)
                    .map((album) => ({
                      id: album.artistId,
                      name: album.artist,
                      albumCount: "2",
                    })),
                )}</index></artists>`,
              ),
              "application/xml",
            );
          if (endpoint === "getArtist")
            return send(
              response,
              xml(
                `<artist id="r1" name="Glass Harbour" albumCount="2">${nodes(
                  "album",
                  albums.filter(
                    (album) => album.artistId === url.searchParams.get("id"),
                  ),
                )}</artist>`,
              ),
              "application/xml",
            );
          if (endpoint === "getArtistInfo")
            return send(
              response,
              xml(
                "<artistInfo><biography>Instrumental music for slow evenings.</biography></artistInfo>",
              ),
              "application/xml",
            );
          if (endpoint === "search3") {
            const query = (url.searchParams.get("query") || "").toLowerCase();
            const values = songs.filter(
              (song) =>
                !query ||
                `${song.title} ${song.album} ${song.artist}`
                  .toLowerCase()
                  .includes(query),
            );
            return send(
              response,
              xml(`<searchResult3>${nodes("song", values)}</searchResult3>`),
              "application/xml",
            );
          }
          if (endpoint === "getStarred2")
            return send(
              response,
              xml(
                `<starred2>${nodes(
                  "song",
                  songs.filter((song) => song.starred),
                )}</starred2>`,
              ),
              "application/xml",
            );
          if (endpoint === "getPlaylists")
            return send(
              response,
              xml(`<playlists>${nodes("playlist", [playlist])}</playlists>`),
              "application/xml",
            );
          if (endpoint === "getPlaylist")
            return send(
              response,
              xml(
                `<playlist ${attrs(playlist)}>${nodes("entry", songs.slice(0, 4))}</playlist>`,
              ),
              "application/xml",
            );
          if (endpoint === "getLyricsBySongId")
            return send(
              response,
              xml(
                '<lyricsList><structuredLyrics lang="en" synced="true"><line start="0">Let the evening settle in</line><line start="15000">A quiet moment in the sound</line><line start="30000">Follow where the light begins</line></structuredLyrics></lyricsList>',
              ),
              "application/xml",
            );
          if (url.pathname.startsWith("/rest/"))
            return send(response, xml(), "application/xml");
          return send(response, {
            ok: true,
            artists: 3,
            albums: 6,
            songs: 24,
            sources: [],
            users: [],
            tasks: [],
            breakdown: [],
            items: [],
          });
        });
      },
    },
  ],
});
await server.listen();
console.log("UI verification: http://127.0.0.1:5199/ and /__fixture/mobile");
process.on("SIGINT", () => {
  void server.close();
});
