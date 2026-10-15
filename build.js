// يجمع الواجهة في ملف HTML واحد (وضع العرض بدون خادم): dist/halaqati.html
const fs = require("fs");
const path = require("path");

const pub = (f) => fs.readFileSync(path.join(__dirname, "public", f), "utf8");
const favicon = "data:image/svg+xml," + encodeURIComponent(pub("favicon.svg").trim());

// شعار المدرسة (اختياري): يُضمَّن داخل الملف إن وُجد
const logoPath = path.join(__dirname, "public", "logo.png");
const logo = fs.existsSync(logoPath) ? "data:image/png;base64," + fs.readFileSync(logoPath).toString("base64") : null;

let html = pub("index.html")
  .replace('href="favicon.svg"', `href="${favicon}"`)
  .replace('<link rel="stylesheet" href="/styles.css">', () => `<style>\n${pub("styles.css")}</style>`)
  .replace(
    '<script src="/app.js"></script>',
    () => `<script>window.HALAQATI_DEMO = true;</script>\n  <script>\n${pub("app.js").replace(/<\/script/gi, "<\\/script")}</script>`
  );

if (logo) html = html.replaceAll('src="logo.png"', `src="${logo}"`);

if (html.includes('href="/styles.css"') || html.includes('src="/app.js"')) {
  throw new Error("لم يتم دمج كل الملفات");
}
fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "halaqati.html"), html);
console.log(`dist/halaqati.html (${(html.length / 1024).toFixed(1)} KB)`);
