import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import type { User } from "../../types/entities";
import {
  MESSAGE_KINDS, MESSAGE_PRESENTATIONS, createUserMessage, ensureActivationExpiryMessage,
  ensureOfficialMessages, ensureUserMessagesSchema, listUserMessages,
  type MessageKind, type MessagePresentation,
} from "../../utils/messages";

export const messagesRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

messagesRoutes.get("/messages", async (c) => {
  const user = c.get("user");
  await ensureActivationExpiryMessage(c.env, user);
  await ensureOfficialMessages(c.env, user, c.req.url);
  const allMessages = await listUserMessages(c.env, user.username);
  const officialMessages = user.level >= 3 ? allMessages.filter((message) => message.source === "official") : [];
  const messages = allMessages.filter((message) => message.source !== "official");
  return c.json({ ok: true, messages, officialMessages, unreadCount: allMessages.filter((message) => !message.readAt).length });
});

messagesRoutes.post("/messages/read", async (c) => {
  const body = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));
  if (!body.id) return c.json({ ok: false, error: "Missing message id" }, 400);
  const user = c.get("user");
  await ensureUserMessagesSchema(c.env);
  await c.env.DB.prepare(
    "UPDATE user_messages SET read_at = COALESCE(read_at, ?) WHERE id = ? AND username = ?",
  ).bind(Math.floor(Date.now() / 1000), body.id, user.username).run();
  return c.json({ ok: true });
});

messagesRoutes.post("/messages/dismiss", async (c) => {
  const body = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));
  if (!body.id) return c.json({ ok: false, error: "Missing message id" }, 400);
  const user = c.get("user");
  await ensureUserMessagesSchema(c.env);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    "UPDATE user_messages SET dismissed_at = COALESCE(dismissed_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ? AND username = ?",
  ).bind(now, now, body.id, user.username).run();
  return c.json({ ok: true });
});

messagesRoutes.post("/messages/send", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{
    username?: string; title?: string; message?: string; kind?: MessageKind; presentation?: MessagePresentation;
  }>().catch(() => ({} as {
    username?: string; title?: string; message?: string; kind?: MessageKind; presentation?: MessagePresentation;
  }));
  const username = body.username?.trim();
  const title = body.title?.trim();
  const message = body.message?.trim();
  const kind = body.kind || "info";
  const presentation = body.presentation || "inbox";
  if (!username || !title || !message) return c.json({ ok: false, error: "username, title and message are required" }, 400);
  if (title.length > 200 || message.length > 4000) return c.json({ ok: false, error: "Message is too long" }, 400);
  if (!MESSAGE_KINDS.includes(kind) || !MESSAGE_PRESENTATIONS.includes(presentation)) {
    return c.json({ ok: false, error: "Invalid kind or presentation" }, 400);
  }
  const target = await c.env.DB.prepare("SELECT username, level FROM users WHERE username = ?")
    .bind(username).first<{ username: string; level: number }>();
  if (!target) return c.json({ ok: false, error: "User not found" }, 404);
  if (c.get("user").level < 3 && target.level >= 2) {
    return c.json({ ok: false, error: "Only a super administrator can message administrators" }, 403);
  }
  await createUserMessage(c.env, { username, source: "admin", kind, presentation, title, body: message });
  return c.json({ ok: true });
});
