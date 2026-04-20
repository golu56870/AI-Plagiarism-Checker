# IntegrityAI Studio

Turnitin-style plagiarism checker and AI writing feedback web app prototype with a local Node.js backend and browser frontend.

## Run

Use either command from this folder:

```powershell
npm install
npm start
```

or double-click/run:

```powershell
.\start.bat
```

Then open:

```text
http://localhost:3000
```

If an old server is already running on port 3000, stop it with `Ctrl+C` in that terminal. If you cannot find that terminal, run:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process
```

Then start again:

```powershell
npm start
```

## Included Functions

- Plagiarism detection with n-gram overlap and semantic-style cosine matching
- Similarity heatmap and matched source report
- AI writing feedback for clarity, style, precision, flow, and development
- Citation checking for APA-like, MLA-like, bibliography, quotes, and consistency signals
- Chicago-like citation signals for notes, endnotes, and author-date references
- AI-generated content probability using heuristic writing-pattern signals
- PDF, DOCX, and TXT upload route with local text extraction fallback
- OCR endpoint placeholder for extracted text normalization
- Student submission history stored in MongoDB when configured, with JSON fallback
- Teacher dashboard with filters and report drill-down
- Downloadable report through the browser print/PDF action

## API Routes

```text
POST /auth/register
POST /auth/login
POST /upload/document
POST /ocr/extract
POST /similarity/check
POST /feedback/generate
POST /citations/check
POST /aicontent/detect
POST /analysis/full
GET /report/{id}
GET /teacher/submissions
GET /teacher/summary
DELETE /submission/{id}
GET /storage/status
GET /health
```

## MongoDB Setup

1. Install dependencies:

```powershell
npm install
```

2. Create a `.env` file in this project folder:

```text
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=ai_plagiarism_checker
USE_MONGODB=true
REQUIRE_MONGODB=false
MAX_UPLOAD_MB=100
PORT=3000
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=Admin@12345
ADMIN_NAME=Project Admin
```

For MongoDB Atlas, replace `MONGODB_URI` with your Atlas connection string.

If you want the app to refuse JSON fallback and only start when MongoDB is available, set:

```text
REQUIRE_MONGODB=true
```

3. Start the app:

```powershell
npm start
```

4. Check storage status:

```text
http://localhost:3000/storage/status
```

The storage status response now shows whether MongoDB is connected, the selected database, the sanitized URI, document counts, and the fallback reason when JSON mode is active.

`MAX_UPLOAD_MB` controls the per-file upload size limit. The app does not enforce a per-user file count limit, so a user can upload as many files as needed.

5. If you already have old demo data in `data/db.json`, migrate it into MongoDB:

```powershell
npm run migrate:mongo
```

MongoDB collections used:

```text
users
submissions
reports
extracted_texts
similarity_segments
```

This project uses a separate MongoDB database named `ai_plagiarism_checker`. Do not set `MONGODB_DB` to your pharmacy database. If a pharmacy-like database name is accidentally used, the backend switches back to `ai_plagiarism_checker`.

## Default Admin Login

```text
Email: admin@example.com
Password: Admin@12345
Role: admin
```

Change these values in `.env` before deployment.

## Production Upgrade Notes

The current engines are local demo implementations so the project can run without paid APIs or package installation. For a production system, keep the same routes and replace the internal functions in `server.js` with:

- SBERT/BERT/Llama embeddings plus FAISS/Pinecone for semantic similarity
- Tesseract, Google Vision, or Azure OCR for scanned PDFs
- GPT/Claude/Llama provider calls for deeper writing feedback
- Crossref/DOI/library metadata checks for citation verification
- Institutional repository connectors for private source matching
