// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { createQueries } from "../../db/queries";

export const albumDisplayGroupRoutes = new Hono<{ Bindings: Env }>();

albumDisplayGroupRoutes.get("/album-display-groups", permissionMiddleware("browse"), async (c) => {
  const groups = await createQueries(c.env.DB).listAlbumDisplayGroups();
  return c.json({
    ok: true,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.display_name,
      memberAlbumIds: group.member_album_ids,
      memberCount: group.member_count,
    })),
  });
});

albumDisplayGroupRoutes.get("/album-display-groups/:id", permissionMiddleware("browse"), async (c) => {
  const group = await createQueries(c.env.DB).getAlbumDisplayGroup(c.req.param("id"));
  if (!group) return c.json({ ok: false, error: "Display group not found" }, 404);
  return c.json({
    ok: true,
    group: {
      id: group.id,
      name: group.display_name,
      editions: group.members.map((album) => ({
        id: album.id,
        name: album.name,
        artist: album.artist_name ?? "",
        year: album.year === null ? "" : String(album.year),
        coverArt: album.cover_r2_key ? album.id : "",
        songCount: String(album.song_count),
        starred: false,
        createdAt: String(album.created_at),
      })),
    },
  });
});
