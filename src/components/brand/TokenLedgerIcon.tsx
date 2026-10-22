import type { SVGProps } from 'react';
import { TOKEN_LEDGER_PATH, TOKEN_LEDGER_SIZE, TOKEN_LEDGER_STROKE_WIDTH } from './tokenLedgerGeometry';

export function TokenLedgerIcon({ className = 'h-4 w-4', ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={`0 0 ${TOKEN_LEDGER_SIZE} ${TOKEN_LEDGER_SIZE}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={TOKEN_LEDGER_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={TOKEN_LEDGER_PATH} />
    </svg>
  );
}

export default TokenLedgerIcon;
