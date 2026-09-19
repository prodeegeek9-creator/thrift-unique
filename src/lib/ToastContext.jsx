import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext({ toast: () => {} });

let nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((message, tone = 'default') => {
    const id = ++nextId;
    setToasts((all) => [...all, { id, message, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 4000);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`animate-toast-in rounded-pill px-4 py-2 text-sm font-medium shadow-pop ${
              t.tone === 'error'
                ? 'bg-red text-white'
                : t.tone === 'success'
                  ? 'bg-green text-white'
                  : 'bg-sidebar text-white'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext).toast;
}
