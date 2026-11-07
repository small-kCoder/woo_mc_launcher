import type { CSSProperties } from 'react';
import type { AccountSummary } from '../types/ipc';

interface AccountAvatarProps {
  account: AccountSummary | null;
  size?: number;
}

/** 离线默认像素头像：8×8 网格，头发布朗、肤色与像素眼睛 */
function DefaultPixelHead(): JSX.Element {
  return (
    <svg
      viewBox="0 0 8 8"
      width="100%"
      height="100%"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {/* 肤色底 */}
      <rect width="8" height="8" fill="#9c7154" />
      {/* 头发布朗两层 */}
      <rect width="8" height="1" fill="#4a3425" />
      <rect y="1" width="8" height="1" fill="#3a281d" />
      <rect y="2" width="1" height="1" fill="#3a281d" />
      <rect x="7" y="2" width="1" height="1" fill="#3a281d" />
      {/* 眼睛：眼白与蓝色瞳孔 */}
      <rect x="1" y="3" width="2" height="1" fill="#eef3f6" />
      <rect x="5" y="3" width="2" height="1" fill="#eef3f6" />
      <rect x="2" y="3" width="1" height="1" fill="#4a6fa5" />
      <rect x="5" y="3" width="1" height="1" fill="#4a6fa5" />
      {/* 鼻子阴影与嘴 */}
      <rect x="3" y="4" width="2" height="1" fill="#86603f" />
      <rect x="3" y="6" width="2" height="1" fill="#6b4a34" />
    </svg>
  );
}

/**
 * 账户头像：正版使用皮肤头部 data URL，离线使用内联像素 SVG。
 * 容器统一为玻璃描边 + 内阴影 + 轻微渐变。
 */
export default function AccountAvatar({ account, size = 44 }: AccountAvatarProps): JSX.Element {
  const skinUrl = account?.type === 'microsoft' ? account.skinHeadDataUrl : undefined;
  const radius = Math.min(14, Math.round(size * 0.28));
  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    flex: 'none',
    overflow: 'hidden',
    borderRadius: radius,
    border: '1px solid var(--glass-border-strong)',
    background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.04))',
    boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.06)'
  };

  return (
    <div style={containerStyle} aria-label={account ? `${account.name} 的头像` : '默认头像'}>
      {skinUrl ? (
        <img
          src={skinUrl}
          alt=""
          width={size}
          height={size}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            imageRendering: 'pixelated'
          }}
        />
      ) : (
        <DefaultPixelHead />
      )}
    </div>
  );
}
