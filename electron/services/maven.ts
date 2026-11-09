/** Maven 坐标解析：供 Fabric 依赖与继承版本的 classpath 共用 */

export interface MavenCoordinate {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
}

const SEGMENT_RE = /^[A-Za-z0-9._+-]+$/;

function isValidSegment(value: string): boolean {
  return value.length > 0 && SEGMENT_RE.test(value) && !value.includes('..');
}

/** 解析 `group:artifact:version[:classifier]`，非法时返回 null */
export function parseMavenName(name: unknown): MavenCoordinate | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 512) {
    return null;
  }
  const parts = name.split(':');
  if (parts.length < 3 || parts.length > 4) {
    return null;
  }
  const [group, artifact, version] = parts;
  const classifier = parts[3];
  if (!isValidSegment(group) || !isValidSegment(artifact) || !isValidSegment(version)) {
    return null;
  }
  for (const segment of group.split('.')) {
    if (!isValidSegment(segment)) {
      return null;
    }
  }
  if (classifier !== undefined && !isValidSegment(classifier)) {
    return null;
  }
  return { group, artifact, version, classifier };
}

/** 库文件在 `libraries/` 下的相对路径 */
export function mavenRelativePath(coordinate: MavenCoordinate): string {
  const groupPath = coordinate.group.split('.').join('/');
  const fileName = `${coordinate.artifact}-${coordinate.version}${coordinate.classifier ? `-${coordinate.classifier}` : ''}.jar`;
  return `${groupPath}/${coordinate.artifact}/${coordinate.version}/${fileName}`;
}

/** 拼接 Maven 基础地址与库路径；路径段做 URL 编码 */
export function mavenDownloadUrl(baseUrl: string, coordinate: MavenCoordinate): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const segments = mavenRelativePath(coordinate).split('/').map((segment) => encodeURIComponent(segment));
  return `${base}${segments.join('/')}`;
}
