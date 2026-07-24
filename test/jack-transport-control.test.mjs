import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJackTransportController } from "../src/transport/jack-transport-control.mjs";

test("JACK transport controller requests tempo from the Link authority", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jack-control-"));
  const script = path.join(directory, "bridge.mjs");
  const output = path.join(directory, "args.json");
  await fs.writeFile(script, `
    import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));
  `);

  const controller = createJackTransportController({}, {
    python: process.execPath,
    script,
    cwd: directory
  });

  const result = await controller.tempo(132.5);
  const args = JSON.parse(await fs.readFile(output, "utf8"));

  assert.deepEqual(result, { ok: true, action: "tempo", bpm: 132.5 });
  assert.deepEqual(args, [
    "--client-name",
    "shadowscore-jack-control",
    "--control",
    "tempo",
    "--bpm",
    "132.5",
    "--tempo-request-client",
    "jack-transport-link"
  ]);
});

test("server tempo authority repositions JACK directly", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jack-control-"));
  const script = path.join(directory, "bridge.mjs");
  const output = path.join(directory, "args.json");
  await fs.writeFile(script, `
    import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));
  `);

  const controller = createJackTransportController({
    transport: { tempoAuthority: "server" }
  }, {
    python: process.execPath,
    script,
    cwd: directory
  });

  await controller.tempo(96);
  const args = JSON.parse(await fs.readFile(output, "utf8"));

  assert.deepEqual(args, [
    "--client-name",
    "shadowscore-jack-control",
    "--control",
    "tempo",
    "--bpm",
    "96"
  ]);
});
