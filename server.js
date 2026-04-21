const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL } = require("url");

let MongoClient = null;
try {
  ({ MongoClient } = require("mongodb"));
} catch {
  MongoClient = null;
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const ENV_FILE = path.join(ROOT, ".env");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = "m${{MongoDB.MONGO_URL}}";
const REQUESTED_MONGODB_DB = process.env.MONGODB_DB || "ai_plagiarism_checker";
const MONGODB_DB = /pharma/i.test(REQUESTED_MONGODB_DB) ? "ai_plagiarism_checker" : REQUESTED_MONGODB_DB;
const USE_MONGODB = String(process.env.USE_MONGODB || "true").toLowerCase() !== "false";
const REQUIRE_MONGODB = String(process.env.REQUIRE_MONGODB || "false").toLowerCase() === "true";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@12345";
const ADMIN_NAME = process.env.ADMIN_NAME || "Project Admin";
let mongoClient = null;
let mongoDb = null;
let storageMode = "json";
let storageReason = "Storage not initialized yet.";

const INTERNAL_SOURCES = [
  {
    title: "Institutional repository: Academic honesty guide",
    url: "internal://academic-honesty-guide",
    text: "Academic integrity requires that students cite sources accurately, avoid copying language without quotation marks, and submit original analysis. Paraphrased ideas must still include attribution."
  },
  {
    title: "Open web: Research writing primer",
    url: "https://example.edu/research-writing-primer",
    text: "Strong research writing introduces a claim, integrates evidence, explains the reasoning, and uses a consistent citation style. A clear paragraph usually connects evidence to the central argument."
  },
  {
    title: "Student archive: AI ethics essay sample",
    url: "internal://student-archive-ai-ethics",
    text: "Artificial intelligence systems influence education by automating feedback, identifying patterns in student work, and raising questions about authorship, transparency, and accountability."
  },
  {
    title: "Library source: Citation basics",
    url: "internal://library-citation-basics",
    text: "APA citations include author, year, title, and source information. MLA emphasizes author and page references, while Chicago may use footnotes or author date formatting."
  }
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function ensureStorage() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeDb({ users: [], submissions: [], reports: [] });
  }
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function readDb() {
  ensureStorage();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function sanitizeMongoUri(uri) {
  if (!uri) return "";
  return uri.replace(/\/\/([^/@]+)@/, "//***:***@");
}

function getStorageStatus(overrideCounts = null) {
  return {
    mode: storageMode,
    reason: storageReason,
    mongodb: {
      enabled: USE_MONGODB,
      required: REQUIRE_MONGODB,
      driverInstalled: Boolean(MongoClient),
      uri: sanitizeMongoUri(MONGODB_URI),
      database: MONGODB_DB,
      connected: storageMode === "mongodb"
    },
    counts: overrideCounts
  };
}

async function initStorage() {
  ensureStorage();
  if (REQUESTED_MONGODB_DB !== MONGODB_DB) {
    console.log(`MongoDB database "${REQUESTED_MONGODB_DB}" is blocked for this project. Using "${MONGODB_DB}" instead.`);
  }
  if (!USE_MONGODB) {
    storageReason = "JSON file because USE_MONGODB=false";
    console.log(`Storage mode: ${storageReason}`);
    return;
  }
  if (!MongoClient) {
    storageReason = "JSON file because mongodb package is not installed. Run npm install.";
    console.log(`Storage mode: ${storageReason}`);
    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2500 });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGODB_DB);
    await mongoDb.collection("users").createIndex({ email: 1 }, { unique: true });
    await mongoDb.collection("users").createIndex({ emailLower: 1 }, { unique: true });
    await mongoDb.collection("submissions").createIndex({ timestamp: -1 });
    await mongoDb.collection("submissions").createIndex({ reportId: 1 });
    await mongoDb.collection("reports").createIndex({ id: 1 }, { unique: true });
    await mongoDb.collection("extracted_texts").createIndex({ submissionId: 1 }, { unique: true });
    await mongoDb.collection("similarity_segments").createIndex({ submissionId: 1 });
    storageMode = "mongodb";
    storageReason = `MongoDB connected to "${MONGODB_DB}".`;
    await seedAdminUser();
    console.log(`Storage mode: MongoDB database "${MONGODB_DB}"`);
  } catch (error) {
    mongoClient = null;
    mongoDb = null;
    storageMode = "json";
    storageReason = `JSON file because MongoDB connection failed: ${error.message}`;
    console.log(`Storage mode: ${storageReason}`);
    if (REQUIRE_MONGODB) {
      throw new Error(`MongoDB connection is required but failed: ${error.message}`);
    }
  }
}

