
const os = require("os");
const {
  addonBuilder,
  serveHTTP
} = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT) || 7000;

const manifest = {
  id: "org.example.archivemoviesearch",
  version: "1.6.0",
  name: "Internet Archive Movies & Shows",
  description:
    "Public domain and freely available movies and TV episodes from the Internet Archive",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
};

const builder = new addonBuilder(manifest);

const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();

function getCache(key) {
  const entry = cache.get(key);

  if (!entry || Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCache(key, value) {
  cache.set(key, {
    value,
    expires: Date.now() + CACHE_TTL
  });
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "InternetArchiveStremioAddon/1.6"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function cleanTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function moviePercent(a, b) {
  const first = cleanTitle(a);
  const second = cleanTitle(b);

  if (!first || !second) return 0;
  if (first === second) return 100;

  const firstWords = new Set(first.split(" "));
  const secondWords = new Set(second.split(" "));

  let matches = 0;

  for (const word of firstWords) {
    if (secondWords.has(word)) matches++;
  }

  return Math.round(
    (matches / Math.max(firstWords.size, secondWords.size)) * 100
  );
}

async function getCinemeta(type, imdbId) {
  const key = `cinemeta:${type}:${imdbId}`;
  const cached = getCache(key);

  if (cached) return cached;

  const url =
    `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;

  const data = await fetchJSON(url);
  const meta = data && data.meta;

  if (!meta) {
    throw new Error("Cinemeta metadata not found");
  }

  setCache(key, meta);
  return meta;
}

async function searchArchive(title, year) {
  const key = `archive:${title}:${year || ""}`;
  const cached = getCache(key);

  if (cached) return cached;

  const safeTitle = String(title)
    .replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!safeTitle) return [];

  let query = `mediatype:movies AND title:("${safeTitle}")`;

  if (year) {
    query += ` AND year:${Number(year)}`;
  }

  const params = new URLSearchParams();
  params.set("q", query);
  params.append("fl[]", "identifier");
  params.append("fl[]", "title");
  params.append("fl[]", "year");
  params.append("fl[]", "mediatype");
  params.set("rows", "30");
  params.set("page", "1");
  params.set("output", "json");

  const url =
    "https://archive.org/advancedsearch.php?" +
    params.toString();

  const data = await fetchJSON(url);
  const docs = data?.response?.docs || [];

  setCache(key, docs);
  return docs;
}

async function getArchiveFiles(identifier) {
  const key = `files:${identifier}`;
  const cached = getCache(key);

  if (cached) return cached;

  const url =
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`;

  const data = await fetchJSON(url);
  const files = data?.files || [];

  setCache(key, files);
  return files;
}

function isPlayableVideo(file) {
  const name = String(file.name || "").toLowerCase();
  const format = String(file.format || "").toLowerCase();

  if (file.private === "true") return false;
  if (name.endsWith(".torrent")) return false;
  if (name.endsWith(".xml")) return false;
  if (name.endsWith(".srt")) return false;
  if (name.endsWith(".jpg")) return false;
  if (name.endsWith(".jpeg")) return false;
  if (name.endsWith(".png")) return false;

  const extensions = [
    ".mp4",
    ".m4v",
    ".mkv",
    ".webm",
    ".mov",
    ".avi",
    ".ogv",
    ".mpeg",
    ".mpg"
  ];

  const supportedFormats = [
    "mpeg4",
    "h.264",
    "h264",
    "webm",
    "matroska",
    "quicktime",
    "ogg video"
  ];

  return (
    extensions.some(ext => name.endsWith(ext)) ||
    supportedFormats.some(value => format.includes(value))
  );
}

function fileScore(file) {
  const name = String(file.name || "").toLowerCase();
  const format = String(file.format || "").toLowerCase();

  let score = 0;

  if (name.endsWith(".mp4")) score += 50;
  if (format.includes("mpeg4")) score += 30;
  if (format.includes("h.264") || format.includes("h264")) {
    score += 25;
  }
  if (name.endsWith(".webm")) score += 15;
  if (name.endsWith(".mkv")) score += 10;

  const size = Number(file.size || 0);

  if (size > 0) {
    if (size < 2 * 1024 * 1024 * 1024) score += 10;
    if (size > 10 * 1024 * 1024 * 1024) score -= 20;
  }

  return score;
}

async function findStreams(meta) {
  const title = meta.name || meta.title;

  if (!title) return [];

  const results = await searchArchive(title, meta.year);
  const candidates = results
    .map(item => ({
      ...item,
      score: moviePercent(title, item.title)
    }))
    .filter(item => item.score >= 45)
    .sort((a, b) => b.score - a.score);

  const streams = [];

  for (const item of candidates.slice(0, 10)) {
    try {
      const files = await getArchiveFiles(item.identifier);

      const playable = files
        .filter(isPlayableVideo)
        .sort((a, b) => fileScore(b) - fileScore(a));

      for (const file of playable.slice(0, 3)) {
        const encodedIdentifier =
          encodeURIComponent(item.identifier);

        const encodedFile = file.name
          .split("/")
          .map(part => encodeURIComponent(part))
          .join("/");

        const url =
          `https://archive.org/download/${encodedIdentifier}/${encodedFile}`;

        streams.push({
          name: "Internet Archive",
          title:
            `${item.title || title}\n` +
            `${file.name}\n` +
            `Match: ${item.score}%`,
          url,
          behaviorHints: {
            notWebReady: false
          }
        });
      }
    } catch (error) {
      console.error(
        `[Internet Archive] Failed item ${item.identifier}:`,
        error.message
      );
    }

    if (streams.length >= 8) break;
  }

  return streams;
}

builder.defineStreamHandler(async args => {
  try {
    const type = args.type;
    const rawId = String(args.id || "");
    const imdbId = rawId.split(":")[0];

    if (!/^tt\d+$/.test(imdbId)) {
      return { streams: [] };
    }

    if (!["movie", "series"].includes(type)) {
      return { streams: [] };
    }

    console.log(
      `[Internet Archive] Searching ${type}: ${imdbId}`
    );

    const meta = await getCinemeta(type, imdbId);
    const streams = await findStreams(meta);

    console.log(
      `[Internet Archive] Found ${streams.length} streams`
    );

    return { streams };
  } catch (error) {
    console.error(
      "[Internet Archive] Stream error:",
      error.message
    );

    return { streams: [] };
  }
});

const interfaces = os.networkInterfaces();
let lan = null;

for (const entries of Object.values(interfaces)) {
  for (const entry of entries || []) {
    if (
      entry.family === "IPv4" &&
      !entry.internal
    ) {
      lan = entry;
      break;
    }
  }

  if (lan) break;
}

serveHTTP(builder.getInterface(), { port: PORT });

const local = `127.0.0.1:${PORT}/manifest.json`;

console.log("\n=== Add-on running ===");
console.log("This device: http://" + local);
console.log("Tap to install: stremio://" + local);

if (lan) {
  console.log(
    "Other devices: http://" +
    lan.address +
    ":" +
    PORT +
    "/manifest.json"
  );
}

console.log("======================\n");
