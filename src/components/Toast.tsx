import { Activity, CheckCircle, TriangleAlert } from 'lucide-react';
import type { ToastMessage, ToastType } from '../types';

interface ToastProps {
  message: ToastMessage;
}

const ICONS: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  warning: TriangleAlert,
  error: TriangleAlert,
  info: Activity,
};

const ALERT_TYPES: ToastType[] = ['error', 'warning'];

export function Toast({ message }: ToastProps) {
  const Icon = ICONS[message.type];
  const role = ALERT_TYPES.includes(message.type) ? 'alert' : 'status';
  return (
    <div className={`toast toast-${message.type}`} role={role}>
      <Icon className="toast-icon h-4 w-4" aria-hidden="true" />
      <span>{message.text}</span>
    </div>
  );
}

export default Toast;
