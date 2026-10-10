import { Hono } from "hono";
import { browseRoutes } from "../../worker/src/endpoints/storage/browse";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";

declare global { type D1Database = unknown; type Env = unknown; }

type Entry = {
  id: string;
  source_id: string;
  path: string;
  display_name: string;
  kind: "folder" | "file";
  parent_id: string | null;
  object_id: string | null;
  instance_id: string | null;
  companion_of: string | null;
};
type Instance = { id: string; master_id: string; storage_object_id: string | null; missing: number; storage_uri?: string; source_id?: string };
type ObjectRow = { id: string; physical_key: string };
type Master = { id: string; album_id: string; artist_id: string };

let failures = 0;
function assert(value: unknown, message: string) {
  if (value) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function makeFixture(options: {
  entries: Entry[];
  instances: Instance[];
  objects: ObjectRow[];
  masters: Master[];
  level?: number;
  bucketDeleteFailure?: boolean;
  bucketDeleteFailsOnCall?: number;
}) {
  const entries = options.entries;
  const instances = options.instances;
  const objects = options.objects;
  const masters = options.masters;
  const bucketKeys = new Set(objects.map((row) => row.physical_key));
  let locationReads = 0;
  let bucketDeleteFailure = !!options.bucketDeleteFailure;
  let bucketDeleteCalls = 0;
  const db = {
    prepare(sql: string) {
      const query = sql.trim().replace(/\s+/g, " ");
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first<T = unknown>() {
          if (query.includes("WHERE e.source_id = ? AND e.path = ?")) {
            const row = entries.find((item) => item.source_id === statement.args[0] && item.path === statement.args[1]);
            if (!row) return null;
            const object = objects.find((item) => item.id === row.object_id);
            return { ...row, physical_key: object?.physical_key ?? null, object_suffix: "mp3", object_content_type: "audio/mpeg", object_size: 123 } as T;
          }
          if (query.includes("SELECT master_id, storage_object_id FROM song_instances WHERE id = ?")) {
            const row = instances.find((item) => item.id === statement.args[0]);
            return row ? { master_id: row.master_id, storage_object_id: row.storage_object_id } as T : null;
          }
          if (query.includes("SELECT COUNT(*) AS n FROM storage_entries WHERE instance_id = ?")) {
            return { n: entries.filter((item) => item.instance_id === statement.args[0]).length } as T;
          }
          if (query.includes("SELECT COUNT(*) AS n FROM storage_entries WHERE object_id = ?")) {
            return { n: entries.filter((item) => item.object_id === statement.args[0]).length } as T;
          }
          if (query.includes("SELECT COUNT(*) AS n FROM song_instances WHERE master_id = ?")) {
            return { n: instances.filter((item) => item.master_id === statement.args[0]).length } as T;
          }
          if (query.includes("SELECT album_id, artist_id FROM song_masters WHERE id = ?")) {
            const row = masters.find((item) => item.id === statement.args[0]);
            return row ? { album_id: row.album_id, artist_id: row.artist_id } as T : null;
          }
          if (query.includes("AS entry_refs") && query.includes("AS instance_refs")) {
            const objectId = statement.args[0];
            return {
              entry_refs: entries.filter((item) => item.object_id === objectId).length,
              instance_refs: instances.filter((item) => item.storage_object_id === objectId).length,
            } as T;
          }
          return null;
        },
        async all<T = unknown>() {
          if (query.includes("si.id AS instance_id") && query.includes("FROM song_instances si")) {
            locationReads++;
            return { results: instances.flatMap((instance) => instance.master_id === statement.args[0]
              ? (entries.filter((entry) => entry.instance_id === instance.id && entry.kind === "file").length
                ? entries.filter((entry) => entry.instance_id === instance.id && entry.kind === "file").map((entry) => ({
                instance_id: instance.id,
                storage_uri: instance.storage_uri || `r2://${instance.id}.mp3`,
                instance_source_id: instance.source_id || entry.source_id,
                entry_id: entry.id,
                entry_source_id: entry.source_id,
                path: entry.path,
                display_name: entry.display_name,
                source_name: entry.source_id === "r2-local" ? "R2" : "Storage",
              })) : [{
                instance_id: instance.id,
                storage_uri: instance.storage_uri || "",
                instance_source_id: instance.source_id || "",
                entry_id: null,
                entry_source_id: null,
                path: null,
                display_name: null,
                source_name: "WebDAV",
              }])
              : []) as T[] };
          }
          if (query.includes("FROM storage_entries e") && query.includes("e.path LIKE ?")) {
            const path = String(statement.args[1]);
            const prefix = String(statement.args[2]).replace(/%$/, "").replace(/\\([\\%_])/g, "$1");
            return { results: entries.filter((entry) => entry.source_id === statement.args[0]
              && (entry.path === path || entry.path.startsWith(prefix))).map((entry) => ({
                id: entry.id,
                path: entry.path,
                kind: entry.kind,
                object_id: entry.object_id,
                instance_id: entry.instance_id,
                physical_key: objects.find((object) => object.id === entry.object_id)?.physical_key ?? null,
              })) as T[] };
          }
          if (query.includes("SELECT id FROM song_instances WHERE storage_object_id = ?")) {
            return { results: instances.filter((row) => row.storage_object_id === statement.args[0]).map((row) => ({ id: row.id })) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (query.startsWith("DELETE FROM storage_entries WHERE id = ?")) {
            const id = String(statement.args[0]);
            const pending = [id];
            while (pending.length) {
              const current = pending.pop()!;
              pending.push(...entries.filter((entry) => entry.parent_id === current).map((entry) => entry.id));
              for (let index = entries.length - 1; index >= 0; index--) {
                if (entries[index].id === current) entries.splice(index, 1);
              }
            }
          } else if (query.startsWith("DELETE FROM song_instances WHERE id = ?")) {
            const index = instances.findIndex((item) => item.id === statement.args[0]);
            if (index >= 0) instances.splice(index, 1);
          } else if (query.startsWith("DELETE FROM storage_objects WHERE id = ?")) {
            const index = objects.findIndex((item) => item.id === statement.args[0]
              && (statement.args.length < 2 || item.physical_key === statement.args[1]));
            if (index >= 0) objects.splice(index, 1);
          } else if (query.startsWith("DELETE FROM song_masters WHERE id = ?")) {
            const index = masters.findIndex((item) => item.id === statement.args[0]);
            if (index >= 0) masters.splice(index, 1);
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "tester", level: options.level ?? 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", filesRoutes);
  app.route("/storage", browseRoutes);
  const env = { DB: db, MUSIC_BUCKET: { async delete(key: string | string[]) {
    bucketDeleteCalls++;
    if (bucketDeleteFailure || bucketDeleteCalls === options.bucketDeleteFailsOnCall) throw new Error("R2 unavailable");
    for (const item of Array.isArray(key) ? key : [key]) bucketKeys.delete(item);
  } } };
  return {
    entries, instances, objects, masters, bucketKeys,
    failBucketDeletes(value: boolean) { bucketDeleteFailure = value; },
    get bucketDeleteCalls() { return bucketDeleteCalls; },
    get locationReads() { return locationReads; },
    async post(url: string, body: unknown) {
      return app.fetch(new Request(`http://test${url}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), env);
    },
    async get(url: string) {
      return app.fetch(new Request(`http://test${url}`), env);
    },
  };
}

function entry(id: string, path: string, objectId: string | null, instanceId: string | null, kind: Entry["kind"] = "file", parentId: string | null = null): Entry {
  return { id, source_id: "r2-local", path, display_name: path.split("/").pop() || path, kind, parent_id: parentId, object_id: objectId, instance_id: instanceId, companion_of: null };
}

function instance(id: string, masterId: string, objectId: string | null): Instance {
  return { id, master_id: masterId, storage_object_id: objectId, missing: 0 };
}

function objectRow(id: string, key = `objects/${id}.mp3`): ObjectRow { return { id, physical_key: key }; }
function master(id: string): Master { return { id, album_id: `album-${id}`, artist_id: `artist-${id}` }; }

async function main() {
  console.log("\nfiles/delete → rejects path and key mismatch without mutating storage:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({ entries: [entry("e1", "Album/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1")], objects: [target], masters: [master("m1")] });
    const response = await fixture.post("/storage/files/delete", { path: "Album/track.mp3", key: "objects/wrong.mp3" });
    assert(response.status === 404, "mismatched object key is rejected");
    assert(fixture.entries.length === 1 && fixture.instances.length === 1 && fixture.objects.length === 1 && fixture.bucketKeys.has(target.physical_key), "D1 rows and R2 bytes remain untouched");
  }

  console.log("\nfiles/delete → retains a shared instance and object while another logical entry exists:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({ entries: [entry("e1", "Album/track.mp3", "o1", "i1"), entry("e2", "Aliases/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1")], objects: [target], masters: [master("m1")] });
    const response = await fixture.post("/storage/files/delete", { path: "Album/track.mp3", key: target.physical_key });
    assert(response.status === 200, "one exact entry can be removed");
    assert(fixture.entries.length === 1 && fixture.instances.length === 1, "the other entry keeps its playable instance");
    assert(fixture.objects.length === 1 && fixture.bucketKeys.has(target.physical_key), "shared object metadata and bytes remain");
  }

  console.log("\nfiles/delete → preserves an object referenced by a separate instance:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({ entries: [entry("e1", "Album/one.mp3", "o1", "i1"), entry("e2", "Album/two.mp3", "o1", "i2")], instances: [instance("i1", "m1", "o1"), instance("i2", "m2", "o1")], objects: [target], masters: [master("m1"), master("m2")] });
    const response = await fixture.post("/storage/files/delete", { path: "Album/one.mp3", key: target.physical_key });
    assert(response.status === 200 && !fixture.instances.some((row) => row.id === "i1"), "deleted entry's unshared instance is removed");
    assert(fixture.entries.length === 1 && fixture.instances.some((row) => row.id === "i2"), "other instance remains available");
    assert(fixture.objects.length === 1 && fixture.bucketKeys.has(target.physical_key), "the shared R2 object stays available");
  }

  console.log("\nfiles/delete → removes the final object, instance, and orphaned master:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({ entries: [entry("e1", "Album/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1")], objects: [target], masters: [master("m1")] });
    const response = await fixture.post("/storage/files/delete", { path: "Album/track.mp3", key: target.physical_key });
    assert(response.status === 200 && fixture.entries.length === 0 && fixture.instances.length === 0, "final logical entry and instance are removed");
    assert(fixture.objects.length === 0 && !fixture.bucketKeys.has(target.physical_key) && fixture.masters.length === 0, "orphaned object bytes and master are cleaned up");
  }

  console.log("\nfiles/delete → retains catalog rows when physical deletion fails:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({ bucketDeleteFailure: true, entries: [entry("e1", "Album/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1")], objects: [target], masters: [master("m1")] });
    const response = await fixture.post("/storage/files/delete", { path: "Album/track.mp3", key: target.physical_key });
    assert(response.status === 502, "R2 failure is reported as a retryable delete failure");
    assert(fixture.entries.length === 1 && fixture.instances.length === 1 && fixture.objects.length === 1 && fixture.bucketKeys.has(target.physical_key), "all catalog references remain intact after failed R2 deletion");
  }

  console.log("\nfiles/deleteFolder → keeps an object shared with an entry outside the folder:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({ entries: [entry("folder", "Album", null, null, "folder"), entry("inside", "Album/track.mp3", "o1", "i1", "file", "folder"), entry("outside", "Aliases/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1")], objects: [target], masters: [master("m1")] });
    const response = await fixture.post("/storage/files/deleteFolder", { path: "Album" });
    assert(response.status === 200, "folder removal succeeds");
    assert(fixture.entries.length === 1 && fixture.entries[0].id === "outside" && fixture.instances.length === 1, "outside entry keeps its instance");
    assert(fixture.objects.length === 1 && fixture.bucketKeys.has(target.physical_key), "outside reference keeps the R2 object");
  }

  console.log("\nfiles/deleteFolder → deletes one object before removing all of its in-folder aliases:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({
      entries: [
        entry("folder", "Album", null, null, "folder"),
        entry("first-alias", "Album/one.mp3", "o1", "i1", "file", "folder"),
        entry("second-alias", "Album/two.mp3", "o1", "i1", "file", "folder"),
      ],
      instances: [instance("i1", "m1", "o1")],
      objects: [target],
      masters: [master("m1")],
    });
    const response = await fixture.post("/storage/files/deleteFolder", { path: "Album" });
    assert(response.status === 200 && fixture.bucketDeleteCalls === 1, "one shared physical object is deleted exactly once");
    assert(fixture.entries.length === 0 && fixture.instances.length === 0 && fixture.objects.length === 0, "all aliases and their shared catalog rows are removed after the object succeeds");
  }

  console.log("\nfiles/deleteFolder → retains catalog rows when physical deletion fails:");
  {
    const target = objectRow("o1");
    const fixture = makeFixture({ bucketDeleteFailure: true, entries: [entry("folder", "Album", null, null, "folder"), entry("inside", "Album/track.mp3", "o1", "i1", "file", "folder")], instances: [instance("i1", "m1", "o1")], objects: [target], masters: [master("m1")] });
    const response = await fixture.post("/storage/files/deleteFolder", { path: "Album" });
    assert(response.status === 502, "folder delete reports the physical storage failure");
    assert(fixture.entries.length === 2 && fixture.instances.length === 1 && fixture.objects.length === 1 && fixture.bucketKeys.has(target.physical_key), "folder catalog remains intact after failed R2 deletion");
  }

  console.log("\nfiles/deleteFolder → commits completed objects and retries remaining entries after a later R2 failure:");
  {
    const first = objectRow("o1");
    const second = objectRow("o2");
    const fixture = makeFixture({
      bucketDeleteFailsOnCall: 2,
      entries: [
        entry("folder", "Album", null, null, "folder"),
        entry("first", "Album/one.mp3", "o1", "i1", "file", "folder"),
        entry("nested", "Album/Disc", null, null, "folder", "folder"),
        entry("second", "Album/Disc/two.mp3", "o2", "i2", "file", "nested"),
      ],
      instances: [instance("i1", "m1", "o1"), instance("i2", "m2", "o2")],
      objects: [first, second],
      masters: [master("m1"), master("m2")],
    });
    const partialResponse = await fixture.post("/storage/files/deleteFolder", { path: "Album" });
    const partial = await partialResponse.json<{ ok: boolean; partial?: boolean; deleted?: number }>();
    assert(partialResponse.status === 502 && partial.partial && partial.deleted === 1, "second R2 failure is reported as a partial deletion");
    assert(!fixture.bucketKeys.has(first.physical_key) && fixture.bucketKeys.has(second.physical_key), "only the successful first R2 object is removed");
    assert(!fixture.entries.some((item) => item.id === "first") && !fixture.instances.some((item) => item.id === "i1") && !fixture.objects.some((item) => item.id === "o1") && !fixture.masters.some((item) => item.id === "m1"), "completed entry, instance, object, and orphaned master are cleaned up");
    assert(fixture.entries.some((item) => item.id === "folder") && fixture.entries.some((item) => item.id === "nested") && fixture.entries.some((item) => item.id === "second"), "remaining file and folder rows stay available for retry");

    const retryResponse = await fixture.post("/storage/files/deleteFolder", { path: "Album" });
    const retry = await retryResponse.json<{ ok: boolean; deleted: number }>();
    assert(retryResponse.status === 200 && retry.ok && retry.deleted === 3, "retry completes the remaining subtree");
    assert(fixture.entries.length === 0 && fixture.instances.length === 0 && fixture.objects.length === 0, "retry cleans the remaining catalog rows");
    assert(fixture.bucketKeys.size === 0 && fixture.masters.length === 0, "retry removes the remaining R2 object and orphaned master");
  }

  console.log("\nfiles/song-locations → requires file-management permission:");
  {
    const fixture = makeFixture({ level: 1, entries: [entry("e1", "Album/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1")], objects: [objectRow("o1")], masters: [master("m1")] });
    const response = await fixture.get("/storage/files/song-locations?songId=m1");
    assert(response.status === 403 && fixture.locationReads === 0, "users without manage_files cannot resolve library locations");
  }

  console.log("\nfiles/song-locations → returns logical entries for permitted users:");
  {
    const fixture = makeFixture({ entries: [entry("e1", "Album/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1")], objects: [objectRow("o1")], masters: [master("m1")] });
    const response = await fixture.get("/storage/files/song-locations?songId=m1");
    const result = await response.json<{ ok: boolean; locations: Array<{ locationKey: string; entryId: string | null; source: string; sourceName: string; path: string; name: string }> }>();
    assert(response.status === 200 && result.ok && fixture.locationReads === 1, "permitted users can resolve library locations");
    assert(result.locations[0]?.source === "r2" && result.locations[0]?.sourceName === "R2" && result.locations[0]?.path === "Album/track.mp3", "location response contains the exact logical file entry");
    assert(result.locations[0]?.entryId === "e1" && result.locations[0]?.locationKey === "e1", "location identity is the logical entry id");
  }

  console.log("\nfiles/song-locations → distinguishes same-name aliases and external WebDAV instances:");
  {
    const fixture = makeFixture({ entries: [entry("single", "Single/track.mp3", "o1", "i1"), entry("album", "Album/track.mp3", "o1", "i1")], instances: [instance("i1", "m1", "o1"), { ...instance("i2", "m1", null), storage_uri: "webdav://dav-a/External/track.mp3", source_id: "dav-a" }], objects: [objectRow("o1")], masters: [master("m1")] });
    const response = await fixture.get("/storage/files/song-locations?songId=m1");
    const result = await response.json<{ locations: Array<{ locationKey: string; entryId: string | null; source: string; path: string }> }>();
    const single = result.locations.find((row) => row.entryId === "single");
    const album = result.locations.find((row) => row.entryId === "album");
    const external = result.locations.find((row) => row.entryId === null);
    assert(single?.locationKey === "single" && album?.locationKey === "album" && single.path !== album.path, "same-instance entries keep distinct stable identities and full paths");
    assert(external?.locationKey === "i2" && external.source === "dav-a" && external.path === "External/track.mp3", "external source without a logical entry resolves only from its canonical storage URI");
  }

  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
