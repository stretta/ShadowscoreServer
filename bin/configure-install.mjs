import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config.mjs";

function clone(value) {
  return structuredClone(value);
}

function mergeEditorRegistries(defaultEditors = [], localEditors = []) {
  const merged = new Map(defaultEditors.map((editor) => [editor.id, clone(editor)]));
  for (const editor of localEditors) {
    if (!editor?.id) continue;
    merged.set(editor.id, {
      ...(merged.get(editor.id) ?? {}),
      ...clone(editor)
    });
  }
  return [...merged.values()];
}

export function buildInstallConfig(templateConfig, localConfig, options) {
  const config = clone(localConfig ?? templateConfig);
  config.server ??= {};
  config.server.role = options.role;
  config.server.hostIdentity = options.hostIdentity;
  config.server.advertisedName = options.advertisedName;
  config.transport ??= {};
  config.transport.tempoAuthority = config.transport.tempoAuthority === "server" ? "server" : "link";
  config.transport.jack ??= {};
  config.transport.jack.enabled = options.role === "host" && options.jackTransport;
  config.transport.jack.host = options.hostIdentity;
  config.transport.jack.freshnessMs = Number(config.transport.jack.freshnessMs ?? 500);
  config.transport.jack.pollIntervalMs = Number(options.jackTransportIntervalMs ?? config.transport.jack.pollIntervalMs ?? 75);
  config.http ??= {};
  config.static ??= {};
  config.static.enabled = true;
  config.static.root ??= defaultConfig.static.root;
  config.static.index ??= defaultConfig.static.index;
  config.static.apps = {
    ...clone(defaultConfig.static.apps),
    ...(config.static.apps ?? {})
  };
  config.editors = mergeEditorRegistries(defaultConfig.editors, config.editors ?? []);
  config.registration ??= {};

  if (options.role === "host") {
    config.http.publicUrl = options.publicUrl;
    config.registration.sessionHostUrl = "";
  } else {
    config.http.publicUrl = "";
    config.registration.sessionHostUrl = options.sessionHostUrl;
    config.rnbo ??= {};
    config.rnbo.oscQuery ??= {};
    config.rnbo.oscQuery.oscHost ||= `${options.hostIdentity}.local`;
  }

  return config;
}

export function configureInstall({ templatePath, configPath, ...options }) {
  const templateConfig = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const localConfig = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : null;
  const config = buildInstallConfig(templateConfig, localConfig, options);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureInstall({
    templatePath: process.env.SHADOWSCORE_CONFIG_TEMPLATE_PATH,
    configPath: process.env.SHADOWSCORE_CONFIG_PATH,
    role: process.env.SHADOWSCORE_ROLE_VALUE,
    publicUrl: process.env.SHADOWSCORE_PUBLIC_URL_VALUE,
    sessionHostUrl: process.env.SHADOWSCORE_SESSION_HOST_URL_VALUE,
    hostIdentity: process.env.SHADOWSCORE_HOST_IDENTITY_VALUE,
    advertisedName: process.env.SHADOWSCORE_ADVERTISED_NAME_VALUE,
    jackTransport: process.env.SHADOWSCORE_JACK_TRANSPORT_VALUE === "1",
    jackTransportIntervalMs: process.env.SHADOWSCORE_JACK_TRANSPORT_INTERVAL_MS_VALUE
  });
}
