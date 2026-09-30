/**
 * M3 后代收集单测。
 *
 * `collectPosixDescendantPids` 与 `parsePosixProcessTable` 的解析/限时退化
 * 直接用 fixture 断言,不依赖真实 ps;参照实现逐行对照评审记录见 M3 交付说明。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectPosixDescendantPids,
  parsePosixProcessTable,
} from '../../src/core/process-tree.js';

/** 多行/关系链 fixture:500 → 501 → 502 → 503,500 → 504,另有无关进程。 */
const CHAIN_TABLE = [
  '    1     0',
  '  500   500',
  '  501   500',
  '  502   501',
  '  503   502',
  '  504   500',
  '  310   900',
  '  910   901',
  '  2     1',
  '  101     2',
  '  102     1',
  '',
].join('\n');

void describe('collectPosixDescendantPids', () => {
  void it('parses a multi-line ps table into the full descendant chain', () => {
    const descendants = parsePosixProcessTable(CHAIN_TABLE, 500);
    assert.deepEqual(
      [...descendants].sort((a, b) => a - b),
      [501, 502, 503, 504],
    );
    // 无关进程、内核进程(pid<=1)与根自身记录均不得混入。
    for (const excluded of [1, 2, 101, 102, 310, 900, 910, 901]) {
      assert.ok(!descendants.has(excluded), `pid ${String(excluded)} must stay excluded`);
    }
  });

  void it('collects recursively through kernel-owned descendants without leaking pid 1', () => {
    const descendants = parsePosixProcessTable(CHAIN_TABLE, 1);
    assert.deepEqual(
      [...descendants].sort((a, b) => a - b),
      [2, 101, 102],
    );
  });

  void it('terminates on a parent-child cycle and never revisits a pid', () => {
    const cyclicTable = ['700 0', '701 700', '702 701', '701 702'].join('\n');
    const descendants = parsePosixProcessTable(cyclicTable, 700);
    assert.deepEqual(
      [...descendants].sort((a, b) => a - b),
      [701, 702],
    );
  });

  void it('accepts tab-separated pid pairs and ignores malformed lines', () => {
    const mixedTable = [
      '801\t700',
      '802   801',
      'junk line',
      ' 803 ',
      ' 804 805 806',
      '',
    ].join('\n');
    assert.deepEqual(
      [...parsePosixProcessTable(mixedTable, 700)].sort((a, b) => a - b),
      [801, 802],
    );
  });

  void it('returns the parsed set when the injected reader resolves', async () => {
    const descendants = await collectPosixDescendantPids(
      500,
      async () => CHAIN_TABLE,
      50,
    );
    assert.deepEqual(
      [...descendants].sort((a, b) => a - b),
      [501, 502, 503, 504],
    );
  });

  void it('degrades to an empty set when the process table hangs past the timeout', async () => {
    const descendants = await collectPosixDescendantPids(
      500,
      () => new Promise<string>(() => undefined),
      20,
    );
    assert.equal(descendants.size, 0);
  });

  void it('degrades to an empty set when reading the process table rejects', async () => {
    const descendants = await collectPosixDescendantPids(
      500,
      () => Promise.reject(new Error('ps unavailable')),
      50,
    );
    assert.equal(descendants.size, 0);
  });

  void it('returns an empty set when the root pid is absent from the table', async () => {
    const descendants = await collectPosixDescendantPids(
      4042,
      async () => CHAIN_TABLE,
      50,
    );
    assert.equal(descendants.size, 0);
  });
});