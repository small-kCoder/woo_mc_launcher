import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';

/**
 * 窗口控制按钮：绝对定位右上角，透明玻璃悬停；
 * 最大化时方形图标切换为叠放方块（还原）。
 */
export default function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const controls = window.launcher?.win;

  useEffect(() => {
    let disposed = false;
    controls
      ?.isMaximized()
      .then((value) => {
        if (!disposed) {
          setMaximized(value);
        }
      })
      .catch(() => {
        // 查询失败时保持未最大化状态
      });
    return () => {
      disposed = true;
    };
  }, [controls]);

  const handleToggleMaximize = () => {
    if (!controls) {
      return;
    }
    controls
      .toggleMaximize()
      .then((value) => setMaximized(value))
      .catch(() => undefined);
  };

  return (
    <div className="window-controls no-drag">
      <button
        type="button"
        className="window-btn focus-ring"
        title="最小化"
        aria-label="最小化"
        onClick={() => controls?.minimize().catch(() => undefined)}
      >
        <Minus size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="window-btn focus-ring"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={handleToggleMaximize}
      >
        {maximized ? <Copy size={12} strokeWidth={1.8} /> : <Square size={11} strokeWidth={2} />}
      </button>
      <button
        type="button"
        className="window-btn window-btn--close focus-ring"
        title="关闭"
        aria-label="关闭"
        onClick={() => controls?.close().catch(() => undefined)}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
