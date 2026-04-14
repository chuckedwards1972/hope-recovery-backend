import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { verifyAccessToken } from './jwt';

interface WSClient {
  ws: WebSocket;
  userId: string;
  campusId: string;
  role: string;
}

const clients = new Map<string, WSClient>();

export type WSEventType =
  | 'TESTIMONY_NEW'
  | 'ATTENDANCE_UPDATE'
  | 'ALERT_TRIGGERED'
  | 'CAMPUS_BROADCAST'
  | 'PING';

export interface WSMessage {
  type: WSEventType;
  campusId?: string;
  payload: unknown;
}

export function initWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Extract token from query string: ?token=xxx
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      const clientId = payload.userId;

      clients.set(clientId, {
        ws,
        userId: payload.userId,
        campusId: payload.campusId,
        role: payload.role,
      });

      ws.send(JSON.stringify({ type: 'PING', payload: { connected: true } }));

      ws.on('message', (data) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          handleMessage(clientId, msg);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        clients.delete(clientId);
      });
    } catch {
      ws.close(1008, 'Invalid token');
    }
  });

  console.log('🔌 WebSocket server initialized at /ws');
}

function handleMessage(clientId: string, msg: WSMessage) {
  const client = clients.get(clientId);
  if (!client) return;

  if (msg.type === 'PING') {
    client.ws.send(JSON.stringify({ type: 'PING', payload: { pong: true } }));
  }
}

// Broadcast to all clients in a specific campus
export function broadcastToCampus(campusId: string, message: WSMessage) {
  for (const client of clients.values()) {
    if (client.campusId === campusId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}

// Broadcast to HQ Admins
export function broadcastToHQ(message: WSMessage) {
  for (const client of clients.values()) {
    if (client.role === 'HQ_ADMIN' && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}

// Broadcast to a specific user
export function broadcastToUser(userId: string, message: WSMessage) {
  const client = clients.get(userId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message));
  }
}
