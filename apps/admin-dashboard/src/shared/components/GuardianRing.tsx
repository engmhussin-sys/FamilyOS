interface GuardianRingProps {
  /** 0–100. When provided, the ring is a determinate progress/countdown indicator. */
  progressPercent?: number;
  size?: number;
  className?: string;
}

/**
 * The one recurring signature element of the "Quiet Guardian" identity: a
 * ring that closes as protection completes (login), or drains as a window
 * of time elapses (pairing-code countdown). Used deliberately in exactly
 * these two places — restraint is part of the design, not everywhere a
 * spinner could go.
 */
export function GuardianRing({ progressPercent = 100, size = 56, className = '' }: GuardianRingProps) {
  const strokeWidth = size * 0.09;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - progressPercent / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={`${Math.round(progressPercent)}%`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="transition-[stroke-dashoffset] duration-500 ease-linear"
      />
    </svg>
  );
}
