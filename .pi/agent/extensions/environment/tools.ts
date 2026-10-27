import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
	type BashOperations, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { backendCapture, bubbleFailure, type Backend } from "./backends.js";
import { shellQuote as q } from "./process.js";

const proxyRoot = resolve(tmpdir(), `pi-environment-mutations-${process.pid}-${randomUUID()}`);
function proxyPath(backend: Backend, path: string): string {
	return resolve(proxyRoot, createHash("sha256").update(backend.key).update("\0").update(path).digest("hex"));
}
function replaceProxy<T>(value: T, proxy: string, original: string): T {
	if (typeof value === "string") return value.replaceAll(proxy, original) as T;
	if (Array.isArray(value)) return value.map((v) => replaceProxy(v, proxy, original)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceProxy(v, proxy, original)])) as T;
	return value;
}
export function bashOperations(backend: Backend, track: <T>(run: () => Promise<T>) => Promise<T> = (run) => run()): BashOperations {
	return {
		exec: (command, _cwd, { onData, signal, timeout, env }) => track(async () => {
			try {
				let tail = "";
				const result = await backend.run(command, {
					signal, timeout, env,
					onData: (data) => { tail = (tail + data.toString()).slice(-8192); onData(data); },
				});
				if (backend.key.startsWith("bubble:") && result.exitCode !== 0 && /Permission denied|Read-only file system|No such file or directory|bwrap:/i.test(tail)) {
					onData(Buffer.from("\n[Environment: this command ran inside the bubble. Paths may be hidden or read-only; missing files may also genuinely not exist. Ask the user with request_access if additional resources are needed. No host fallback was attempted.]\n"));
				}
				return { exitCode: result.exitCode };
			} catch (error) {
				if (backend.key.startsWith("bubble:")) throw bubbleFailure(error);
				throw error;
			}
		}),
	};
}

export interface ToolRouter {
	localRoot(): string;
	backend(): Backend;
	file(path: string, mutation: boolean): { backend: Backend; path: string };
	bash(command: string): Backend;
	track<T>(run: () => Promise<T>): Promise<T>;
}
type Run = (command: string, input?: string) => Promise<Buffer>;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];

/** Pi's own file tool, run on a hashed local proxy name; every real access goes through the routed backend. */
function registerFileTool(pi: ExtensionAPI, router: ToolRouter, create: (cwd: string, options?: any) => any, mutation: boolean, operations: (run: Run, path: string) => object): void {
	pi.registerTool({
		...create(router.localRoot()),
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			return router.track(async () => {
				const { backend, path } = router.file(params.path, mutation);
				backend.assertAccess?.(path, mutation);
				const proxy = proxyPath(backend, path);
				const tool = create("/", { operations: operations((command, input) => backendCapture(backend, command, { signal, input }), path) });
				// Pi's native path normalization probes the host filesystem too. Give it
				// only the virtual name; all actual access goes through the chosen backend.
				try { return replaceProxy(await tool.execute(id, { ...params, path: proxy }, signal, onUpdate, ctx), proxy, params.path); }
				catch (error) { if (error instanceof Error) error.message = error.message.replaceAll(proxy, params.path); throw error; }
			});
		},
	});
}

/** Keep Pi's schemas, exact-edit semantics, renderers, image support, output schemas, and mutation queues. */
export function registerEnvironmentTools(pi: ExtensionAPI, router: ToolRouter): void {
	const writeFile = (run: Run, path: string) => async (_path: string, content: string) => { await run(`cat > ${q(path)}`, content); };
	registerFileTool(pi, router, createReadToolDefinition, false, (run, path) => ({
		readFile: () => run(`cat -- ${q(path)}`),
		access: async () => { await run(`test -r ${q(path)}`); },
		detectImageMimeType: async () => {
			try {
				const mime = (await run(`file --mime-type -b -- ${q(path)}`)).toString().trim();
				return IMAGE_TYPES.includes(mime) ? mime : null;
			} catch { return null; }
		},
	}));
	registerFileTool(pi, router, createWriteToolDefinition, true, (run, path) => ({
		mkdir: async () => { await run(`mkdir -p -- ${q(dirname(path))}`); },
		writeFile: writeFile(run, path),
	}));
	registerFileTool(pi, router, createEditToolDefinition, true, (run, path) => ({
		readFile: () => run(`cat -- ${q(path)}`),
		access: async () => { await run(`test -r ${q(path)} && test -w ${q(path)}`); },
		writeFile: writeFile(run, path),
	}));
	pi.registerTool({
		...createBashToolDefinition(router.localRoot()),
		async execute(id, params, signal, onUpdate, ctx) {
			return router.track(async () => {
				const backend = router.bash(params.command);
				const tool = createBashToolDefinition(backend.cwd, { operations: bashOperations(backend) });
				return tool.execute(id, params, signal, onUpdate, ctx);
			});
		},
	});
}
