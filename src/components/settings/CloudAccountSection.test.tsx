import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BusyState } from '../../types';
import { CloudAccountSection, secureStorageAuthorizationHint } from './CloudAccountSection';

function busyState(auth = false): BusyState {
  return {
    scan: false,
    sync: false,
    wallpaper: false,
    auth,
    config: false,
    settings: false,
    prices: false,
    db: false,
  };
}

describe('CloudAccountSection', () => {
  it('按平台给出不会误导用户的安全存储授权说明', () => {
    expect(secureStorageAuthorizationHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)'))
      .toContain('登录钥匙串密码');
    expect(secureStorageAuthorizationHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)'))
      .toContain('从同一安装包重新打开');
    expect(secureStorageAuthorizationHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))
      .toContain('本机系统密码');
    expect(secureStorageAuthorizationHint('Mozilla/5.0 (X11; Linux x86_64)'))
      .toContain('按系统提示完成授权');
  });

  it('只让实际触发的账户动作显示进行中反馈', () => {
    const onSignIn = vi.fn();
    const props = {
      cloudConfig: { supabase_url: '', supabase_key: '' },
      cloudStatus: { configured: false, authenticated: false, email: '', userId: '' },
      authForm: { email: 'user@example.com', password: 'secret' },
      busy: busyState(),
      onConfigChange: vi.fn(),
      onAuthFormChange: vi.fn(),
      onClearPassword: vi.fn(),
      onSaveConfig: vi.fn(),
      onSync: vi.fn(),
      onSignIn,
      onSignUp: vi.fn(),
      onSignOut: vi.fn(),
      configError: '',
      authError: '',
      setup: {
        configured: false,
        authenticated: false,
        capabilityVerified: false,
        firstSyncCompleted: false,
        validating: false,
        lastError: '',
      },
      onValidateCapability: vi.fn(),
    };
    const view = render(<CloudAccountSection {...props} />);

    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(onSignIn).toHaveBeenCalledOnce();

    view.rerender(<CloudAccountSection {...props} busy={busyState(true)} />);

    const signIn = screen.getByRole('button', { name: '正在登录云端账户' });
    expect(signIn).toBeDisabled();
    expect(signIn).toHaveAttribute('aria-busy', 'true');
    expect(signIn).toHaveAttribute('title', '正在登录云端账户');
    expect(signIn).toHaveTextContent('登录中…');
    expect(signIn.querySelector('.animate-spin')).toBeTruthy();

    const signUp = screen.getByRole('button', { name: '注册' });
    expect(signUp).toBeDisabled();
    expect(signUp).not.toHaveAttribute('aria-busy');
    expect(signUp).toHaveTextContent('注册');

    const signOut = screen.getByRole('button', { name: '退出云端账户' });
    expect(signOut).toBeDisabled();
    expect(signOut).not.toHaveAttribute('aria-busy');

    view.rerender(<CloudAccountSection {...props} busy={busyState()} />);
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '登录' })).not.toHaveAttribute('aria-busy');
    view.rerender(<CloudAccountSection {...props} busy={{ ...busyState(), config: true }} />);
    const duringConfigSave = screen.getByRole('button', { name: '登录' });
    expect(duringConfigSave).toBeDisabled();
    expect(screen.getByRole('button', { name: '注册' })).toBeDisabled();
    fireEvent.click(duringConfigSave);
    expect(onSignIn).toHaveBeenCalledOnce();
    view.rerender(<CloudAccountSection {...props} busy={busyState()} />);
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
    view.unmount();
  });

  it('云端同步期间锁定 Stats v2 验证入口', () => {
    const onValidateCapability = vi.fn();
    const mounted = render(
      <CloudAccountSection
        cloudConfig={{ supabase_url: 'https://project.supabase.co', supabase_key: 'publishable-key' }}
        cloudStatus={{ configured: true, authenticated: true, email: 'user@example.com', userId: 'user-1' }}
        authForm={{ email: 'user@example.com', password: '' }}
        busy={busyState(false)}
        onConfigChange={vi.fn()}
        onAuthFormChange={vi.fn()}
        onClearPassword={vi.fn()}
        onSaveConfig={vi.fn()}
        onSync={vi.fn()}
        onSignIn={vi.fn()}
        onSignUp={vi.fn()}
        onSignOut={vi.fn()}
        configError=""
        authError=""
        setup={{
          configured: true,
          authenticated: true,
          capabilityVerified: true,
          firstSyncCompleted: true,
          validating: false,
          lastError: '',
        }}
        onValidateCapability={onValidateCapability}
      />,
    );

    const ready = screen.getByRole('button', { name: '重新验证 Stats v2' });
    expect(ready).toBeEnabled();

    // Re-render through the public props to model a sync beginning after the view is mounted.
    mounted.rerender(
      <CloudAccountSection
        cloudConfig={{ supabase_url: 'https://project.supabase.co', supabase_key: 'publishable-key' }}
        cloudStatus={{ configured: true, authenticated: true, email: 'user@example.com', userId: 'user-1' }}
        authForm={{ email: 'user@example.com', password: '' }}
        busy={{ ...busyState(false), sync: true }}
        onConfigChange={vi.fn()}
        onAuthFormChange={vi.fn()}
        onClearPassword={vi.fn()}
        onSaveConfig={vi.fn()}
        onSync={vi.fn()}
        onSignIn={vi.fn()}
        onSignUp={vi.fn()}
        onSignOut={vi.fn()}
        configError=""
        authError=""
        setup={{
          configured: true,
          authenticated: true,
          capabilityVerified: true,
          firstSyncCompleted: true,
          validating: false,
          lastError: '',
        }}
        onValidateCapability={onValidateCapability}
      />,
    );

    const locked = screen.getByRole('button', { name: '重新验证 Stats v2' });
    expect(locked).toBeDisabled();
    fireEvent.click(locked);
    expect(onValidateCapability).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('未检查云端状态时不展示会触发安全存储的后续动作', () => {
    const onCheckStatus = vi.fn();
    render(
      <CloudAccountSection
        cloudConfig={{ supabase_url: 'https://project.supabase.co', supabase_key: 'publishable-key' }}
        cloudStatus={{ configured: true, authenticated: false, email: '', userId: '' }}
        statusKnown={false}
        statusChecking={false}
        statusError=""
        onCheckStatus={onCheckStatus}
        authForm={{ email: '', password: '' }}
        busy={busyState(false)}
        onConfigChange={vi.fn()}
        onAuthFormChange={vi.fn()}
        onClearPassword={vi.fn()}
        onSaveConfig={vi.fn()}
        onSync={vi.fn()}
        onSignIn={vi.fn()}
        onSignUp={vi.fn()}
        onSignOut={vi.fn()}
        configError=""
        authError=""
        setup={{
          configured: true,
          authenticated: false,
          capabilityVerified: false,
          firstSyncCompleted: false,
          validating: false,
          lastError: '',
        }}
        onValidateCapability={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '检查云端账户状态' })).toBeEnabled();
    expect(screen.getByText('若系统弹出安全存储授权，请按系统提示完成授权；输入的是本机系统密码，不是云端账户密码。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '验证 Stats v2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '检查云端账户状态' }));
    expect(onCheckStatus).toHaveBeenCalledOnce();
  });

  it('安全存储读取失败时提供明确重试入口', () => {
    render(
      <CloudAccountSection
        cloudConfig={{ supabase_url: 'https://project.supabase.co', supabase_key: 'publishable-key' }}
        cloudStatus={{ configured: true, authenticated: false, email: '', userId: '' }}
        statusKnown={false}
        statusChecking={false}
        statusError="系统安全存储暂时无法访问。当前授权周期内不会重复读取本机钥匙串；请确认登录钥匙串已解锁后，主动重试。"
        onCheckStatus={vi.fn()}
        authForm={{ email: '', password: '' }}
        busy={busyState(false)}
        onConfigChange={vi.fn()}
        onAuthFormChange={vi.fn()}
        onClearPassword={vi.fn()}
        onSaveConfig={vi.fn()}
        onSync={vi.fn()}
        onSignIn={vi.fn()}
        onSignUp={vi.fn()}
        onSignOut={vi.fn()}
        configError=""
        authError=""
        setup={{
          configured: true,
          authenticated: false,
          capabilityVerified: false,
          firstSyncCompleted: false,
          validating: false,
          lastError: '',
        }}
        onValidateCapability={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('系统安全存储暂时无法访问');
    const retryButton = screen.getByRole('button', { name: '重试检查云端账户状态' });
    expect(retryButton).toBeEnabled();
    expect(retryButton).toHaveAttribute('aria-describedby', 'cloud-status-gate-error');
    expect(screen.getByText(/当前授权周期内不会重复读取本机钥匙串/)).toHaveAttribute('id', 'cloud-status-gate-error');
  });
});
