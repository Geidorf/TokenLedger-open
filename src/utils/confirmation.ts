export type ConfirmationTone = 'primary' | 'danger';

export interface ConfirmationRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmationTone;
}

export type RequestConfirmation = (request: ConfirmationRequest) => Promise<boolean>;
