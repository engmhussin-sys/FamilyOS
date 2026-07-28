import type { HTMLAttributes } from 'react';

export function Card({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-card border border-sand-200 bg-white p-6 shadow-quiet ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
