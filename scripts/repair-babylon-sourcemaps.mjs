import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Some interrupted Windows npm installs leave truncated Babylon source maps.
// Only the optional debugger maps are removed; runtime JavaScript is untouched.
const root = "node_modules/@babylonjs/core";
const known = ["Collisions/gpuPicker.js.map"];
for (const name of known) {
  const path = join(root, name);
  if (!existsSync(path)) continue;
  try {
    const map = JSON.parse(readFileSync(path, "utf8"));
    if (map.version === 3 && typeof map.mappings === "string") continue;
  } catch { /* truncated or malformed map */ }
  unlinkSync(path);
  const javascript = path.slice(0, -4);
  if (existsSync(javascript)) {
    const source = readFileSync(javascript, "utf8");
    writeFileSync(javascript, source.replace(
      /^\/\/# sourceMappingURL=gpuPicker\.js\.map\s*$/gm, "",
    ));
  }
  process.stdout.write("Recovered malformed optional Babylon.js source map: " + name + "\n");
}