async function findUserByEmail(email) {
  const normalized = String(email || "").toLowerCase();
  if (storageMode === "mongodb") {
    return mongoDb.collection("users").findOne({ emailLower: normalized }, { projection: { _id: 0 } });
  }
  return readDb().users.find(user => user.email.toLowerCase() === normalized) || null;
}

async function saveUser(user) {
  if (storageMode === "mongodb") {
    await mongoDb.collection("users").updateOne(
      { id: user.id },
      { $set: { ...user, emailLower: user.email.toLowerCase() } },
      { upsert: true }
    );
    return user;
  }
  const db = readDb();
  const existingIndex = db.users.findIndex(item => item.id === user.id);
  if (existingIndex >= 0) db.users[existingIndex] = user;
  else db.users.push(user);
  writeDb(db);
  return user;
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, passwordSalt, emailLower, _id, ...safeUser } = user;
  return safeUser;
}

function createPasswordFields(password) {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.pbkdf2Sync(String(password), passwordSalt, 100000, 32, "sha256").toString("hex");
  return { passwordSalt, passwordHash };
}

function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const hash = crypto.pbkdf2Sync(String(password), user.passwordSalt, 100000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

async function seedAdminUser() {
  const existing = await findUserByEmail(ADMIN_EMAIL);
  const passwordFields = existing?.passwordHash ? {} : createPasswordFields(ADMIN_PASSWORD);
  const admin = {
    id: existing?.id || `usr_${crypto.randomUUID()}`,
    name: existing?.name || ADMIN_NAME,
    role: "admin",
    email: ADMIN_EMAIL,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...passwordFields
  };
  await saveUser(admin);
}

async function saveSubmissionAndReport(submission, report) {
  if (storageMode === "mongodb") {
    await mongoDb.collection("submissions").updateOne(
      { id: submission.id },
      { $set: submission },
      { upsert: true }
    );
    await mongoDb.collection("reports").updateOne(
      { id: report.id },
      { $set: report },
      { upsert: true }
    );
    await mongoDb.collection("extracted_texts").updateOne(
      { submissionId: submission.id },
      {
        $set: {
          submissionId: submission.id,
          reportId: report.id,
          content: report.extractedText,
          createdAt: report.createdAt
        }
      },
      { upsert: true }
    );
    await mongoDb.collection("similarity_segments").deleteMany({ submissionId: submission.id });
    if (report.similarity?.segments?.length) {
      await mongoDb.collection("similarity_segments").insertMany(report.similarity.segments.map(segment => ({
        ...segment,
        submissionId: submission.id,
        reportId: report.id,
        createdAt: report.createdAt
      })));
    }
    return;
  }
  const db = readDb();
  db.submissions.unshift(submission);
  db.reports.unshift(report);
  writeDb(db);
}

function buildRealtimeSubmission(report, userId, filename, source = "live-analysis") {
  return {
    id: `sub_${crypto.randomUUID()}`,
    userId,
    filePath: source,
    filename,
    timestamp: report.createdAt,
    reportId: report.id,
    status: "complete"
  };
}

async function getReportById(id) {
  if (storageMode === "mongodb") {
    return mongoDb.collection("reports").findOne({ id }, { projection: { _id: 0 } });
  }
  return readDb().reports.find(item => item.id === id) || null;
}

async function listSubmissionsWithReports(userId = "") {
  const filter = userId ? { userId } : {};
  if (storageMode === "mongodb") {
    return mongoDb.collection("submissions").aggregate([
      { $match: filter },
      { $sort: { timestamp: -1 } },
      {
        $lookup: {
          from: "reports",
          localField: "reportId",
          foreignField: "id",
          as: "report"
        }
      },
      { $unwind: { path: "$report", preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, "report._id": 0 } }
    ]).toArray();
  }
  const db = readDb();
  return db.submissions
    .filter(submission => !userId || submission.userId === userId)
    .map(submission => ({
      ...submission,
      report: db.reports.find(report => report.id === submission.reportId)
    }));
}

async function deleteSubmissionCascade(submissionId) {
  if (!submissionId) return false;
  if (storageMode === "mongodb") {
    const submission = await mongoDb.collection("submissions").findOne({ id: submissionId }, { projection: { _id: 0 } });
    if (!submission) return false;
    await mongoDb.collection("submissions").deleteOne({ id: submissionId });
    await mongoDb.collection("reports").deleteOne({ id: submission.reportId });
    await mongoDb.collection("extracted_texts").deleteOne({ submissionId });
    await mongoDb.collection("similarity_segments").deleteMany({ submissionId });
    return true;
  }

  const db = readDb();
  const submission = db.submissions.find(item => item.id === submissionId);
  if (!submission) return false;
  db.submissions = db.submissions.filter(item => item.id !== submissionId);
  db.reports = db.reports.filter(item => item.id !== submission.reportId);
  writeDb(db);
  return true;
}

function buildSubmissionSummary(submissions) {
  const summary = {
    total: submissions.length,
    highSimilarity: 0,
    aiRisk: 0,
    citationIssues: 0,
    averageIntegrityScore: 0
  };

  if (!submissions.length) return summary;

  let integrityTotal = 0;
  for (const item of submissions) {
    const report = item.report || {};
    if ((report.similarity?.overall || 0) >= 35) summary.highSimilarity += 1;
    if ((report.aiContent?.probability || 0) >= 55) summary.aiRisk += 1;
    if ((report.citations?.issues?.length || 0) > 0) summary.citationIssues += 1;
    integrityTotal += report.integrityScore || 0;
  }

  summary.averageIntegrityScore = Math.round(integrityTotal / submissions.length);
  return summary;
}

async function storageCounts() {
  if (storageMode === "mongodb") {
    const [users, submissions, reports, extractedTexts, similaritySegments] = await Promise.all([
      mongoDb.collection("users").countDocuments(),
      mongoDb.collection("submissions").countDocuments(),
      mongoDb.collection("reports").countDocuments(),
      mongoDb.collection("extracted_texts").countDocuments(),
      mongoDb.collection("similarity_segments").countDocuments()
    ]);
    return { users, submissions, reports, extractedTexts, similaritySegments };
  }
  const db = readDb();
  return {
    users: db.users.length,
    submissions: db.submissions.length,
    reports: db.reports.length,
    extractedTexts: db.reports.length,
    similaritySegments: db.reports.reduce((sum, report) => sum + (report.similarity?.segments?.length || 0), 0)
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function collectBody(req, limit = Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`Payload too large. Maximum upload is ${MAX_UPLOAD_MB} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buffer) {
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString("utf8"));
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new Error("Missing multipart boundary.");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const headerText = buffer.slice(start, headerEnd).toString("utf8");
    let body = buffer.slice(headerEnd + 4, next);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.slice(0, -2);
    }
    const name = /name="([^"]+)"/i.exec(headerText)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headerText)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] || "application/octet-stream";
    parts.push({ name, filename, type, data: body });
    start = next;
  }
  return parts;
}

function normalizeText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
}

function removeControlArtifacts(text) {
  return String(text || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function joinSpacedGlyphWords(text) {
  return String(text || "").replace(/\b(?:[A-Za-z0-9]\s+){2,}[A-Za-z0-9]\b/g, match => match.replace(/\s+/g, ""));
}

function cleanExtractedPdfText(text) {
  const withoutArtifacts = removeControlArtifacts(text);
  const joined = joinSpacedGlyphWords(withoutArtifacts);
  return normalizeText(joined);
}

function extractText(fileBuffer, filename, mimeType) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext === ".txt" || mimeType.startsWith("text/")) {
    return normalizeText(fileBuffer.toString("utf8"));
  }

  if (ext === ".pdf") {
    return cleanExtractedPdfText(extractPdfText(fileBuffer)).slice(0, 40000);
  }

  if (ext === ".docx") {
    const xml = readDocxDocumentXml(fileBuffer);
    if (xml) {
      return normalizeText(
        xml
          .replace(/<w:tab\/>/g, " ")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      ).slice(0, 40000);
    }
    const raw = fileBuffer.toString("latin1");
    return normalizeText(raw.replace(/[^\x20-\x7E]+/g, " ")).slice(0, 40000);
  }

  return normalizeText(fileBuffer.toString("utf8"));
}

function extractPdfText(buffer) {
  const chunks = [];
  const raw = buffer.toString("latin1");
  const unicodeMaps = [];

  for (const match of raw.matchAll(/<<(.*?)>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g)) {
    const dictionary = match[1];
    const stream = Buffer.from(match[2], "latin1");
    const decoded = decodePdfStream(stream, dictionary);
    if (decoded) {
      chunks.push(decoded);
      if (/begincmap|beginbfchar|beginbfrange/.test(decoded)) {
        const map = parsePdfUnicodeMap(decoded);
        if (map.size) unicodeMaps.push(map);
      }
    }
  }

  chunks.push(raw);

  const text = chunks
    .map(chunk => extractPdfTextOperators(chunk, unicodeMaps))
    .filter(Boolean)
    .join(" ");

  const cleaned = cleanExtractedPdfText(text);
  if (looksReadable(cleaned)) return cleaned;

  const fallback = cleanExtractedPdfText(
    raw
      .replace(/%PDF-[\s\S]*?obj/g, " ")
      .replace(/[^\x20-\x7E]+/g, " ")
      .replace(/\/[A-Za-z0-9#_-]+/g, " ")
  );
  return looksReadable(fallback) ? fallback : "";
}

function decodePdfStream(stream, dictionary) {
  try {
    if (/\/FlateDecode\b/.test(dictionary)) {
      try {
        return zlib.inflateSync(stream).toString("latin1");
      } catch {
        return zlib.inflateRawSync(stream).toString("latin1");
      }
    }
    return stream.toString("latin1");
  } catch {
    return "";
  }
}

function extractPdfTextOperators(source, unicodeMaps = []) {
  const results = [];

  for (const match of source.matchAll(/\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g)) {
    results.push(decodePdfLiteral(match[0].replace(/\s*(?:Tj|'|")$/, "")));
  }

  for (const match of source.matchAll(/<([0-9A-Fa-f\s]{4,})>\s*Tj/g)) {
    results.push(decodePdfHex(match[1], unicodeMaps));
  }

  for (const match of source.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) {
    const arrayBody = match[1];
    for (const literal of arrayBody.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      results.push(decodePdfLiteral(literal[0]));
    }
    for (const hex of arrayBody.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)) {
      results.push(decodePdfHex(hex[1], unicodeMaps));
    }
    results.push(" ");
  }

  return results.join(" ");
}

function decodePdfLiteral(value) {
  const body = value.replace(/^\(/, "").replace(/\)$/, "");
  return body
    .replace(/\\([nrtbf()\\])/g, (_, char) => ({
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      "(": "(",
      ")": ")",
      "\\": "\\"
    })[char] || char)
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function parsePdfUnicodeMap(source) {
  const map = new Map();

  for (const match of source.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
    if (match[1].length <= 8 && match[2].length <= 16) {
      map.set(match[1].toUpperCase(), hexToUtf16(match[2]));
    }
  }

  for (const block of source.matchAll(/beginbfrange\s*([\s\S]*?)\s*endbfrange/g)) {
    for (const line of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(line[1], 16);
      const end = parseInt(line[2], 16);
      let dest = parseInt(line[3], 16);
      for (let code = start; code <= end; code += 1) {
        const width = line[1].length;
        map.set(code.toString(16).toUpperCase().padStart(width, "0"), hexToUtf16(dest.toString(16).toUpperCase().padStart(line[3].length, "0")));
        dest += 1;
      }
    }
  }

  return map;
}

function hexToUtf16(hex) {
  const clean = hex.replace(/\s+/g, "");
  if (!clean || /^0+$/.test(clean)) return "";
  let text = "";
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const code = parseInt(clean.slice(i, i + 4), 16);
    if (code) text += String.fromCharCode(code);
  }
  return text;
}

function decodePdfHexWithMap(clean, map) {
  const keys = [...map.keys()];
  if (!keys.length) return "";
  const widths = [...new Set(keys.map(key => key.length))].sort((a, b) => b - a);
  let output = "";
  let index = 0;

  while (index < clean.length) {
    let matched = false;
    for (const width of widths) {
      const chunk = clean.slice(index, index + width).toUpperCase();
      if (chunk.length !== width) continue;
      if (map.has(chunk)) {
        output += map.get(chunk);
        index += width;
        matched = true;
        break;
      }
    }
    if (!matched) {
      output += clean.slice(index, index + 2).match(/../) ? Buffer.from(clean.slice(index, index + 2), "hex").toString("latin1") : "";
      index += 2;
    }
  }

  return output;
}

function scorePdfDecodedText(text) {
  if (!text) return 0;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const spaces = (text.match(/\s/g) || []).length;
  const controls = (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
  return letters * 2 + spaces - controls * 4;
}

function decodePdfHex(hex, unicodeMaps = []) {
  const clean = hex.replace(/\s+/g, "");
  if (!clean) return "";
  let bestMapped = "";
  let bestScore = -Infinity;
  for (const map of unicodeMaps) {
    const candidate = decodePdfHexWithMap(clean, map);
    const score = scorePdfDecodedText(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestMapped = candidate;
    }
  }
  if (bestMapped) return bestMapped;
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2).padEnd(2, "0"), 16));
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    let text = "";
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      text += String.fromCharCode(buffer.readUInt16BE(i));
    }
    return text;
  }
  return buffer.toString("latin1");
}

function looksReadable(text) {
  if (!text || text.length < 20) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const controls = (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
  return letters / text.length > 0.35 && controls < 3;
}

function readDocxDocumentXml(buffer) {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const maxSearch = Math.max(0, buffer.length - 65557);

  let eocd = -1;
  for (let i = buffer.length - 22; i >= maxSearch; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return "";

  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let offset = centralOffset;
  const end = centralOffset + centralSize;

  while (offset < end && buffer.readUInt32LE(offset) === centralSignature) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    if (name === "word/document.xml" && buffer.readUInt32LE(localOffset) === localSignature) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(compressed).toString("utf8");
      return "";
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return "";
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter(word => word.length > 2);
}

function shingles(words, size = 5) {
  const set = new Set();
  for (let i = 0; i <= words.length - size; i += 1) {
    set.add(words.slice(i, i + size).join(" "));
  }
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function vectorize(words) {
  const vector = new Map();
  for (const word of words) {
    vector.set(word, (vector.get(word) || 0) + 1);
  }
  return vector;
}

function cosine(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const value of a.values()) aNorm += value * value;
  for (const value of b.values()) bNorm += value * value;
  for (const [key, value] of a) dot += value * (b.get(key) || 0);
  if (!aNorm || !bNorm) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function similarityAnalysis(text) {
  const words = tokenize(text);
  const sourceMatches = INTERNAL_SOURCES.map(source => {
    const userShingles = shingles(words);
    const sourceWords = tokenize(source.text);
    const lexical = jaccard(userShingles, shingles(sourceWords));
    const semantic = cosine(vectorize(words), vectorize(sourceWords));
    const score = Math.round(Math.max(lexical * 100, semantic * 72));
    return { ...source, score, lexical: Math.round(lexical * 100), semantic: Math.round(semantic * 100) };
  })
    .filter(match => match.score >= 8)
    .sort((a, b) => b.score - a.score);

  const segments = [];
  const sentences = splitSentences(text);
  sentences.forEach((sentence, index) => {
    const sentenceWords = tokenize(sentence);
    if (sentenceWords.length < 6) return;
    let best = null;
    for (const source of INTERNAL_SOURCES) {
      const semantic = cosine(vectorize(sentenceWords), vectorize(tokenize(source.text)));
      const lexical = jaccard(shingles(sentenceWords, Math.min(4, sentenceWords.length)), shingles(tokenize(source.text), 4));
      const score = Math.round(Math.max(semantic * 86, lexical * 100));
      if (!best || score > best.score) best = { source, score };
    }
    if (best && best.score >= 18) {
      segments.push({
        id: `seg_${index + 1}`,
        matchedText: sentence,
        sourceTitle: best.source.title,
        sourceUrl: best.source.url,
        score: best.score,
        type: best.score >= 55 ? "high" : best.score >= 32 ? "medium" : "low"
      });
    }
  });

  const overall = sourceMatches.length
    ? Math.min(98, Math.round(sourceMatches.reduce((sum, match) => sum + match.score, 0) / Math.max(1, sourceMatches.length) + segments.length * 4))
    : 0;

  return { overall, sourceMatches, segments };
}

function writingFeedback(text) {
  const sentences = splitSentences(text);
  const words = tokenize(text);
  const avgSentence = sentences.length ? Math.round(words.length / sentences.length) : 0;
  const passiveHits = (text.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi) || []).length;
  const vagueWords = ["things", "stuff", "very", "really", "many", "good", "bad", "important"];
  const vagueHits = vagueWords.filter(word => new RegExp(`\\b${word}\\b`, "i").test(text));
  const longSentences = sentences.filter(sentence => tokenize(sentence).length > 28);

  const suggestions = [];
  if (avgSentence > 24) suggestions.push({ category: "Clarity", message: "Several sentences are long. Split dense ideas into shorter academic claims.", severity: "medium" });
  if (passiveHits > 1) suggestions.push({ category: "Style", message: "Passive constructions appear often. Use active verbs where the actor matters.", severity: "low" });
  if (vagueHits.length) suggestions.push({ category: "Precision", message: `Replace vague wording such as ${vagueHits.slice(0, 4).join(", ")} with specific academic terms.`, severity: "medium" });
  if (!/\btherefore|however|because|although|for example|in contrast\b/i.test(text)) {
    suggestions.push({ category: "Flow", message: "Add transition language to show how evidence supports the argument.", severity: "low" });
  }
  if (words.length < 120) suggestions.push({ category: "Development", message: "The draft is short for a full submission. Add evidence, explanation, and source integration.", severity: "medium" });
  if (!suggestions.length) suggestions.push({ category: "Strength", message: "The draft is readable and focused. Tighten source integration and keep claims evidence-based.", severity: "low" });

  const readability = Math.max(35, Math.min(98, 92 - Math.max(0, avgSentence - 18) * 2 - passiveHits * 2));
  return {
    readability,
    avgSentenceLength: avgSentence,
    passiveConstructions: passiveHits,
    longSentenceCount: longSentences.length,
    suggestions
  };
}

function citationAnalysis(text) {
  const apa = (text.match(/\([A-Z][A-Za-z-]+,\s?\d{4}\)/g) || []).length;
  const mla = (text.match(/\([A-Z][A-Za-z-]+\s+\d+\)/g) || []).length;
  const chicagoNotes = (text.match(/(?:^|\n)\s*\d+\.\s+[A-Z][A-Za-z-]+,\s+[^.\n]+(?:\.\s|\n)/g) || []).length;
  const chicagoAuthorDate = (text.match(/\([A-Z][A-Za-z-]+\s+\d{4},\s*\d+\)/g) || []).length;
  const chicago = chicagoNotes + chicagoAuthorDate;
  const urls = (text.match(/https?:\/\/\S+/g) || []).length;
  const bibliography = /\b(references|works cited|bibliography|notes|endnotes)\b/i.test(text);
  const quoted = (text.match(/"[^"]{12,}"/g) || []).length;
  const issues = [];

  if (!apa && !mla && !chicago && !urls) issues.push("No recognizable in-text citations were found.");
  if ((apa || mla || urls) && !bibliography) issues.push("A references, works cited, or bibliography section is missing.");
  if (chicago && !bibliography) issues.push("Chicago-style notes should include notes, endnotes, or a bibliography section.");
  if (quoted && !apa && !mla) issues.push("Quoted material should include a nearby citation.");
  if ([apa > 0, mla > 0, chicago > 0].filter(Boolean).length > 1) issues.push("Mixed citation styles detected. Use APA, MLA, or Chicago consistently.");

  return {
    styleGuess: apa > mla && apa > chicago ? "APA-like" : mla > apa && mla > chicago ? "MLA-like" : chicago ? "Chicago-like" : urls ? "Web references" : "Unknown",
    inTextCitationCount: apa + mla + chicago + urls,
    styleSignals: { apa, mla, chicago, web: urls },
    bibliographyFound: bibliography,
    quotedPassages: quoted,
    issues,
    suggestions: issues.length
      ? issues.map(issue => ({ message: issue }))
      : [{ message: "Citation structure looks consistent in this draft. Verify every source against the required style guide." }]
  };
}

function aiContentDetection(text) {
  const words = tokenize(text);
  const sentences = splitSentences(text);
  const uniqueRatio = words.length ? new Set(words).size / words.length : 0;
  const transitionDensity = (text.match(/\b(furthermore|moreover|in conclusion|overall|additionally|therefore|consequently)\b/gi) || []).length / Math.max(1, sentences.length);
  const hedgeDensity = (text.match(/\b(may|might|can|could|often|generally|significant|important)\b/gi) || []).length / Math.max(1, words.length);
  const sentenceLengths = sentences.map(sentence => tokenize(sentence).length);
  const avg = sentenceLengths.reduce((sum, n) => sum + n, 0) / Math.max(1, sentenceLengths.length);
  const variance = sentenceLengths.reduce((sum, n) => sum + Math.pow(n - avg, 2), 0) / Math.max(1, sentenceLengths.length);
  const uniformity = Math.max(0, 1 - Math.sqrt(variance) / Math.max(1, avg));
  const probability = Math.round(Math.max(2, Math.min(96, (1 - uniqueRatio) * 42 + transitionDensity * 24 + hedgeDensity * 180 + uniformity * 28)));

  return {
    probability,
    label: probability >= 70 ? "Likely AI-assisted" : probability >= 40 ? "Mixed or inconclusive" : "Likely human-written",
    signals: [
      `Vocabulary uniqueness: ${Math.round(uniqueRatio * 100)}%`,
      `Sentence uniformity: ${Math.round(uniformity * 100)}%`,
      `Formulaic transition density: ${Math.round(transitionDensity * 100)}%`
    ],
    disclaimer: "This is a heuristic demo signal, not a disciplinary determination."
  };
}

function generateReport({ text, filename, userId }) {
  const similarity = similarityAnalysis(text);
  const writing = writingFeedback(text);
  const citations = citationAnalysis(text);
  const aiContent = aiContentDetection(text);
  const integrityScore = Math.max(1, Math.round(100 - similarity.overall * 0.45 - aiContent.probability * 0.25 - citations.issues.length * 6));

  return {
    id: `rep_${crypto.randomUUID()}`,
    filename,
    userId,
    createdAt: new Date().toISOString(),
    wordCount: tokenize(text).length,
    extractedText: text,
    similarity,
    writing,
    citations,
    aiContent,
    integrityScore,
    status: "complete"
  };
}

function safeUploadName(filename) {
  const base = path.basename(filename || "submission.txt").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${Date.now()}_${base}`;
}

async function registerUser(payload) {
  const existing = await findUserByEmail(payload.email);
  if (existing) {
    const error = new Error("This email is already registered. Please login.");
    error.statusCode = 409;
    throw error;
  }
  if (!payload.password || String(payload.password).length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }
  const user = {
    id: `usr_${crypto.randomUUID()}`,
    name: payload.name || "Demo User",
    role: payload.role || "student",
    email: payload.email || `demo-${Date.now()}@example.edu`,
    createdAt: new Date().toISOString(),
    ...createPasswordFields(payload.password)
  };
  await saveUser(user);
  return publicUser(user);
}

async function loginUser(payload) {
  const existing = await findUserByEmail(payload.email);
  if (!existing) {
    const error = new Error("Account not found. Please register first.");
    error.statusCode = 404;
    throw error;
  }
  if (!payload.password) throw new Error("Password is required.");
  if (!existing.passwordHash) {
    const updated = {
      ...existing,
      name: existing.name || payload.name || "Demo User",
      role: existing.role || payload.role || "student",
      updatedAt: new Date().toISOString(),
      ...createPasswordFields(payload.password)
    };
    await saveUser(updated);
    return publicUser(updated);
  }
  if (!verifyPassword(payload.password, existing)) {
    const error = new Error("Invalid email or password.");
    error.statusCode = 401;
    throw error;
  }
  return publicUser(existing);
}

async function handleUpload(req, res) {
  const body = await collectBody(req);
  const parts = parseMultipart(body, req.headers["content-type"]);
  const file = parts.find(part => part.name === "document" && part.filename);
  if (!file) return sendJson(res, 400, { error: "Upload a document field named 'document'." });

  const userId = parts.find(part => part.name === "userId")?.data.toString("utf8") || "demo-student";
  const storedName = safeUploadName(file.filename);
  const storedPath = path.join(UPLOAD_DIR, storedName);
  fs.writeFileSync(storedPath, file.data);

  const extractedText = extractText(file.data, file.filename, file.type);
  if (!extractedText || extractedText.length < 20) {
    return sendJson(res, 422, {
      error: "PDF text extraction failed. If this is a scanned/image PDF, run OCR first or upload a text-based PDF, DOCX, or TXT file."
    });
  }

  const report = generateReport({ text: extractedText, filename: file.filename, userId });
  const submission = {
    id: `sub_${crypto.randomUUID()}`,
    userId,
    filePath: storedPath,
    filename: file.filename,
    timestamp: report.createdAt,
    reportId: report.id,
    status: "complete"
  };
  await saveSubmissionAndReport(submission, report);

  return sendJson(res, 201, { submission, report });
}

async function routeApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/auth/register") {
      const user = await registerUser(parseJson(await collectBody(req)));
      return sendJson(res, 201, { user, token: `demo-token-${user.id}` });
    }
    if (req.method === "POST" && url.pathname === "/auth/login") {
      const payload = parseJson(await collectBody(req));
      const user = await loginUser(payload);
      return sendJson(res, 200, { user, token: `demo-token-${user.id}` });
    }
    if (req.method === "POST" && url.pathname === "/upload/document") return handleUpload(req, res);
    if (req.method === "POST" && url.pathname === "/ocr/extract") {
      const payload = parseJson(await collectBody(req));
      return sendJson(res, 200, { text: normalizeText(payload.text || ""), engine: "demo-ocr-text-normalizer" });
    }
    if (req.method === "POST" && url.pathname === "/similarity/check") {
      const payload = parseJson(await collectBody(req));
      return sendJson(res, 200, similarityAnalysis(payload.text || ""));
    }
    if (req.method === "POST" && url.pathname === "/feedback/generate") {
      const payload = parseJson(await collectBody(req));
      return sendJson(res, 200, writingFeedback(payload.text || ""));
    }
    if (req.method === "POST" && url.pathname === "/citations/check") {
      const payload = parseJson(await collectBody(req));
      return sendJson(res, 200, citationAnalysis(payload.text || ""));
    }
    if (req.method === "POST" && url.pathname === "/aicontent/detect") {
      const payload = parseJson(await collectBody(req));
      return sendJson(res, 200, aiContentDetection(payload.text || ""));
    }
    if (req.method === "POST" && url.pathname === "/analysis/full") {
      const payload = parseJson(await collectBody(req));
      const text = normalizeText(payload.text || "");
      if (text.length < 20) {
        return sendJson(res, 422, { error: "Enter at least 20 characters for real-time analysis." });
      }
      const filename = payload.filename || "realtime-draft.txt";
      const userId = payload.userId || "realtime-user";
      const persist = payload.persist === true;
      const report = generateReport({
        text,
        filename,
        userId
      });
      if (persist) {
        const submission = buildRealtimeSubmission(report, userId, filename);
        await saveSubmissionAndReport(submission, report);
        return sendJson(res, 200, { submission, report, persisted: true });
      }
      return sendJson(res, 200, report);
    }
    if (req.method === "GET" && url.pathname === "/storage/status") {
      return sendJson(res, 200, getStorageStatus(await storageCounts()));
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        app: "IntegrityAI Studio",
        time: new Date().toISOString(),
        storage: getStorageStatus(await storageCounts()),
        features: {
          upload: true,
          realtimeAnalysis: true,
          plagiarismDetection: true,
          semanticSimilarity: true,
          writingFeedback: true,
          citationCheck: true,
          aiContentDetection: true,
          teacherDashboard: true,
          studentHistory: true,
          mongodb: storageMode === "mongodb"
        }
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/report/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const report = await getReportById(id);
      return report ? sendJson(res, 200, report) : notFound(res);
    }
    if (req.method === "GET" && url.pathname === "/teacher/submissions") {
      const userId = url.searchParams.get("userId") || "";
      const submissions = await listSubmissionsWithReports(userId);
      return sendJson(res, 200, { submissions });
    }
    if (req.method === "GET" && url.pathname === "/teacher/summary") {
      const userId = url.searchParams.get("userId") || "";
      const submissions = await listSubmissionsWithReports(userId);
      return sendJson(res, 200, { summary: buildSubmissionSummary(submissions) });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/submission/")) {
      const submissionId = decodeURIComponent(url.pathname.split("/").pop());
      const removed = await deleteSubmissionCascade(submissionId);
      if (!removed) return notFound(res);
      return sendJson(res, 200, { ok: true, deletedSubmissionId: submissionId });
    }
    return notFound(res);
  } catch (error) {
    return sendJson(res, error.statusCode || (error.message.includes("large") ? 413 : 500), { error: error.message });
  }
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);

  fs.readFile(filePath, (error, data) => {
    if (error) return notFound(res);
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/auth/") || [
      "/upload/document",
      "/ocr/extract",
      "/similarity/check",
      "/feedback/generate",
      "/citations/check",
      "/aicontent/detect",
      "/analysis/full",
      "/storage/status",
      "/health",
      "/teacher/submissions",
      "/teacher/summary"
    ].includes(url.pathname) || url.pathname.startsWith("/report/") || url.pathname.startsWith("/submission/")) {
      return routeApi(req, res, url);
    }
    return serveStatic(req, res, url);
  });

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the old server with Ctrl+C, or run this app on another port with PORT=3010 npm start.`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

initStorage()
  .catch(error => {
    console.log(`Storage initialization warning: ${error.message}`);
    if (REQUIRE_MONGODB) {
      process.exit(1);
    }
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`Integrity AI Checker running at http://localhost:${PORT}`);
    });
  });
