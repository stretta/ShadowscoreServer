import { adminPage } from "./admin-page.mjs";

export async function routeRequest(request, response, store, config) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      ensembleId: config.ensemble.id,
      version: store.getScore().version,
      rnbo: {
        enabled: config.rnbo.enabled,
        host: config.rnbo.host,
        port: config.rnbo.port
      }
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/score") {
    writeJson(response, 200, store.getScore());
    return;
  }

  if (request.method === "GET" && url.pathname === "/assignments") {
    writeJson(response, 200, store.getScore().assignments ?? {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin") {
    writeHtml(response, 200, adminPage());
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    openEventStream(request, response, store);
    return;
  }

  if (request.method === "POST" && url.pathname === "/context") {
    try {
      const body = await readJson(request);
      const replace = url.searchParams.get("replace") === "1";
      writeJson(response, 200, store.updateContext(body.context ?? body, { replace }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/reset") {
    try {
      const body = await readJson(request);
      writeJson(response, 200, store.reset({
        context: Boolean(body.context),
        voices: Boolean(body.voices),
        assignments: Boolean(body.assignments)
      }));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const assignmentMatch = url.pathname.match(/^\/voices\/([^/]+)\/assignment$/);
  if ((request.method === "POST" || request.method === "DELETE") && assignmentMatch) {
    try {
      const voiceId = decodeURIComponent(assignmentMatch[1]);
      const score =
        request.method === "DELETE"
          ? store.clearVoiceAssignment(voiceId)
          : store.replaceVoiceAssignment(voiceId, await readJson(request));
      writeJson(response, 200, score);
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  const voiceMatch = url.pathname.match(/^\/voices\/([^/]+)\/notes$/);
  if (request.method === "POST" && voiceMatch) {
    try {
      const voiceId = decodeURIComponent(voiceMatch[1]);
      const body = await readJson(request);
      writeJson(response, 200, store.replaceVoiceNotes(voiceId, body));
    } catch (error) {
      writeJson(response, 400, { ok: false, error: messageForError(error) });
    }
    return;
  }

  writeJson(response, 404, { ok: false, error: "not found" });
}

export function writeJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

export function writeHtml(response, status, html) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

export async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function openEventStream(request, response, store) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream"
  });

  writeEvent(response, "snapshot", {
    type: "snapshot",
    score: store.getScore()
  });

  const onChange = (event) => writeEvent(response, event.type, event);
  store.events.on("change", onChange);

  request.on("close", () => {
    store.events.off("change", onChange);
  });
}

function writeEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "DELETE,GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Origin", "*");
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}
