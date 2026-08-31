import { describe, expect, test } from "bun:test";
import { hasUnsafeShellSyntax, isReadonlyCommand } from "./utils.js";

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
