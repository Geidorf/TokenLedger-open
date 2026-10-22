import { useCallback, useEffect, useState } from 'react';

/** 只存在这台电脑的浏览器存储里，不进项目索引，也不进 AppSettings。 */
export const HIDE_PROJECT_NAMES_KEY = 'tokenledger.hideProjectNames';

export function readHideProjectNames(): boolean {
  try {
    return window.localStorage.getItem(HIDE_PROJECT_NAMES_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeHideProjectNames(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(HIDE_PROJECT_NAMES_KEY, '1');
    else window.localStorage.removeItem(HIDE_PROJECT_NAMES_KEY);
  } catch {
    /* 显示偏好写不进去时，本次会话仍用内存里的值。 */
  }
}

export function useHideProjectNames(): { hidden: boolean; setHidden: (hidden: boolean) => void } {
  const [hidden, setHiddenState] = useState(readHideProjectNames);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === HIDE_PROJECT_NAMES_KEY) setHiddenState(readHideProjectNames());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const setHidden = useCallback((value: boolean) => {
    writeHideProjectNames(value);
    setHiddenState(value);
  }, []);
  return { hidden, setHidden };
}
