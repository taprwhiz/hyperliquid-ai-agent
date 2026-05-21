import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const DIARY_PATH = "diary.jsonl";

export function createApiApp(): Hono {
  const app = new Hono();

  app.get("/diary", (c) => {
    try {
      const raw = c.req.query("raw");
      const download = c.req.query("download");
      if (raw || download) {
        if (!existsSync(DIARY_PATH)) return c.text("");
        const data = readFileSync(DIARY_PATH, "utf8");
        if (download) {
          c.header("Content-Disposition", "attachment; filename=diary.jsonl");
        }
        return c.text(data);
      }
      const limit = Number(c.req.query("limit") ?? "200");
      if (!existsSync(DIARY_PATH)) return c.json({ entries: [] });
      const lines = readFileSync(DIARY_PATH, "utf8").split("\n").filter(Boolean);
      const entries = lines.slice(Math.max(0, lines.length - limit)).map((line) => JSON.parse(line));
      return c.json({ entries });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get("/logs", (c) => {
    try {
      const path = c.req.query("path") ?? "llm_requests.log";
      const download = c.req.query("download");
      const limitParam = c.req.query("limit");
      if (!existsSync(path)) return c.text("");
      const data = readFileSync(path, "utf8");
      if (download || limitParam?.toLowerCase() === "all" || limitParam === "-1") {
        if (download) {
          c.header("Content-Disposition", `attachment; filename=${basename(path)}`);
        }
        return c.text(data);
      }
      const limit = limitParam ? Number(limitParam) : 2000;
      return c.text(data.slice(-limit));
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}
