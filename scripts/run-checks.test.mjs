import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSupabaseContainer } from './run-checks.mjs';

test('SQL门禁只在唯一数据库时自动选择，没有候选保持跳过语义', () => {
  assert.equal(selectSupabaseContainer(['other-database', '']), null);
  assert.equal(selectSupabaseContainer(['other-database', 'supabase_db_test']), 'supabase_db_test');
});

test('多个数据库必须显式选择，列表顺序不能改变结果', () => {
  const names = ['supabase_db_user', 'supabase_db_isolated'];
  assert.throws(() => selectSupabaseContainer(names), /多个 Supabase/);
  assert.throws(() => selectSupabaseContainer([...names].reverse()), /多个 Supabase/);
  assert.equal(selectSupabaseContainer(names, 'supabase_db_isolated'), 'supabase_db_isolated');
  assert.equal(selectSupabaseContainer([...names].reverse(), 'supabase_db_isolated'), 'supabase_db_isolated');
});

test('指定库缺失或名称不是Supabase库时不得回退到其他数据库', () => {
  assert.throws(() => selectSupabaseContainer(['supabase_db_user'], 'supabase_db_absent'), /未运行/);
  assert.throws(() => selectSupabaseContainer([], 'supabase_db_isolated'), /未运行/);
  assert.throws(() => selectSupabaseContainer(['other-database'], 'other-database'), /未运行/);
});
