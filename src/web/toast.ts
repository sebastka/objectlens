import { createContext, useContext, type ReactNode } from 'react';

export type ToastLevel = 'ok' | 'error' | 'info';
export type Notify = (text: ReactNode, level?: ToastLevel) => void;

export const ToastContext = createContext<Notify>(() => {});

/** Shows a short message in the corner (ToastProvider in components/ui.tsx). */
export const useToast = () => useContext(ToastContext);
