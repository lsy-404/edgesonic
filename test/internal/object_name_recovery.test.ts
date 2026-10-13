import { hasReadableLogicalTrackTitle, recoverMetadataFromLogicalPath, recoverMetadataFromStoragePath, sourceFolderLogicalPath } from "../../worker/src/utils/storageMetadata";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const logical = recoverMetadataFromStoragePath(
  "music/专辑/茜色诗集/wav/泠鸢yousa - 夏日已所剩无几.wav",
  { title: "??", album: "??", artist: "Known Artist" },
);
assert(logical.title === "泠鸢yousa - 夏日已所剩无几", "logical source path restores a lossy title");
assert(logical.album === "茜色诗集", "logical source path restores album from the 专辑 tree");
assert(logical.artist === "Known Artist", "clean artist metadata is retained");

for (const placeholder of ["obj", "obj_abcdef0123456789", "OBJ_ABCDEF0123456789"]) {
  const recovered = recoverMetadataFromStoragePath(
    "Music/Artist/Album/07 Original Song.flac",
    { title: placeholder, album: "Reliable Album", artist: "Reliable Artist", albumArtist: "Reliable Album Artist" },
  );
  assert(recovered.title === "Original Song", `${placeholder} title placeholder uses the original logical filename`);
  assert(recovered.album === "Reliable Album" && recovered.artist === "Reliable Artist" && recovered.albumArtist === "Reliable Album Artist",
    `${placeholder} replacement preserves known album and artist identities`);
}

const genuineObjectName = recoverMetadataFromStoragePath("Music/Artist/Album/obj.flac", { title: "obj" });
assert(genuineObjectName.title === "obj", "a genuine song named obj retains its logical filename");
const objective = recoverMetadataFromStoragePath("Music/Artist/Album/Objective.flac", { title: "Objective" });
assert(objective.title === "Objective", "Objective is a real title, not an object placeholder");
const emptyTitle = recoverMetadataFromStoragePath("Music/Artist/Album/08 Empty Tags.flac", { title: "" });
assert(emptyTitle.title === "Empty Tags", "an empty title recovers from the logical filename");
const objectsFolder = recoverMetadataFromLogicalPath("objects/Album/08 Logical Song.flac", { title: "obj_abcdef0123456789" });
assert(objectsFolder.title === "Logical Song", "a logical folder named objects still uses its original filename");
assert(hasReadableLogicalTrackTitle("Artist/Album/08 Logical Song.flac"), "a real logical filename enables filename-only metadata");
assert(!hasReadableLogicalTrackTitle("objects/obj_abcdef0123456789.flac"), "a physical object key is not a readable logical filename");
assert(!hasReadableLogicalTrackTitle(null), "missing logical path does not enable filename-only metadata");

const objectUri = "r2://objects/obj_abcdef0123456789.wav";
const physical = recoverMetadataFromStoragePath(objectUri, { title: "??", album: "??" });
assert(physical.title === "??" && physical.album === "??", "physical R2 object URI does not become metadata");
const physicalObjectTitle = recoverMetadataFromStoragePath(objectUri, { title: "obj_abcdef0123456789" });
assert(physicalObjectTitle.title === "obj_abcdef0123456789", "physical object key does not become a display title");

const directObjectPath = recoverMetadataFromStoragePath("obj_abcdef0123456789.wav", { title: "??" });
assert(directObjectPath.title === "??", "generated object filename is never recovered as a title");

for (const hash of ["abcdef0123456789abcdef01", "abcdef0123456789abcdef0123456789"]) {
  const nestedObjectPath = recoverMetadataFromStoragePath(
    `music/专辑/objects/obj_${hash}.wav`,
    { title: "??", album: "??" },
  );
  assert(nestedObjectPath.title === "??" && nestedObjectPath.album === "??", `${hash.length}-digit object hash is never recovered`);
}

const clean = recoverMetadataFromStoragePath("music/专辑/other/wav/01 other.wav", {
  title: "Correct Title", album: "Correct Album", artist: "Correct Artist",
});
assert(clean.title === "Correct Title" && clean.album === "Correct Album" && clean.artist === "Correct Artist", "existing clean tags are unchanged");

const noPath = recoverMetadataFromStoragePath(null, { title: "??", album: "??" });
assert(noPath.title === "??" && noPath.album === "??", "missing logical path leaves metadata untouched");

const rootTrack = recoverMetadataFromStoragePath("01 Fixture Song.mp3", { title: "??", album: "??" });
assert(rootTrack.title === "Fixture Song" && rootTrack.album === "??", "root-level song filename does not become an album hint");

const albumTrack = recoverMetadataFromStoragePath("Fixture Album/01 Fixture Song.mp3", { title: "??", album: "??" });
assert(albumTrack.title === "Fixture Song" && albumTrack.album === "Fixture Album", "parent album folder remains a usable metadata hint");

function fakeDb(paths: string[]): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: paths.map((path) => ({ path })) }) }),
    }),
  } as unknown as D1Database;
}

async function main() {
  assert(await sourceFolderLogicalPath(fakeDb(["album/track.wav"]), "si-one") === "album/track.wav", "one storage entry provides its logical path");
  assert(await sourceFolderLogicalPath(fakeDb([]), "si-none") === null, "no storage entry yields no logical path");
  assert(await sourceFolderLogicalPath(fakeDb(["album/a.wav", "other/a.wav"]), "si-many") === null, "ambiguous storage entries yield no logical path");
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

void main();
