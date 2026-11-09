import { net as electronNet } from 'electron';
import { fail } from './errors';
import { logLine } from './logger';
import type { VersionJson } from './versions';

/** Fabric 元数据：官方优先，失败回退 BMCLAPI 镜像 */
const FABRIC_META_BASES = [
  'https://meta.fabricmc.net',
  'https://bmclapi2.bangbang93.com/fabric-meta'
];
const FETCH_TIMEOUT_MS = 12_000;
const VERSION_PART_RE = /^[A-Za-z0-9._+-]{1,64}$/;

function assertVersionPart(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 64 ||
    !VERSION_PART_RE.test(value) ||
    value.includes('..')
  ) {
    fail('FABRIC_INVALID_VERSION', `${label}不合法`);
  }
  return value;
}

/** 生成稳定的本地版本 id，例如 1.21.1-fabric-0.16.10 */
export function fabricVersionId(gameVersion: string, loaderVersion: string): string {
  const game = assertVersionPart(gameVersion, 'Minecraft 版本');
  const loader = assertVersionPart(loaderVersion, 'Fabric Loader 版本');
  const id = `${game}-fabric-${loader}`;
  if (id.length > 64) {
    fail('FABRIC_INVALID_VERSION', '版本 id 过长，无法创建版本目录');
  }
  return id;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await electronNet.fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function tryBases<T>(buildUrl: (base: string) => string, parse: (data: unknown) => T): Promise<T> {
  let lastError = '';
  for (const base of FABRIC_META_BASES) {
    try {
      const data = await fetchJson(buildUrl(base));
      return parse(data);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logLine(`Fabric 元数据请求失败（${base}）：${lastError}`);
    }
  }
  fail('FABRIC_META_UNAVAILABLE', `无法获取 Fabric 版本信息，请检查网络后重试${lastError ? `（${lastError}）` : ''}`);
}

function parseLoaderList(data: unknown): Array<{ version: string; stable: boolean }> {
  if (!Array.isArray(data)) {
    throw new Error('返回数据不是数组');
  }
  const result: Array<{ version: string; stable: boolean }> = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const loader = (entry as { loader?: unknown }).loader;
    if (typeof loader !== 'object' || loader === null) {
      continue;
    }
    const version = (loader as { version?: unknown }).version;
    const stable = (loader as { stable?: unknown }).stable;
    if (typeof version === 'string' && VERSION_PART_RE.test(version) && version.length <= 64) {
      result.push({ version, stable: stable === true });
    }
  }
  if (result.length === 0) {
    throw new Error('没有可用的 Loader 版本');
  }
  return result;
}

/** 查询指定 Minecraft 版本可用的 Fabric Loader，按接口顺序（新版本在前） */
export async function fetchFabricLoaders(
  gameVersion: string
): Promise<Array<{ version: string; stable: boolean }>> {
  const game = assertVersionPart(gameVersion, 'Minecraft 版本');
  return tryBases(
    (base) => `${base}/v2/versions/loader/${encodeURIComponent(game)}`,
    parseLoaderList
  );
}

/** 获取 Fabric profile JSON，并校验继承关系与主类 */
export async function fetchFabricProfile(
  gameVersion: string,
  loaderVersion: string
): Promise<VersionJson> {
  const game = assertVersionPart(gameVersion, 'Minecraft 版本');
  const loader = assertVersionPart(loaderVersion, 'Fabric Loader 版本');
  return tryBases(
    (base) =>
      `${base}/v2/versions/loader/${encodeURIComponent(game)}/${encodeURIComponent(loader)}/profile/json`,
    (data) => {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('profile 不是对象');
      }
      const profile = data as VersionJson;
      if (profile.inheritsFrom !== game) {
        throw new Error('profile 继承版本不匹配');
      }
      if (typeof profile.mainClass !== 'string' || profile.mainClass.length === 0) {
        throw new Error('profile 缺少主类');
      }
      if (!Array.isArray(profile.libraries)) {
        throw new Error('profile 缺少依赖库');
      }
      return profile;
    }
  );
}
