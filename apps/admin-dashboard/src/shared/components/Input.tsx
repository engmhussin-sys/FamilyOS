import { type InputHTMLAttributes, forwardRef, useId } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, className = '', ...rest }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const hintId = hint ? `${inputId}-hint` : undefined;
    const errorId = error ? `${inputId}-error` : undefined;

    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error)}
          aria-describedby={errorId ?? hintId}
          className={`rounded-card border bg-white px-3.5 py-2.5 font-body text-sm text-ink
            placeholder:text-ink-soft/50 transition-colors
            ${error ? 'border-brick-500' : 'border-sand-200 focus:border-sage-500'}
            ${className}`}
          {...rest}
        />
        {hint && !error && (
          <p id={hintId} className="text-xs text-ink-soft">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-xs text-brick-600">
            {error}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
