import { useState } from 'react';
import { Globe, Layers } from 'lucide-react';
import GlassPanel from '../components/ui/GlassPanel';
import VersionBrowser from '../components/VersionBrowser';
import FabricInstallDialog from '../components/FabricInstallDialog';
import { useLauncher } from '../lib/useLauncher';

/**
 * 下载中心：直接浏览 Mojang 官方版本清单，选择版本后下载并安装。
 */
export default function DownloadPage(): JSX.Element {
  const { versions } = useLauncher();
  const installedCount = versions.filter((version) => version.installed).length;
  const [fabricOpen, setFabricOpen] = useState(false);

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', padding: '14px 16px' }}>
      <GlassPanel
        layer="base"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '18px 20px 16px',
          gap: 14
        }}
      >
        <header style={{ flex: 'none', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 600, letterSpacing: '0.02em' }}>下载中心</h1>
            <p className="text-3" style={{ marginTop: 4, fontSize: 'var(--fs-sm)' }}>
              选择官方源或通道1 / 通道2安装 Minecraft 原版版本，也可在线安装 Fabric
            </p>
          </div>
          <span
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(106, 168, 255, 0.3)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              fontSize: 'var(--fs-xs)'
            }}
          >
            <Globe size={12} strokeWidth={1.8} aria-hidden="true" />
            官方 / 通道1 / 通道2
          </span>
          <span
            className="text-3"
            style={{
              flex: 'none',
              padding: '3px 10px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--glass-border)',
              background: 'rgba(255, 255, 255, 0.05)',
              fontSize: 'var(--fs-xs)'
            }}
          >
            已安装 {installedCount} 个版本
          </span>
          <button
            type="button"
            className="focus-ring glass-sheen glass-interactive"
            onClick={() => setFabricOpen(true)}
            style={{
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 14px',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid rgba(106, 168, 255, 0.4)',
              background: 'linear-gradient(180deg, rgba(106, 168, 255, 0.3), rgba(76, 141, 255, 0.16))',
              color: 'var(--text-1)',
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-xs)',
              cursor: 'pointer'
            }}
          >
            <Layers size={13} strokeWidth={1.8} />
            安装 Fabric
          </button>
        </header>

        <VersionBrowser variant="page" style={{ flex: '1 1 auto', minHeight: 0 }} />
      </GlassPanel>

      <FabricInstallDialog open={fabricOpen} onClose={() => setFabricOpen(false)} />
    </div>
  );
}
