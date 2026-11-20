#!/usr/bin/env node
/**
 * 官网静态服务器：零依赖，默认监听 IPv6 的 80 端口。
 * 用法：
 *   node site/serve.mjs
 *   $env:SITE_PORT="8081"; node site/serve.mjs
 *   $env:SITE_HOST="::"（默认，IPv6 全部地址）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.SITE_HOST || '::';
const PORT = Number.parseInt(process.env.SITE_PORT || '80', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8'
};

/** 解析请求路径，拒绝目录穿越 */
function resolveFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }
  const target = path.resolve(SITE_DIR, `.${pathname}`);
  const relative = path.relative(SITE_DIR, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return target;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const file = resolveFile(req.url || '/');
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>404</title>' +
          '<body style="font-family:system-ui;padding:48px;color:#151821">' +
          '<h1 style="font-size:20px">页面不存在</h1>' +
          '<p><a href="/" style="color:#2563eb">返回首页</a></p></body>'
      );
      return;
    }

    const ext = path.extname(file).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请设置 SITE_PORT 换一个端口。`);
  } else if (error.code === 'EACCES') {
    console.error(`没有权限监听端口 ${PORT}，请换端口或用管理员权限运行。`);
  } else {
    console.error(`服务启动失败：${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '::' ? `[${HOST}]` : HOST;
  console.log(`官网已启动：http://${shown}:${PORT}/`);
  console.log(`IPv6 直连：http://home.small-k.cc.cd:${PORT}/`);
  console.log(`静态目录：${SITE_DIR}`);
});
