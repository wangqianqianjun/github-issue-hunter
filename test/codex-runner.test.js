import { describe, expect, it } from "vitest";
import { parseJsonFromOutput } from "../src/core/codex-runner.js";
describe("parseJsonFromOutput", () => {
    it("parses raw json", () => {
        expect(parseJsonFromOutput('{"needs_processing": true}').needs_processing).toBe(true);
    });
    it("parses fenced json", () => {
        const payload = parseJsonFromOutput('before\n```json\n{"summary":"ok"}\n```');
        expect(payload.summary).toBe("ok");
    });
    it("throws for invalid output", () => {
        expect(() => parseJsonFromOutput("invalid")).toThrowError();
    });
});
