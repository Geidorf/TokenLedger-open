import { useCountUp } from '../hooks/useCountUp';

interface AnimatedNumberProps {
  value: number;
  format: (value: number) => string;
  className?: string;
}

/**
 * 只在 value 真实变化时补间显示的数字。`format` 负责把中间帧的小数落到与
 * 终值一致的展示格式（例如四舍五入到整数再千分位）。
 */
export function AnimatedNumber({ value, format, className }: AnimatedNumberProps) {
  const displayed = useCountUp(value);
  return <span className={className}>{format(displayed)}</span>;
}

export default AnimatedNumber;
