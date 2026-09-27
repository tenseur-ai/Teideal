import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildExportFormatDocument } from "../lib/exportSources.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../../../../docs/export-format.md");

await writeFile(target, buildExportFormatDocument(), "utf8");
console.log(`generated ${target}`);
