// Import only the 12 ambience categories used by Praxis. No remote code is executed.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const origin = "https://www.ppbzy.com";
const destination = new URL(
  "../apps/client/public/ambience/ppbzy/",
  import.meta.url,
);
const manifestUrl = new URL("manifest.json", destination);
const categoryIds = [
  "cat",
  "rain",
  "thunder",
  "wind",
  "blizzard",
  "fire",
  "waves",
  "birds",
  "stream",
  "forest",
  "night",
  "cafe",
];
const quality = "high";
let trackCount = 0;

function extension(bytes) {
  if (bytes.subarray(4, 8).toString() === "ftyp") return "m4a";
  if (
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  )
    return "mp3";
  if (bytes.subarray(0, 4).toString() === "OggS") return "ogg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE"
  )
    return "wav";
  throw new Error("Unrecognized audio file header");
}

async function request(url) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`${response.status}: ${url}`);
      return response;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

// Read literal configuration through the syntax tree, without eval/import of website JS.
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  )
    return !Number(literal(node.operand));
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.flatMap((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          property.name.getText() === "icon"
        )
          return [];
        return [[property.name.text, literal(property.initializer)]];
      }),
    );
  }
  return undefined;
}

const html = await (await request(origin)).text();
const libraryPath = html.match(
  /component-url="([^"]*\/Library\.[^"]+\.js)"/,
)?.[1];
if (!libraryPath) throw new Error("Website audio library was not found");
const libraryUrl = new URL(libraryPath, origin);
const library = await (await request(libraryUrl)).text();
const constantsPath = library.match(
  /from["']([^"']*constants\.[^"']+\.js)["']/,
)?.[1];
if (!constantsPath)
  throw new Error("Website audio configuration was not found");
const constantsUrl = new URL(constantsPath, libraryUrl);
const source = await (await request(constantsUrl)).text();
const syntax = ts.createSourceFile(
  "constants.js",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const arrays = [];
const objects = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (ts.isArrayLiteralExpression(node.initializer))
      arrays.push(literal(node.initializer));
    if (ts.isObjectLiteralExpression(node.initializer))
      objects.push(literal(node.initializer));
  }
  ts.forEachChild(node, visit);
}
visit(syntax);
const groups = arrays.find((items) =>
  categoryIds.every((id) =>
    items.some((item) => item?.id === id && item.variants),
  ),
);
const folders = objects.find(
  (item) => item.background === "Background" && item.ambient === "Ambient",
);
const suffixes = objects.find((item) => item.high === "_320.m4a");
if (!groups || !folders || !suffixes)
  throw new Error("Unexpected website audio configuration");
let previous;
try {
  previous = JSON.parse(await readFile(manifestUrl, "utf8"));
} catch {
  /* First import. */
}
const manifest = {
  source: `${origin}/`,
  configurationUrl: constantsUrl.href,
  importedOn: new Date().toISOString().slice(0, 10),
  quality,
  categories: {},
};
const jobs = [];
for (const id of categoryIds) {
  const group = groups.find((item) => item.id === id);
  const variants = group.variants.map((variant, index) => {
    const owner = variant.from
      ? groups.find((item) => item.id === variant.from)
      : group;
    if (!owner || !folders[owner.category])
      throw new Error(`Unknown audio folder: ${id}`);
    const segments = [
      folders[owner.category],
      owner.folder,
      variant.id + (owner.noQuality ? ".m4a" : suffixes[quality]),
    ];
    const track = {
      id: variant.id,
      name: variant.name,
      file: `ambience/ppbzy/${id}/${index + 1}.m4a`,
      sourceUrl: `${origin}/audio/${segments.map(encodeURIComponent).join("/")}`,
      bytes: 0,
      sha256: "",
    };
    jobs.push({ id, track });
    return track;
  });
  manifest.categories[id] = { name: group.name, variants };
}
console.log(
  `${categoryIds.length} categories, ${jobs.length} tracks, ${quality} quality`,
);
trackCount = jobs.length;
if (!process.argv.includes("--download")) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  await mkdir(destination, { recursive: true });
  let completed = 0;
  async function worker() {
    while (jobs.length) {
      const { id, track } = jobs.shift();
      await mkdir(new URL(`${id}/`, destination), { recursive: true });
      const old = previous?.categories?.[id]?.variants.find(
        (item) => item.sourceUrl === track.sourceUrl,
      );
      let bytes;
      try {
        if (!old) throw new Error("No cached track");
        const cached = await readFile(
          new URL(old.file.replace("ambience/ppbzy/", ""), destination),
        );
        if (old?.sha256 === createHash("sha256").update(cached).digest("hex"))
          bytes = cached;
      } catch {
        /* Download uncached tracks. */
      }
      if (!bytes) {
        const response = await request(track.sourceUrl);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      // Some website .m4a URLs actually contain MP3 data. Preserve the bytes,
      // but use the real extension so local servers provide the correct MIME type.
      track.file = track.file.replace(/\.m4a$/, `.${extension(bytes)}`);
      const target = new URL(
        track.file.replace("ambience/ppbzy/", ""),
        destination,
      );
      {
        const temporary = fileURLToPath(target) + ".partial";
        await writeFile(temporary, bytes);
        await rename(temporary, target);
      }
      track.bytes = bytes.length;
      track.sha256 = createHash("sha256").update(bytes).digest("hex");
      console.log(
        `${++completed}/${trackCount} ${id}: ${track.name} (${bytes.length} bytes)`,
      );
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Saved ${fileURLToPath(manifestUrl)}`);
}
