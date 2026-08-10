import { type ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  isLoading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-guardian-900 text-sand-50 hover:bg-guardian-700 disabled:bg-guardian-700/50',
  secondary: 'bg-sage-100 text-guardian-900 hover:bg-sage-100/70 disabled:opacity-50',
  ghost: 'bg-transparent text-guardian-900 hover:bg-sand-100 disabled:opacity-50',
  danger: 'bg-brick-600 text-sand-50 hover:bg-brick-500 disabled:opacity-50',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', isLoading, disabled, className = '', children, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center gap-2 rounded-card px-4 py-2.5
        font-body text-sm font-medium transition-colors duration-150
        disabled:cursor-not-allowed ${variantClasses[variant]} ${className}`}
      {...rest}
    >
      {isLoading && (
        <span
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
