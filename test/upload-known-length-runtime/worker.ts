import { Hono } from "hono";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";

export interface Env {
  TEST_BUCKET: R2Bucket;
}

function database() {
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...next: unknown[]) { args = next; return this; },
      async first() {
        if (sql.includes("FROM feature_strings") && args[0] === "worker_pool_enabled") return { value: "0" };
        if (sql.includes("FROM user_permissions")) return { enabled: 1, max_rph: 0 };
        return null;
      },
      async all() { return { results: [], success: true, meta: {} }; },
      async run() { return { success: true, meta: { changes: 1 } }; },
    };
  };
  return {
    prepare: statement,
    async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map((item) => item.run())); },
  };
}

const app = new Hono<{ Bindings: Env; Variables: { user: { username: string; level: number } } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "runtime-test", level: 3 });
  return next();
});
app.route("/storage", filesRoutes);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/__head") {
      const object = await env.TEST_BUCKET.head("music/success.mp3");
      return Response.json({ size: object?.size ?? null });
    }
    if (new URL(request.url).pathname === "/__mismatch") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close(); },
      });
      return app.fetch(new Request("http://runtime/storage/files/upload?source=r2&name=mismatch.mp3", {
        method: "POST",
        headers: { "Content-Length": "3", "Content-Type": "audio/mpeg" },
        body,
      }), { ...env, MUSIC_BUCKET: env.TEST_BUCKET, DB: database() } as Env, ctx);
    }
    return app.fetch(request, { ...env, MUSIC_BUCKET: env.TEST_BUCKET, DB: database() } as Env, ctx);
  },
};
