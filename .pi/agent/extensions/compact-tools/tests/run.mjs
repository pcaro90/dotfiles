import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use the installed Pi dependencies, just as its extension loader does. No npm install.
let packageDir = process.env.PI_PACKAGE_DIR || process.argv[2];
if (!packageDir) {
	try {
		packageDir = dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		throw new Error("Set PI_PACKAGE_DIR to your installed @earendil-works/pi-coding-agent directory (or pass it as the first argument).");
	}
}
packageDir = resolve(packageDir);
const require = createRequire(`${packageDir}/package.json`);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	interopDefault: false,
	alias: {
		"@earendil-works/pi-coding-agent": `${packageDir}/dist/index.js`,
		"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
	},
});
await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "compact-tools.test.ts"));
