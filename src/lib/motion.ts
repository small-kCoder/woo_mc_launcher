import type { Transition, Variants } from 'framer-motion';

/** 弹性参数：260 刚度 / 26 阻尼，用于导航指示器、滑块等 */
export const SPRING: Transition = { type: 'spring', stiffness: 260, damping: 26 };

/** 统一缓出曲线，与 CSS --ease-out 一致 */
export const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;

/** framer-motion 需要可变元组类型，避免每次使用处重复断言 */
export const EASE_OUT_CURVE: [number, number, number, number] = [...EASE_OUT];

/** 秒制时长，与 CSS --dur-* 令牌一一对应 */
export const DURATIONS = { fast: 0.15, base: 0.22, slow: 0.32 } as const;

/** 页面切换：淡入并轻微上移，220ms */
export const fadeSlide: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATIONS.base, ease: EASE_OUT_CURVE }
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: DURATIONS.fast, ease: EASE_OUT_CURVE }
  }
};
