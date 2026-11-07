/**
 * 全屏极光背景层：纯装饰，不参与交互与无障碍树。
 * 色块使用静态 blur，仅通过 transform 漂移，避免逐帧重绘模糊半径。
 */
export default function AuroraBackground(): JSX.Element {
  return (
    <div className="aurora-bg" aria-hidden="true">
      <div className="aurora-blob aurora-blob--blue" />
      <div className="aurora-blob aurora-blob--violet" />
      <div className="aurora-blob aurora-blob--teal" />
      <div className="aurora-top" />
      <div className="aurora-noise" />
    </div>
  );
}
