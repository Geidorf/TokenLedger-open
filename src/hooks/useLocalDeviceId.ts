import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { t } from '../i18n';

let cached: Promise<string | null> | null = null;

function loadLocalDeviceId(): Promise<string | null> {
  cached ??= invoke<unknown>('get_device_id')
    .then((value) => (typeof value === 'string' && value ? value : null))
    .catch(() => {
      cached = null;
      return null;
    });
  return cached;
}

/** 本机的随机设备 ID（云端按它区分这台电脑）；读取前或读取失败时为 null。 */
export function useLocalDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadLocalDeviceId().then((value) => {
      if (alive) setId(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return id;
}

/** 设备下拉的显示名：本机标出「本机」，其他设备显示 ID。 */
export function deviceOptionLabel(machine: string, localDeviceId: string | null): string {
  return machine === localDeviceId ? t('cloudDevice.thisDevice', { id: machine }) : machine;
}
