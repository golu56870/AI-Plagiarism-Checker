const fs = require("fs");
const path = require("path");

let MongoClient = null;
try {
  ({ MongoClient } = require("mongodb"));
} catch {
  MongoClient = null;
}

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const DB_FILE = path.join(ROOT, "data", "db.json");

loadEnvFile();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const REQUESTED_MONGODB_DB = process.env.MONGODB_DB || "ai_plagiarism_checker";
const MONGODB_DB = /pharma/i.test(REQUESTED_MONGODB_DB) ? "ai_plagiarism_checker" : REQUESTED_MONGODB_DB;

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

function readJsonDb() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: [], submissions: [], reports: [] };
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

async function upsertMany(collection, docs, key = "id") {
  if (!docs.length) return 0;
  let count = 0;
  for (const doc of docs) {
    const filterValue = doc[key];
    if (!filterValue) continue;
    await collection.updateOne({ [key]: filterValue }, { $set: doc }, { upsert: true });
    count += 1;
  }
  return count;
}

async function main() {
  if (!MongoClient) {
    throw new Error("mongodb package is not installed. Run npm install first.");
  }

  const jsonDb = readJsonDb();
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("submissions").createIndex({ id: 1 }, { unique: true });
    await db.collection("reports").createIndex({ id: 1 }, { unique: true });
    await db.collection("extracted_texts").createIndex({ submissionId: 1 }, { unique: true });
    await db.collection("similarity_segments").createIndex({ submissionId: 1 });

    const users = jsonDb.users.map(user => ({
      ...user,
      emailLower: String(user.email || "").toLowerCase()
    }));
    const submissions = jsonDb.submissions || [];
    const reports = jsonDb.reports || [];
    const extractedTexts = reports.map(report => ({
      submissionId: submissions.find(submission => submission.reportId === report.id)?.id || `sub_missing_${report.id}`,
      reportId: report.id,
      content: report.extractedText || "",
      createdAt: report.createdAt || new Date().toISOString()
    }));
    const similaritySegments = reports.flatMap(report => {
      const submissionId = submissions.find(submission => submission.reportId === report.id)?.id || null;
      return (report.similarity?.segments || []).map(segment => ({
        ...segment,
        submissionId,
        reportId: report.id,
        createdAt: report.createdAt || new Date().toISOString()
      }));
    }).filter(segment => segment.submissionId);

    const migratedUsers = await upsertMany(db.collection("users"), users);
    const migratedSubmissions = await upsertMany(db.collection("submissions"), submissions);
    const migratedReports = await upsertMany(db.collection("reports"), reports);
    const migratedExtractedTexts = await upsertMany(db.collection("extracted_texts"), extractedTexts, "submissionId");

    if (similaritySegments.length) {
      const submissionIds = [...new Set(similaritySegments.map(segment => segment.submissionId))];
      await db.collection("similarity_segments").deleteMany({ submissionId: { $in: submissionIds } });
      await db.collection("similarity_segments").insertMany(similaritySegments);
    }

    console.log(`MongoDB migration complete for database "${MONGODB_DB}".`);
    console.log(`Users migrated: ${migratedUsers}`);
    console.log(`Submissions migrated: ${migratedSubmissions}`);
    console.log(`Reports migrated: ${migratedReports}`);
    console.log(`Extracted texts migrated: ${migratedExtractedTexts}`);
    console.log(`Similarity segments migrated: ${similaritySegments.length}`);
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
