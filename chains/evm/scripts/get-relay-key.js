const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, "..", "..", "..", "apps", "web", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^HYPERLANE_RELAY_PRIVATE_KEY=(.*)$/);
  if (m) {
    process.stdout.write(m[1].replace(/^"|"$/g, ""));
    process.exit(0);
  }
}
console.error("HYPERLANE_RELAY_PRIVATE_KEY not found in apps/web/.env");
process.exit(1);
