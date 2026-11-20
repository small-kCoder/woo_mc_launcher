/**
 * WOO 启动器云端 API（Cloudflare Workers + D1）
 *
 * 只保留两项能力：
 * - GET /health：通道健康检查，客户端据此做故障转移
 * - /rooms：P2P 联机房间索引（POST 建房、GET 查询、DELETE 关闭、POST 心跳）
 *
 * 原 Node 服务端的版本下载、分块上传已下线，对应路径返回 404。
 */

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const ROOM_MAX = 100;
const ROOM_BODY_LIMIT = 8 * 1024;
const ROOM_CODE_LENGTH = 6;
/** 去除易混淆字符：0/O、1/I */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const ROOM_SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_VERSION_RE = /^[A-Za-z0-9._ -]{1,128}$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Range,If-None-Match,Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,ETag'
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(status, payload, extraHeaders = {}) {
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function sendError(status, message) {
  return sendJson(status, { error: message });
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > ROOM_BODY_LIMIT) {
    throw new ApiError(413, 'body_too_large');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}

function isValidIPv4(value) {
  if (typeof value !== 'string' || !IPV4_RE.test(value)) {
    return false;
  }
  return value.split('.').every((part) => {
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function validateRoomPayload(body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!ROOM_SESSION_RE.test(sessionId)) {
    throw new ApiError(400, 'invalid_session_id');
  }
  const versionId = typeof body.versionId === 'string' ? body.versionId.trim() : '';
  if (!ROOM_VERSION_RE.test(versionId) || versionId.includes('..')) {
    throw new ApiError(400, 'invalid_version_id');
  }
  const networkName = typeof body.networkName === 'string' ? body.networkName.trim() : '';
  const networkSecret = typeof body.networkSecret === 'string' ? body.networkSecret.trim() : '';
  if (networkName.length === 0 || networkName.length > 128) {
    throw new ApiError(400, 'invalid_network_name');
  }
  if (networkSecret.length === 0 || networkSecret.length > 128) {
    throw new ApiError(400, 'invalid_network_secret');
  }
  if (!isValidIPv4(body.hostVirtualIp)) {
    throw new ApiError(400, 'invalid_host_virtual_ip');
  }
  if (!isValidIPv4(body.hostLanIp)) {
    throw new ApiError(400, 'invalid_host_lan_ip');
  }
  const gamePort = Number(body.gamePort);
  if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65535) {
    throw new ApiError(400, 'invalid_game_port');
  }
  const hostNameRaw = typeof body.hostName === 'string' ? body.hostName.trim() : '';
  return {
    sessionId,
    versionId,
    networkName,
    networkSecret,
    hostVirtualIp: body.hostVirtualIp,
    hostLanIp: body.hostLanIp,
    gamePort,
    hostName: hostNameRaw.length > 0 ? hostNameRaw.slice(0, 64) : '房主'
  };
}

function publicRoom(row) {
  return {
    versionId: row.version_id,
    networkName: row.network_name,
    networkSecret: row.network_secret,
    hostVirtualIp: row.host_virtual_ip,
    hostLanIp: row.host_lan_ip,
    gamePort: row.game_port,
    hostName: row.host_name,
    expiresAt: row.expires_at
  };
}

function randomRoomCode() {
  let code = '';
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/** 建房：同一 sessionId 重复登记时复用原房间号 */
async function createRoom(request, env) {
  const payload = validateRoomPayload(await readJsonBody(request));
  const now = Date.now();
  await env.DB.prepare('DELETE FROM rooms WHERE expires_at <= ?').bind(now).run();

  const existing = await env.DB.prepare('SELECT code FROM rooms WHERE session_id = ?')
    .bind(payload.sessionId)
    .first();
  if (existing) {
    const expiresAt = now + ROOM_TTL_MS;
    await env.DB.prepare(
      `UPDATE rooms SET version_id = ?, network_name = ?, network_secret = ?,
        host_virtual_ip = ?, host_lan_ip = ?, game_port = ?, host_name = ?, expires_at = ?
       WHERE session_id = ?`
    )
      .bind(
        payload.versionId,
        payload.networkName,
        payload.networkSecret,
        payload.hostVirtualIp,
        payload.hostLanIp,
        payload.gamePort,
        payload.hostName,
        expiresAt,
        payload.sessionId
      )
      .run();
    return sendJson(200, { ok: true, code: existing.code, expiresAt });
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM rooms WHERE expires_at > ?')
    .bind(now)
    .first();
  if (Number(countRow?.count || 0) >= ROOM_MAX) {
    throw new ApiError(429, 'room_limit_reached');
  }

  const expiresAt = now + ROOM_TTL_MS;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomRoomCode();
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms
        (code, session_id, version_id, network_name, network_secret,
         host_virtual_ip, host_lan_ip, game_port, host_name, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        code,
        payload.sessionId,
        payload.versionId,
        payload.networkName,
        payload.networkSecret,
        payload.hostVirtualIp,
        payload.hostLanIp,
        payload.gamePort,
        payload.hostName,
        now,
        expiresAt
      )
      .run();
    if (result.meta.changes === 1) {
      return sendJson(200, { ok: true, code, expiresAt });
    }
  }
  throw new ApiError(503, 'room_code_exhausted');
}

async function getRoom(env, code) {
  const now = Date.now();
  return env.DB.prepare('SELECT * FROM rooms WHERE code = ? AND expires_at > ?')
    .bind(code, now)
    .first();
}

async function handleRooms(request, env, pathname) {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'rooms') {
    return sendError(404, 'not_found');
  }

  if (parts.length === 1) {
    if (request.method !== 'POST') {
      return sendError(405, 'method_not_allowed');
    }
    return createRoom(request, env);
  }

  const code = (parts[1] || '').toUpperCase();
  if (!ROOM_CODE_RE.test(code)) {
    return sendError(404, 'room_not_found');
  }
  const row = await getRoom(env, code);
  if (!row) {
    return sendError(404, 'room_not_found');
  }

  if (parts.length === 2) {
    if (request.method === 'GET') {
      return sendJson(200, { ok: true, ...publicRoom(row) });
    }
    if (request.method === 'DELETE') {
      const body = await readJsonBody(request);
      if (typeof body.sessionId !== 'string' || body.sessionId !== row.session_id) {
        return sendError(403, 'room_session_mismatch');
      }
      await env.DB.prepare('DELETE FROM rooms WHERE code = ? AND session_id = ?')
        .bind(code, row.session_id)
        .run();
      return sendJson(200, { ok: true, closed: code });
    }
    return sendError(405, 'method_not_allowed');
  }

  if (parts.length === 3 && parts[2] === 'heartbeat') {
    if (request.method !== 'POST') {
      return sendError(405, 'method_not_allowed');
    }
    const body = await readJsonBody(request);
    if (typeof body.sessionId !== 'string' || body.sessionId !== row.session_id) {
      return sendError(403, 'room_session_mismatch');
    }
    const expiresAt = Date.now() + ROOM_TTL_MS;
    await env.DB.prepare('UPDATE rooms SET expires_at = ? WHERE code = ? AND session_id = ?')
      .bind(expiresAt, code, row.session_id)
      .run();
    return sendJson(200, { ok: true, expiresAt });
  }

  return sendError(404, 'not_found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (pathname === '/health') {
        return sendJson(200, {
          ok: true,
          service: 'woo-api',
          role: 'room-index',
          roomTtlMs: ROOM_TTL_MS,
          maxRooms: ROOM_MAX,
          time: Date.now()
        });
      }

      if (pathname === '/') {
        return sendJson(200, {
          name: 'WOO 启动器服务端',
          endpoints: {
            health: '/health',
            createRoom: 'POST /rooms',
            getRoom: 'GET /rooms/<code>',
            closeRoom: 'DELETE /rooms/<code>',
            heartbeat: 'POST /rooms/<code>/heartbeat'
          }
        });
      }

      if (pathname === '/rooms' || pathname.startsWith('/rooms/')) {
        return await handleRooms(request, env, pathname);
      }

      // 版本下载与上传已下线；保留路径以便旧客户端拿到明确的状态码
      if (pathname === '/version_manifest_v2.json' || pathname.startsWith('/uploads/')) {
        return sendError(404, 'version_service_retired');
      }

      return sendError(404, 'not_found');
    } catch (error) {
      if (error instanceof ApiError) {
        return sendError(error.status, error.message);
      }
      console.error(error);
      return sendError(500, 'internal_error');
    }
  },

  /** 每小时清理过期房间，避免 D1 中堆积 */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM rooms WHERE expires_at <= ?').bind(Date.now()).run()
    );
  }
};
