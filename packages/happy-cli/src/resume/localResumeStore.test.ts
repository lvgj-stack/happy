import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockReadPersistedSessions: vi.fn(),
    mockReadCredentials: vi.fn(),
    mockAxiosGet: vi.fn(),
}));

vi.mock('axios', async (importOriginal) => {
    const actual = await importOriginal<typeof import('axios')>();
    return {
        ...actual,
        default: {
            ...actual.default,
            get: mocks.mockAxiosGet,
        },
    };
});

vi.mock('@/persistence', () => ({
    readPersistedSessions: mocks.mockReadPersistedSessions,
    readCredentials: mocks.mockReadCredentials,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        sessionsFile: '/tmp/.happy/sessions.json',
        serverUrl: 'https://api.example.test',
        currentCliVersion: '1.1.10',
    },
}));

import { LocalResumeSessionError, resolveLocalReconnectableSession } from './localResumeStore';

describe('resolveLocalReconnectableSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockReadCredentials.mockResolvedValue(null);
    });

    it('resolves a locally persisted dataKey session without agent.key credentials', async () => {
        mocks.mockReadPersistedSessions.mockReturnValue({
            'session-1': {
                encryptionKey: 'AQIDBA==',
                encryptionVariant: 'dataKey',
                seq: 12,
                metadataVersion: 3,
                agentStateVersion: 4,
                metadata: {
                    path: '/tmp/repo',
                    flavor: 'codex',
                    codexThreadId: 'thread-1',
                    host: 'localhost',
                    homeDir: '/tmp',
                    happyHomeDir: '/tmp/.happy',
                    happyLibDir: '/tmp/happy',
                    happyToolsDir: '/tmp/happy/tools',
                },
                savedAt: Date.now(),
            },
        });

        await expect(resolveLocalReconnectableSession('session-1')).resolves.toMatchObject({
            id: 'session-1',
            seq: 12,
            metadataVersion: 3,
            agentStateVersion: 4,
            encryptionVariant: 'dataKey',
            metadata: {
                codexThreadId: 'thread-1',
            },
        });
    });

    it('reports missing local encryption data without suggesting happy-agent auth login', async () => {
        mocks.mockReadPersistedSessions.mockReturnValue({});

        let thrown: unknown;
        try {
            await resolveLocalReconnectableSession('missing');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(LocalResumeSessionError);
        expect((thrown as Error).message).toContain('/tmp/.happy/sessions.json');
        expect((thrown as Error).message).not.toContain('happy-agent auth login');
    });

    it('fetches fresh server metadata for cursor sessions when persisted metadata lacks cursorSessionId', async () => {
        const { encodeBase64, encrypt } = await import('@/api/encryption');
        const key = new Uint8Array(32).fill(5);
        mocks.mockReadCredentials.mockResolvedValue({ token: 'tok' });
        mocks.mockReadPersistedSessions.mockReturnValue({
            'cursor-sess-1': {
                encryptionKey: encodeBase64(key),
                encryptionVariant: 'dataKey',
                seq: 3,
                metadataVersion: 1,
                agentStateVersion: 1,
                metadata: {
                    path: '/tmp/cursor-repo',
                    flavor: 'cursor',
                    host: 'localhost',
                    homeDir: '/tmp',
                    happyHomeDir: '/tmp/.happy',
                    happyLibDir: '/tmp/happy',
                    happyToolsDir: '/tmp/happy/tools',
                },
                savedAt: Date.now(),
            },
        });
        mocks.mockAxiosGet.mockResolvedValue({
            data: {
                sessions: [
                    {
                        id: 'cursor-sess-1',
                        metadata: encodeBase64(encrypt(key, 'dataKey', {
                            path: '/tmp/cursor-repo',
                            flavor: 'cursor',
                            cursorSessionId: 'cursor-remote-id-77',
                            host: 'localhost',
                            homeDir: '/tmp',
                            happyHomeDir: '/tmp/.happy',
                            happyLibDir: '/tmp/happy',
                            happyToolsDir: '/tmp/happy/tools',
                        })),
                    },
                ],
            },
        });

        const resolved = await resolveLocalReconnectableSession('cursor-sess-1');
        expect(mocks.mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(resolved.metadata.cursorSessionId).toBe('cursor-remote-id-77');
    });
});
