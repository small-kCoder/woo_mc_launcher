import type { VersionRule } from './versions';

/** 启动平台常量（与原安装器保持一致） */
const OS_NAME = 'windows';

/** 当前架构标识：x86_64 / x86 */
export function getCurrentArch(): string {
  return process.arch === 'x64' ? 'x86_64' : 'x86';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 单条规则是否匹配当前系统；features 一律视为 false */
function ruleMatches(rule: VersionRule, osArch: string): boolean {
  if (!isPlainObject(rule)) {
    return false;
  }
  if (isPlainObject(rule.os)) {
    if (typeof rule.os.name === 'string' && rule.os.name !== OS_NAME) {
      return false;
    }
    if (typeof rule.os.arch === 'string' && rule.os.arch !== osArch) {
      return false;
    }
  }
  if (isPlainObject(rule.features)) {
    // features 一律视为 false：要求启用某特性的规则不匹配
    for (const value of Object.values(rule.features)) {
      if (value !== false) {
        return false;
      }
    }
  }
  return true;
}

/** 按规则序列决定是否允许：最后一条匹配规则的 action 生效 */
export function ruleAllows(rules: VersionRule[] | undefined, osArch: string = getCurrentArch()): boolean {
  if (!Array.isArray(rules) || rules.length === 0) {
    return true;
  }
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule, osArch)) {
      continue;
    }
    allowed = rule.action === 'allow';
  }
  return allowed;
}
