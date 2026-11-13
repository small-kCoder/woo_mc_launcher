import { useState } from 'react';
import { MotionConfig, motion } from 'framer-motion';
import AuroraBackground from './components/AuroraBackground';
import MultiplayerPanel from './components/MultiplayerPanel';
import ServerConnectionGuard from './components/ServerConnectionGuard';
import Sidebar, { type LauncherPage } from './components/Sidebar';
import SystemMonitorPanel from './components/SystemMonitorPanel';
import WindowControls from './components/WindowControls';
import { useLauncher } from './lib/useLauncher';
import { EASE_OUT_CURVE, fadeSlide } from './lib/motion';
import DownloadPage from './pages/DownloadPage';
import LaunchPage from './pages/LaunchPage';
import ModsPage from './pages/ModsPage';
import PlaceholderPage from './pages/PlaceholderPage';

/** 三栏主布局：左侧导航 / 中部页面 / 右侧静态占位板 */
export default function App(): JSX.Element {
  const { activeAccount } = useLauncher();
  const [activePage, setActivePage] = useState<LauncherPage>('launch');

  return (
    <MotionConfig transition={{ duration: 0.22, ease: EASE_OUT_CURVE }} reducedMotion="user">
      <div className="app-shell">
        <AuroraBackground />

        {/* 顶部拖拽条只覆盖非交互区域，交互控件均位于其下方或上方按钮层 */}
        <div className="window-drag drag-region" aria-hidden="true" />
        <WindowControls />

        <div className="app-layout">
          <Sidebar activeAccount={activeAccount} activePage={activePage} onNavigate={setActivePage} />

          <main className="app-main">
            {/*
             * [原代码]: <AnimatePresence mode="wait"> 包裹带 exit 的 motion.div
             * 旧方案的 wait 模式在页面内含 layoutId 动画（分段控件）时可能永久等待退场，
             * 导致导航高亮已切换、中栏仍停留在上一页。改为仅入场动画，切换必定生效。
             */}
            <motion.div
              key={activePage}
              variants={fadeSlide}
              initial="initial"
              animate="animate"
              /* 中栏页面需要可收缩，否则固定高度的页面（如下载页）会溢出并隐藏底部操作区 */
              style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}
            >
              {activePage === 'launch' ? (
                <LaunchPage />
              ) : activePage === 'download' ? (
                <DownloadPage />
              ) : activePage === 'mod' ? (
                <ModsPage />
              ) : (
                <PlaceholderPage page={activePage} />
              )}
            </motion.div>
          </main>

          <aside className="app-right">
            <SystemMonitorPanel />
            <MultiplayerPanel />
          </aside>
        </div>

        <ServerConnectionGuard />
      </div>
    </MotionConfig>
  );
}
