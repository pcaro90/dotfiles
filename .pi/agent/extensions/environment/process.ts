import { spawn } from "node:child_process";
import { constants } from "node:os";

export interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string | Buffer;
	signal?: AbortSignal;
	timeout?: number;
	onData?: (data: Buffer) => void;
}
export interface RunResult { stdout: Buffer; stderr: Buffer; exitCode: number }
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** A fresh process group per operation. Cancellation never falls back to another backend. */
export function runProcess(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) { reject(new Error("aborted")); return; }
		const child = spawn(program, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [], stderr: Buffer[] = [];
		let timedOut = false;
		const stop = () => {
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		};
		const timer = options.timeout && options.timeout > 0 ? setTimeout(() => { timedOut = true; stop(); }, options.timeout * 1000) : undefined;
		const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", stop); };
		options.signal?.addEventListener("abort", stop, { once: true });
		// Cover an abort between the initial check and listener registration.
		if (options.signal?.aborted) stop();
		child.stdout.on("data", (data: Buffer) => { if (!options.onData) stdout.push(data); options.onData?.(data); });
		child.stderr.on("data", (data: Buffer) => { if (!options.onData) stderr.push(data); options.onData?.(data); });
		child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") stop(); });
		child.on("error", (error) => { cleanup(); reject(error); });
		child.on("close", (code, signal) => {
			cleanup();
			if (options.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
			else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 128 + (signal ? constants.signals[signal] ?? 1 : 1) });
		});
		child.stdin.end(options.input);
	});
}
export function checked(result: RunResult, context: string): Buffer {
	if (result.exitCode !== 0) throw new Error(`${context} (${result.exitCode}): ${result.stderr.toString().trim() || result.stdout.toString().trim() || "operation failed"}`);
	return result.stdout;
}
