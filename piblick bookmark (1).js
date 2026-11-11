/**
 * Nexora Cloudflare Worker: login + games-list + daemon download.
 * No additional Cloudflare secret/binding is required.
 * Routes: POST /api/client/auth, POST /api/client/games,
 *         GET /api/client/download?token=..., GET /health
 */

const EXPECTED_KEY = "ARAFAT";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DAEMON_SOURCE_URL =
  "https://raw.githubusercontent.com/arif3tt-tech/Nexaura/main/Greed_patched";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

function readOnlyHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    ...extra,
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function suppliedKey(body) {
  return String(
    body?.key ??
      body?.license_key ??
      body?.license ??
      body?.licence_key ??
      body?.data?.key ??
      ""
  ).trim().toUpperCase();
}

async function downloadDaemon(request, requestUrl) {
  // Auth creates a random session_token and places that same value in file_url.
  // GitHub's source is public; no separate signing secret or token store is needed.
  const token = requestUrl.searchParams.get("token") || "";
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return jsonResponse({ success: false, error: "invalid_download_token" }, 403);
  }

  let upstream;
  try {
    upstream = await fetch(DAEMON_SOURCE_URL, {
      method: "GET",
      headers: { accept: "application/octet-stream, */*" },
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch {
    return jsonResponse({ success: false, error: "daemon_source_unreachable" }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    try {
      await upstream.body?.cancel();
    } catch {}
    return jsonResponse(
      { success: false, error: "daemon_source_bad_status", upstream_status: upstream.status },
      502
    );
  }

  // Do not send an HTML/error page to the app as if it were the daemon binary.
  const reader = upstream.body.getReader();
  const prefixChunks = [];
  let prefixLength = 0;
  while (prefixLength < 4) {
    const { value, done } = await reader.read();
    if (done) break;
    prefixChunks.push(value);
    prefixLength += value.byteLength;
  }
  const prefix = new Uint8Array(prefixLength);
  let offset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (
    prefixLength < 4 ||
    prefix[0] !== 0x7f ||
    prefix[1] !== 0x45 ||
    prefix[2] !== 0x4c ||
    prefix[3] !== 0x46
  ) {
    try {
      await reader.cancel();
    } catch {}
    return jsonResponse({ success: false, error: "daemon_source_not_elf" }, 502);
  }

  const body = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(prefix);
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const headers = readOnlyHeaders({
    "content-type": "application/octet-stream",
    "content-disposition": "attachment; filename=daemon",
    "cache-control": "no-store, no-cache, must-revalidate",
    "x-content-type-options": "nosniff",
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    headers["content-length"] = contentLength;
  }
  return new Response(body, { status: 200, headers });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Health Check Route (kept as before)
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "nexora-auth-and-games" });
    }

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: readOnlyHeaders({ "access-control-max-age": "86400" }),
      });
    }

    // New route: the app's file_url points here and the Worker proxies GitHub bytes.
    if (request.method === "GET" && url.pathname === "/api/client/download") {
      return downloadDaemon(request, url);
    }

    // Keep the original API rule for the existing POST routes.
    if (request.method !== "POST") {
      return jsonResponse({ success: false, error: "method_not_allowed" }, 405);
    }

    const body = await readJson(request);
    if (!body) {
      return jsonResponse(
        { success: false, error: "invalid_request", message: "Request body must be valid JSON" },
        400
      );
    }

    // Existing license-key validation (unchanged)
    const key = suppliedKey(body);
    if (key !== EXPECTED_KEY) {
      return jsonResponse(
        { success: false, error: "invalid_key", message: "invalid license key" },
        403
      );
    }

    // Existing login response fields retained; add file_url using the same generated session_token.
    if (url.pathname === "/api/client/auth") {
      const now = Math.floor(Date.now() / 1000);
      const sessionToken = crypto.randomUUID().replaceAll("-", "");
      const fileUrl = new URL("/api/client/download", url.origin);
      fileUrl.searchParams.set("token", sessionToken);
      return jsonResponse({
        success: true,
        session_token: sessionToken,
        expires_at: new Date((now + SESSION_TTL_SECONDS) * 1000).toISOString(),
        message: "License verified",
        file_url: fileUrl.toString(),
      });
    }

    // Existing games response retained
    if (url.pathname === "/api/client/games") {
      return jsonResponse({
        success: true,
        games: [
          {
            name: "test",
            version: "test",
            versionCode: "2019121229",
            version2: "",
            versionCode2: "",
            packageName: "",
            arch: "",
            type: "GAME",
            image:
              "https://files.manuscdn.com/user_upload_by_module/session_file/30519663849826498/XugnQOFnbHMzuIXS.png",
            emulator: false,
            active: true,
          },
        ],
      });
    }

    return jsonResponse({ success: false, error: "not_found" }, 404);
  },
};
