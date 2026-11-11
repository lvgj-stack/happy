import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { startDaemonControlServer } from './controlServer';

describe('daemon controlServer /spawn-session', () => {
  it('accepts agent="cursor" and forwards it to spawnSession', async () => {
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'cursor-happy-session-1',
    }));

    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => false,
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
    });

    try {
      const response = await axios.post(`http://127.0.0.1:${server.port}/spawn-session`, {
        directory: '/tmp/project',
        agent: 'cursor',
        permissionMode: 'plan',
        modelMode: 'default',
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({
        success: true,
        sessionId: 'cursor-happy-session-1',
        approvedNewDirectoryCreation: true,
      });
      expect(spawnSession).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: '/tmp/project',
          agent: 'cursor',
        }),
      );
    } finally {
      await server.stop();
    }
  });
});
