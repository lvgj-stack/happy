import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findAgyBin } from '@/agy/constants';
import { findCursorBin } from '@/cursor/constants';
import { detectCLIAvailability } from './detectCLI';

vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/person'),
    platform: vi.fn(() => 'darwin'),
  },
}));
vi.mock('@/agy/constants', () => ({ findAgyBin: vi.fn() }));
vi.mock('@/cursor/constants', () => ({ findCursorBin: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedFindAgyBin = vi.mocked(findAgyBin);
const mockedFindCursorBin = vi.mocked(findCursorBin);
const mockedPlatform = vi.mocked(os.platform);

describe('CLI availability detection', () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => {
      throw new Error('not installed');
    });
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
    mockedFindAgyBin.mockReset();
    mockedFindAgyBin.mockReturnValue(undefined);
    mockedFindCursorBin.mockReset();
    mockedFindCursorBin.mockReturnValue(undefined);
    mockedPlatform.mockReturnValue('darwin');
  });

  it('reports Antigravity only when its executable resolver finds an installation', () => {
    expect(detectCLIAvailability().agy).toBe(false);

    mockedFindAgyBin.mockReturnValue('/home/person/.local/bin/agy');

    expect(detectCLIAvailability().agy).toBe(true);
  });

  it('reports Cursor on both POSIX and Windows via findCursorBin', () => {
    expect(detectCLIAvailability().cursor).toBe(false);

    mockedFindCursorBin.mockReturnValue('/home/person/.local/bin/cursor-agent');
    expect(detectCLIAvailability().cursor).toBe(true);

    mockedPlatform.mockReturnValue('win32');
    expect(detectCLIAvailability().cursor).toBe(true);

    mockedFindCursorBin.mockReturnValue(undefined);
    expect(detectCLIAvailability().cursor).toBe(false);
  });
});