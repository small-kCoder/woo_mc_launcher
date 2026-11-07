import { Info, Settings } from 'lucide-react';
import GlassPanel from '../components/ui/GlassPanel';
import type { LauncherPage } from '../components/Sidebar';

type PlaceholderPageId = Exclude<LauncherPage, 'launch' | 'download' | 'mod'>;

interface PlaceholderPageProps {
  page: PlaceholderPageId;
}

const PAGE_CONTENT: Record<PlaceholderPageId, { title: string; icon: typeof Info }> = {
  settings: { title: '设置', icon: Settings },
  about: { title: '关于', icon: Info }
};

/** 占位页：对应图标、标题、敬请期待角标与说明，不含任何可操作入口 */
export default function PlaceholderPage({ page }: PlaceholderPageProps): JSX.Element {
  const { title, icon: Icon } = PAGE_CONTENT[page];

  return (
    <div className="page-root">
      <GlassPanel
        layer="base"
        style={{
          width: '100%',
          maxWidth: 420,
          padding: '40px 32px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-3)',
          textAlign: 'center'
        }}
      >
        <Icon size={40} strokeWidth={1.4} aria-hidden="true" style={{ opacity: 0.45, color: 'var(--text-2)' }} />
        <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 600 }}>{title}</h1>
        <span
          style={{
            padding: '3px 12px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--glass-border)',
            background: 'rgba(255, 255, 255, 0.06)',
            color: 'var(--text-2)',
            fontSize: 'var(--fs-xs)',
            letterSpacing: '0.04em'
          }}
        >
          敬请期待
        </span>
        <p className="text-3" style={{ fontSize: 'var(--fs-sm)' }}>
          该功能将在后续版本提供
        </p>
      </GlassPanel>
    </div>
  );
}
