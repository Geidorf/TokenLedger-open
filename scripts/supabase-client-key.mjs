function decodeCanonicalBase64UrlJson(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null;
  }
  try {
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.toString('base64url') !== segment) {
      return null;
    }
    const value = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function classifySupabaseClientKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return 'rejected';
  }
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) {
    return 'publishable';
  }

  const parts = value.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return 'rejected';
  }
  const header = decodeCanonicalBase64UrlJson(parts[0]);
  const payload = decodeCanonicalBase64UrlJson(parts[1]);
  if (header?.alg === 'HS256' && payload?.role === 'anon') {
    return 'legacy-anon';
  }
  return 'rejected';
}

export function isAllowedSupabaseClientKey(value) {
  return classifySupabaseClientKey(value) !== 'rejected';
}

export function assertAllowedSupabaseClientKey(value, label = 'Supabase client key') {
  const kind = classifySupabaseClientKey(value);
  if (kind === 'rejected') {
    throw new Error(
      `${label} must be an sb_publishable_* key or a decodable legacy JWT with payload role=anon`,
    );
  }
  return kind;
}
