import type { HTMLAttributes } from 'react';

export type GlassLayer = 'base' | 'raised' | 'inset';

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  layer?: GlassLayer;
  interactive?: boolean;
}

/**
 * 液态玻璃面板。layer 控制层级质感，interactive 追加 hover 抬升与高光扫过。
 */
export default function GlassPanel({
  layer = 'base',
  interactive = false,
  className,
  style,
  children,
  ...rest
}: GlassPanelProps): JSX.Element {
  const classes = ['glass'];
  if (layer === 'raised') {
    classes.push('glass--raised');
  } else if (layer === 'inset') {
    classes.push('glass--inset');
  }
  if (interactive) {
    classes.push('glass-interactive', 'glass-sheen');
  }
  if (className) {
    classes.push(className);
  }

  return (
    <div className={classes.join(' ')} style={style} {...rest}>
      {children}
    </div>
  );
}
