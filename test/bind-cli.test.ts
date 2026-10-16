import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Real shell argument/environment handling, with a fake curl instead of any network request.
async function bind(args: string[], inherited: string, rc = 0) {
  const dir = mkdtempSync(join(tmpdir(), "tgb-cli-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/curl"), `#!/usr/bin/env bun
import {writeFileSync} from "fs";
const args = process.argv.slice(2);
writeFileSync(process.env.TG_TEST_PAYLOAD, args[args.indexOf("--data") + 1]);
console.log(JSON.stringify({ok:process.env.TG_TEST_RC === "0",error:"test rejection"}));
process.exit(Number(process.env.TG_TEST_RC));
`, { mode: 0o755 });
    const p = Bun.spawn(["sh", resolve(import.meta.dir, "../bin/tg-bind"), ...args], {
      env: { ...process.env, PATH: join(dir, "bin") + ":" + process.env.PATH, HERDR_PANE_ID: "pane", CODEX_THREAD_ID: inherited,
        TG_TEST_PAYLOAD: join(dir, "payload.json"), TG_TEST_RC: String(rc) }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { body: JSON.parse(readFileSync(join(dir, "payload.json"), "utf8")), out, err, code };
  } finally { rmSync(dir, { recursive: true }); }
}

test("tg-bind selects the caller's Codex identity, but does not attach it to an explicit Claude bind", async () => {
  expect((await bind([], "codex-id")).body).toEqual({ pane: "pane", kind: "codex", session: "codex-id", off: false });
  expect((await bind(["--kind", "claude"], "outer-codex-id")).body).toEqual({ pane: "pane", kind: "claude", off: false });
  expect((await bind(["--pane", "another pane", "--kind", "codex", "--session", "explicit-id"], "outer-id")).body)
    .toEqual({ pane: "another pane", kind: "codex", session: "explicit-id", off: false });
});
test("tg-bind preserves server rejection JSON and its failing exit status", async () => {
  const result = await bind([], "codex-id", 22);
  expect(result.code).toBe(22); expect(JSON.parse(result.out)).toEqual({ ok: false, error: "test rejection" });
  expect(result.out).not.toContain("cannot reach bridge");
});
