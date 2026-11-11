import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CURSOR_BIN,
  findCursorBin,
  isLikelyCursorAuthError,
  resolveCursorBin,
} from './constants';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

describe('findCursorBin / resolveCursorBin', () => {
  const orig = process.env.HAPPY_CURSOR_PATH;

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
    mockedExecSync.mockReturnValue(Buffer.alloc(0));
  });

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.HAPPY_CURSOR_PATH;
    } else {
      process.env.HAPPY_CURSOR_PATH = orig;
    }
  });

  it('uses HAPPY_CURSOR_PATH when it points at an existing file', () => {
    process.env.HAPPY_CURSOR_PATH = '/custom/bin/cursor-agent';
    mockedExistsSync.mockImplementation((path) => path === '/custom/bin/cursor-agent');

    expect(findCursorBin()).toBe('/custom/bin/cursor-agent');
    expect(resolveCursorBin()).toBe('/custom/bin/cursor-agent');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('ignores HAPPY_CURSOR_PATH when the target does not exist', () => {
    process.env.HAPPY_CURSOR_PATH = '/nonexistent/path/to/cursor-agent';
    mockedExistsSync.mockReturnValue(false);

    expect(findCursorBin()).toBe(CURSOR_BIN);
    expect(resolveCursorBin()).toBe(CURSOR_BIN);
  });

  it('probes only cursor-agent on PATH with windowsHide enabled', () => {
    delete process.env.HAPPY_CURSOR_PATH;

    expect(findCursorBin()).toBe('cursor-agent');
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringMatching(/^(where|command -v) cursor-agent$/),
      { stdio: 'ignore', windowsHide: true },
    );
  });

  it('falls back to ~/.local/bin/cursor-agent when not on PATH', () => {
    delete process.env.HAPPY_CURSOR_PATH;
    mockedExecSync.mockImplementation(() => {
      throw new Error('not on PATH');
    });
    const expectedFallback = join(os.homedir(), '.local', 'bin', 'cursor-agent');
    mockedExistsSync.mockImplementation((path) => path === expectedFallback);

    expect(findCursorBin()).toBe(expectedFallback);
    expect(resolveCursorBin()).toBe(expectedFallback);
  });

  it('returns undefined from findCursorBin when cursor-agent is nowhere to be found', () => {
    delete process.env.HAPPY_CURSOR_PATH;
    mockedExecSync.mockImplementation(() => {
      throw new Error('not on PATH');
    });
    mockedExistsSync.mockReturnValue(false);

    expect(findCursorBin()).toBeUndefined();
    expect(resolveCursorBin()).toBe('cursor-agent');
  });
});

describe('isLikelyCursorAuthError', () => {
  it('matches common Cursor ACP authentication error strings without matching generic -32000 errors', () => {
    expect(isLikelyCursorAuthError('Authentication required (cursor_login)')).toBe(true);
    expect(isLikelyCursorAuthError('Exit code: 1: Not logged in. Please run cursor-agent login')).toBe(true);
    expect(isLikelyCursorAuthError('{"code":-32000,"message":"Auth required"}')).toBe(true);
    expect(isLikelyCursorAuthError('{"code":-32000,"message":"Rate limit exceeded"}')).toBe(false);
    expect(isLikelyCursorAuthError('spawn cursor-agent ENOENT')).toBe(false);
    expect(isLikelyCursorAuthError(undefined)).toBe(false);
  });
});
