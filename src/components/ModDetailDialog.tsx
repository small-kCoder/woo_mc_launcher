import { AlertTriangle, Check, Download } from 'lucide-react';
import Dialog from './Dialog';
import { formatFileSize, formatReleaseDate } from '../lib/format';
import type { ModFile, ModMetadata } from '../types/ipc';

interface ModDetailDialogProps {
  open: boolean;
  mod: ModFile | null;
  directory: string | null;
  /** 正在安装缺失依赖 */
  installing?: boolean;
  onInstallMissing?: (modIds: string[]) => void;
  onClose: () => void;
}

function dependencyStatus(metadata: ModMetadata, id: string): { text: string; ok: boolean } {
  const dependency = metadata.depends.find((item) => item.id === id);
  if (!dependency) {
    return { text: '', ok: true };
  }
  if (dependency.satisfied) {
    return { text: '已满足', ok: true };
  }
  return { text: '缺失', ok: false };
}

/**
 * 模组详情：展示 fabric.mod.json 读取到的名称、版本、作者、依赖与文件信息。
 */
export default function ModDetailDialog({
  open,
  mod,
  directory,
  installing = false,
  onInstallMissing,
  onClose
}: ModDetailDialogProps): JSX.Element {
  const metadata = mod?.metadata ?? null;
  const displayName = metadata?.name ?? mod?.fileName.replace(/\.disabled$/i, '') ?? '';

  return (
    <Dialog
      open={open && Boolean(mod)}
      onClose={onClose}
      title="模组详情"
      width="min(480px, 92vw)"
      height={460}
    >
      {mod && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ flex: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--text-1)' }}>
                {displayName}
              </h3>
              {metadata?.version && (
                <span className="num" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}>
                  v{metadata.version}
                </span>
              )}
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  border: '1px solid rgba(106, 168, 255, 0.3)',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  fontSize: 10
                }}
              >
                {metadata ? 'Fabric' : '未识别'}
              </span>
              {!mod.enabled && (
                <span className="text-3" style={{ fontSize: 10 }}>
                  已禁用
                </span>
              )}
            </div>
            {metadata?.id && (
              <div className="text-3 num" style={{ marginTop: 4, fontSize: 'var(--fs-xs)' }}>
                ID: {metadata.id}
              </div>
            )}
          </div>

          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {metadata?.description ? (
              <p className="text-3" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                {metadata.description}
              </p>
            ) : (
              <p className="text-3" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.7 }}>
                {metadata ? '这个模组没有提供描述。' : '无法读取 fabric.mod.json，可能不是 Fabric 模组。'}
              </p>
            )}

            {metadata && metadata.authors.length > 0 && (
              <div>
                <div className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
                  作者
                </div>
                <div style={{ marginTop: 4, fontSize: 'var(--fs-sm)', color: 'var(--text-1)' }}>
                  {metadata.authors.join('、')}
                </div>
              </div>
            )}

            {metadata && metadata.depends.length > 0 && (
              <div>
                <div className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
                  依赖
                </div>
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {metadata.depends.map((dependency) => {
                    const status = dependencyStatus(metadata, dependency.id);
                    return (
                      <div
                        key={dependency.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          minHeight: 26,
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-xs)',
                          background: status.ok ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 103, 119, 0.1)'
                        }}
                      >
                        <span className="num" style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-1)', overflowWrap: 'anywhere' }}>
                          {dependency.id}
                        </span>
                        {dependency.requirement && (
                          <span className="text-3 num" style={{ flex: 'none', fontSize: 10 }}>
                            {dependency.requirement}
                          </span>
                        )}
                        <span
                          style={{
                            flex: 'none',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            fontSize: 10,
                            color: status.ok ? 'var(--success)' : 'var(--danger)'
                          }}
                        >
                          {status.ok ? <Check size={10} strokeWidth={2} /> : <AlertTriangle size={10} strokeWidth={2} />}
                          {status.text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {metadata && metadata.missing.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid rgba(255, 103, 119, 0.28)',
                  background: 'rgba(255, 103, 119, 0.08)',
                  color: 'var(--danger)',
                  fontSize: 'var(--fs-xs)',
                  lineHeight: 1.6
                }}
              >
                <span>
                  缺少依赖：{metadata.missing.join('、')}。可使用一键安装从 Modrinth 下载兼容当前版本的模组。
                </span>
                {onInstallMissing && (
                  <button
                    type="button"
                    className="focus-ring glass-interactive"
                    disabled={installing}
                    onClick={() => onInstallMissing(metadata.missing)}
                    style={{
                      alignSelf: 'flex-start',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      height: 28,
                      padding: '0 14px',
                      borderRadius: 'var(--radius-pill)',
                      border: '1px solid rgba(106, 168, 255, 0.4)',
                      background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.3), rgba(76, 141, 255, 0.16))',
                      color: 'var(--text-1)',
                      fontFamily: 'var(--font-ui)',
                      fontSize: 'var(--fs-xs)',
                      cursor: installing ? 'wait' : 'pointer',
                      opacity: installing ? 0.6 : 1
                    }}
                  >
                    <Download size={12} strokeWidth={1.8} />
                    {installing ? '正在安装依赖…' : `一键安装缺失依赖（${metadata.missing.length}）`}
                  </button>
                )}
              </div>
            )}

            <div>
              <div className="text-3" style={{ fontSize: 'var(--fs-xs)' }}>
                文件
              </div>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span className="num" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)', overflowWrap: 'anywhere' }}>
                  {mod.fileName}
                </span>
                <span className="text-3 num" style={{ fontSize: 'var(--fs-xs)' }}>
                  {formatFileSize(mod.size)} · {formatReleaseDate(mod.modifiedAt)}
                </span>
                {directory && (
                  <span className="text-3 num" style={{ fontSize: 10, overflowWrap: 'anywhere', opacity: 0.8 }}>
                    {directory}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
            <button
              type="button"
              className="focus-ring glass-interactive"
              onClick={onClose}
              style={{
                height: 32,
                padding: '0 20px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--glass-border)',
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-ui)',
                fontSize: 'var(--fs-sm)',
                cursor: 'pointer'
              }}
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
