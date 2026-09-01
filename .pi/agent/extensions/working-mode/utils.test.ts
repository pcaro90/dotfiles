import { describe, expect, test } from "bun:test";
import {
	hasUnsafeShellSyntax,
	isReadonlyCommand,
	isSafeSedCommand,
	sandboxSedCommand,
	splitIntoSubcommands,
} from "./utils.js";

describe("safe output redirections", () => {
	test.each([
		"head -60 /tmp/example >/dev/null 2>&1",
		"head -60 /tmp/example 2>&1",
		"go version 2>/dev/null",
		"caddy version 2>/dev/null",
		"docker version --format '{{.Server.Version}}' 2>/dev/null",
	])("allows %s", (command) => {
		expect(hasUnsafeShellSyntax(command)).toBe(false);
		expect(isReadonlyCommand(command)).toBe(true);
	});

	test.each([
		"head -60 /tmp/example >/tmp/output 2>&1",
		"head -60 /tmp/example 2>&1 >/tmp/output",
		"go version >version.txt",
	])("still rejects file output: %s", (command) => {
		expect(hasUnsafeShellSyntax(command)).toBe(true);
		expect(isReadonlyCommand(command)).toBe(false);
	});
});

describe("shell control structures", () => {
	test("classifies harmless for-loop clauses and body commands as read-only", () => {
		const command =
			'for k in server_name database_path port; do echo "### $k"; grep -n "^#\\?$k =" example.toml; done';
		const subCommands = splitIntoSubcommands(command).map(({ command }) => command);

		expect(subCommands).toEqual([
			"for k in server_name database_path port",
			'do echo "### $k"',
			'grep -n "^#\\?$k =" example.toml',
			"done",
		]);
		expect(subCommands.every(isReadonlyCommand)).toBe(true);
	});

	test.each([
		"if grep -q needle file; then echo yes; else printf no; fi",
		"while test -f marker; do sleep 1; done",
		"cat file | while IFS= read -r line; do printf '%s\\n' \"$line\"; done",
		"until git status --porcelain; do echo waiting; done",
	])("classifies safe conditional and loop commands: %s", (command) => {
		const subCommands = splitIntoSubcommands(command).map(({ command }) => command);
		expect(subCommands.every(isReadonlyCommand)).toBe(true);
	});

	test("does not recursively split command substitutions and rejects them", () => {
		const subCommands = splitIntoSubcommands("for k in $(printf value); do echo $k; done");
		expect(subCommands[0]?.command).toBe("for k in $(printf value)");
		expect(hasUnsafeShellSyntax(subCommands[0]!.command)).toBe(true);
		expect(isReadonlyCommand(subCommands[0]!.command)).toBe(false);
	});

	test.each([
		"for k in $(touch /tmp/pwn)",
		"if rm -f file",
		"while echo hello > output.txt",
		"do rm -f file",
		"then echo hello > output.txt",
	])("does not let unsafe control fragments bypass classification: %s", (command) => {
		expect(isReadonlyCommand(command)).toBe(false);
	});

	test("preserves sed sandboxing after control words", () => {
		expect(isSafeSedCommand("do sed -n '1p' file")).toBe(true);
		expect(sandboxSedCommand("do sed -n '1p' file")).toBe("do sed --sandbox -n '1p' file");
		expect(sandboxSedCommand("then sed -n '1p' file")).toBe("then sed --sandbox -n '1p' file");
	});
});

describe("version commands", () => {
	test.each([
		"go version",
		"caddy version",
		"docker version",
		"docker version -f '{{.Client.Version}}'",
		"docker version --format=json",
	])("allows %s", (command) => {
		expect(isReadonlyCommand(command)).toBe(true);
	});

	test.each([
		"caddy version --unknown",
		"docker version --unknown",
		"docker run --version",
	])("does not broaden version matching: %s", (command) => {
		expect(isReadonlyCommand(command)).toBe(false);
	});
});
