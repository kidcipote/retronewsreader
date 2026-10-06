// Copies the page into public/ (the folder the Worker serves), the same files cloud/deploy.sh used to copy. Run by `npm run build`.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
const files = ["index.html", "app.js", "chat.js", "paper.js", "sw.js", "catalog.json", "taxonomy.json", "manifest.webmanifest", "privacy.html", "terms.html", "ai.html", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
mkdirSync("public/fonts", { recursive: true });
for (const f of files) copyFileSync(f, `public/${f}`);
for (const f of readdirSync("fonts")) copyFileSync(`fonts/${f}`, `public/fonts/${f}`);
console.log(`built public/: ${files.length} page files and the fonts`);
