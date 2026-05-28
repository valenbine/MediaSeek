import http from "http";
import url from "url";
import path from "path";
import fs from "fs";
import formidable from "formidable";
import { analyzeBeats } from "./src/backend.js";

const PORT = process.env.PORT || 3000;
const DIST_DIR = process.cwd();

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "MediaSeek service ready" }));
    return;
  }

  if (pathname === "/api/analyze" && req.method === "POST") {
    const form = formidable({
      maxFileSize: 100 * 1024 * 1024,
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: err.message }));
        return;
      }

      const file = files.file?.[0] || files.file;
      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "No audio file provided" }));
        return;
      }

      try {
        const result = await analyzeBeats(file.filepath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          ...result
        }));
      } catch (error) {
        console.error("Analysis error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: error.message }));
      }
    });
    return;
  }

  if (pathname.startsWith("/api/download/")) {
    const filename = pathname.replace("/api/download/", "");
    const filepath = path.join(DIST_DIR, "tmp", filename);

    if (!fs.existsSync(filepath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "File not found" }));
      return;
    }

    const ext = path.extname(filename);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    fs.createReadStream(filepath).pipe(res);
    return;
  }

  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(DIST_DIR, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        fs.readFile(path.join(DIST_DIR, "index.html"), (err2, content2) => {
          if (err2) {
            res.writeHead(404);
            res.end("Not Found");
          } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(content2);
          }
        });
      } else {
        res.writeHead(500);
        res.end("Server Error");
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`MediaSeek 寻音觅影 server running at http://localhost:${PORT}`);
});
