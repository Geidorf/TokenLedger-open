import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Buttons or links; the first one should be the page's next step. */
  children?: ReactNode;
  /**
   * `card` stands alone on the page; `inset` sits inside an existing panel;
   * `banner` is a one-row card above content that still renders below it.
   */
  variant?: 'card' | 'inset' | 'banner';
  className?: string;
}

/** Shared "nothing here yet" block: what is missing and the one step that fills it. */
export function EmptyState({ icon: Icon, title, description, children, variant = 'card', className = '' }: EmptyStateProps) {
  return (
    <div className={`tl-empty tl-empty-${variant} ${className}`.trim()} role="status">
      <span className="tl-empty-icon" aria-hidden="true"><Icon className="h-5 w-5" /></span>
      <div className="tl-empty-copy">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="tl-empty-actions">{children}</div>}
    </div>
  );
}
