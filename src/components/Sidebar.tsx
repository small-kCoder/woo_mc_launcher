import { motion } from 'framer-motion';
import { Download, Info, Package, Play, Settings } from 'lucide-react';
import AccountAvatar from './AccountAvatar';
import GlassPanel from './ui/GlassPanel';
import { DURATIONS, EASE_OUT_CURVE } from '../lib/motion';
import type { AccountSummary } from '../types/ipc';

/** 左侧导航可切换的页面标识 */
export type LauncherPage = 'launch' | 'download' | 'mod' | 'settings' | 'about';

interface SidebarProps {
  activeAccount: AccountSummary | null;
  activePage: LauncherPage;
  onNavigate: (page: LauncherPage) => void;
}

interface NavItemConfig {
  page: LauncherPage;
  label: string;
  icon: typeof Play;
}

const NAV_ITEMS: readonly NavItemConfig[] = [
  { page: 'launch', label: '启动', icon: Play },
  { page: 'download', label: '下载', icon: Download },
  { page: 'mod', label: '模组', icon: Package },
  { page: 'settings', label: '设置', icon: Settings },
  { page: 'about', label: '关于', icon: Info }
];

/**
 * 左侧栏：账户头像与名称、分隔线、五项导航。
 * 激活项使用 layoutId 共享高亮层，切换时平滑滑动。
 */
export default function Sidebar({ activeAccount, activePage, onNavigate }: SidebarProps): JSX.Element {
  return (
    <GlassPanel
      layer="base"
      className="app-sidebar"
      style={{
        height: '100%',
        padding: '14px 12px',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <AccountAvatar account={activeAccount} size={44} />
        <span
          className="text-2"
          title={activeAccount?.name ?? '未登录'}
          style={{
            width: '100%',
            fontSize: 'var(--fs-sm)',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {activeAccount?.name ?? '未登录'}
        </span>
      </div>

      <hr className="hairline" style={{ margin: '14px 0 12px' }} />

      <nav aria-label="主导航" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.page === activePage;
          return (
            <button
              key={item.page}
              type="button"
              className={`nav-item focus-ring${isActive ? ' is-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onNavigate(item.page)}
            >
              {isActive && (
                <motion.div
                  layoutId="nav-active"
                  className="nav-highlight"
                  initial={false}
                  transition={{ duration: DURATIONS.base, ease: EASE_OUT_CURVE }}
                >
                  <span className="nav-indicator" />
                </motion.div>
              )}
              <Icon className="nav-item-icon" size={16} strokeWidth={1.8} />
              <span className="nav-item-label">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </GlassPanel>
  );
}
